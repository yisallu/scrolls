// /api/stream — the same-origin media proxy.
//
// Why it exists, in one sentence: because the bytes arrive from *our* origin, the
// <video> element is not CORS-tainted, and ShadowPlay's Web Audio analyser can read
// the waveform — which is the entire product. Everything else it does (Range/206 so
// seeking works, Referer/UA injection to defeat hot-link protection, rewriting HLS
// playlists so segments come back through here too) exists to keep that true.

import { URL } from "node:url";
import { pipeline } from "node:stream/promises";
import config from "../config.js";
import { httpErr } from "../lib/errors.js";
import { assertHostAllowed } from "../lib/net.js";
import { openUpstream, buildHeaders, readAll, ruleHeader } from "../lib/fetcher.js";
import { proxiedMediaUrl } from "./url.js";
import { logger } from "../lib/log.js";

const log = logger("stream");

// ---- per-host concurrency ----------------------------------------------------
// Some media hosts silently stall a burst from one IP rather than answering 429.
// Queueing at our edge keeps a full grid of thumbnails (or an HLS fan-out) from
// tripping that, at the cost of a little latency on the tail requests.

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    return new Promise((resolve) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < this.limit) grant();
      else this.queue.push(grant);
    });
  }
  get idle() {
    return this.active === 0 && this.queue.length === 0;
  }
}

const semaphores = new Map();

function slotFor(key, limit) {
  let s = semaphores.get(key);
  if (!s || s.limit !== limit) {
    s = new Semaphore(limit);
    semaphores.set(key, s);
  }
  return s.acquire();
}

setInterval(() => {
  for (const [k, s] of semaphores) if (s.idle) semaphores.delete(k);
}, 60_000).unref();

// ---- HLS ---------------------------------------------------------------------

/** Rewrite every URI in a playlist to come back through us, so segments stay same-origin. */
export function rewriteM3u8(body, baseUrl, site) {
  const toAbs = (uri) => {
    try {
      return new URL(uri, baseUrl).toString();
    } catch {
      return uri;
    }
  };
  const wrap = (uri) => proxiedMediaUrl(site, toAbs(uri));
  return body
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA carry their target in URI="..."
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${wrap(uri)}"`);
      return wrap(t); // a variant playlist or a media segment
    })
    .join("\n");
}

function fillTemplate(template, match) {
  return String(template || "").replace(/\{(\d+)\}/g, (_m, n) => match[Number(n)] || "");
}

function cookieHeaderFromSetCookie(setCookie, names) {
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const allowed = Array.isArray(names) && names.length ? new Set(names) : null;
  const pairs = [];
  for (const line of lines) {
    const pair = String(line).split(";")[0].trim();
    if (pair && (!allowed || allowed.has(pair.split("=")[0]))) pairs.push(pair);
  }
  return pairs.join("; ");
}

/**
 * Some sites gate their HLS key endpoint behind a cookie that an "init" call hands out.
 * When the rule declares `hlsAuth` and the request is for a key path, do that handshake
 * first and forward the resulting cookie.
 */
async function hlsAuthHeaders(rule, target) {
  const auth = rule && rule.hlsAuth;
  if (!auth || !auth.keyPathRegex || !auth.initPath) return null;
  const u = assertHostAllowed(rule, target);
  let keyMatch;
  try {
    keyMatch = new RegExp(auth.keyPathRegex).exec(u.pathname);
  } catch {
    return null;
  }
  if (!keyMatch) return null;

  const initUrl = new URL(fillTemplate(auth.initPath, keyMatch), u).toString();
  const { res } = await openUpstream(rule, initUrl, { headers: buildHeaders(rule) });
  await readAll(res, 64 * 1024);
  if ((res.statusCode || 0) >= 400) return null;
  const cookie = cookieHeaderFromSetCookie(res.headers["set-cookie"], auth.cookieNames);
  return cookie ? { Cookie: cookie } : null;
}

// ---- the handler --------------------------------------------------------------

const PASS_HEADERS = {
  "content-type": "Content-Type",
  "content-length": "Content-Length",
  "content-range": "Content-Range",
  "accept-ranges": "Accept-Ranges",
  "last-modified": "Last-Modified",
  etag: "ETag",
};

/**
 * Caching policy. v1 sent no-store for everything, which meant scrolling a grid back
 * up re-downloaded every thumbnail through the proxy — the single biggest source of
 * "why is this slow". Images and media bodies are immutable once fetched, so they get
 * a private (browser-only, never a shared cache) TTL; playlists stay uncached because
 * live streams rewrite them.
 */
function cacheControlFor(contentType, isPlaylist) {
  if (isPlaylist) return "no-store";
  if (/^image\//i.test(contentType)) return "private, max-age=3600";
  if (/^(video|audio)\//i.test(contentType)) return "private, max-age=600";
  return "no-store";
}

export function createStreamHandler(rules) {
  return async function stream(ctx) {
    const { req, res } = ctx;
    const raw = ctx.q("u");
    const site = ctx.q("site");
    if (!raw) throw httpErr(400, "缺少 u 参数", "bad_request");
    const rule = rules.require(site);

    const target = raw; // URLSearchParams already decoded it once
    const targetUrl = assertHostAllowed(rule, target);
    const isM3u8ByExt = /\.m3u8(\?|$)/i.test(targetUrl.pathname + targetUrl.search);

    const limit = Math.min(Math.max(1, Math.floor(Number(rule.streamConcurrency) || config.upstream.streamConcurrency)), 64);
    const release = await slotFor(`${site}:${targetUrl.hostname.toLowerCase()}`, limit);
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      release();
    };

    try {
      const extra = await hlsAuthHeaders(rule, target).catch(() => null);
      const headers = buildHeaders(rule, { ...(extra || {}), Range: req.headers.range }, { accept: "*/*" });
      const { res: upstream, finalUrl } = await openUpstream(rule, target, { method: req.method === "HEAD" ? "HEAD" : "GET", headers });

      const contentType = String(upstream.headers["content-type"] || "");
      const isPlaylist = isM3u8ByExt || /mpegurl/i.test(contentType);

      if (isPlaylist) {
        const body = (await readAll(upstream, 8 * 1024 * 1024)).toString("utf8");
        done();
        if (res.writableEnded) return;
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(req.method === "HEAD" ? undefined : rewriteM3u8(body, finalUrl, site));
        return;
      }

      // Binary passthrough, preserving range semantics so the browser can seek.
      const out = {
        "Cache-Control": cacheControlFor(contentType, false),
        "Access-Control-Allow-Origin": "*",
        // Third-party media should never be sniffed into something scriptable.
        "X-Content-Type-Options": "nosniff",
      };
      for (const [k, v] of Object.entries(PASS_HEADERS)) if (upstream.headers[k] != null) out[v] = upstream.headers[k];
      if (upstream.headers["accept-ranges"] == null) out["Accept-Ranges"] = "bytes";
      res.writeHead(upstream.statusCode || 200, out);

      if (req.method === "HEAD") {
        upstream.destroy();
        done();
        res.end();
        return;
      }

      // pipeline() (not .pipe()) so that a client hanging up mid-stream tears the
      // upstream socket down with it. A bare .pipe() leaves the upstream flowing into
      // an ended response — "write after end", which is an *unhandled* error event on
      // ServerResponse and takes the whole process with it.
      await pipeline(upstream, res).catch((e) => {
        if (!/premature close|aborted|ECONNRESET|ERR_STREAM/i.test(String(e && e.message))) {
          log.debug("stream ended early:", e.message);
        }
        try { upstream.destroy(); } catch {}
      });
      done();
    } catch (e) {
      done();
      throw e;
    }
  };
}

export { ruleHeader };
