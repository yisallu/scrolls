// /api/page — one page of a gallery, by its stable id, served through the disk cache.
//
// The reader used to go /api/image (resolve) → /api/stream (download) for every page.
// Both halves cost exhentai image quota, and the H@H link in between carries a rotating
// keystamp, so nothing was cacheable. This endpoint collapses the two into one
// id-addressed request that a cache hit answers entirely from disk — no resolve, no
// download, no quota. Re-reading a gallery is free.
//
// Variants pick WHICH file: "" is the 1280px sample, "original" the full-resolution
// file (several times the quota), and "w2x" the waifu2x upscale produced by the GPU
// worker in media/w2x.js. All three share this cache, so each is paid for once ever.

import fsp from "node:fs/promises";
import config from "../config.js";
import { httpErr } from "../lib/errors.js";
import { assertHostAllowed } from "../lib/net.js";
import { openUpstream, buildHeaders, readAll } from "../lib/fetcher.js";
import { unproxy } from "./url.js";
import { logger } from "../lib/log.js";

const log = logger("page");

/**
 * E-Hentai does not fail loudly when the image limit runs out: it hands back a small
 * "bandwidth exceeded" GIF with a perfectly good 200. Caching that would poison the
 * page forever, so it is checked before anything is written.
 */
function quotaExhausted(status, url, contentType, size) {
  if (status === 509) return true;
  if (/\b509\.gif\b/i.test(String(url || ""))) return true;
  // The placeholder is a tiny GIF; real manga pages are never a 2 KB gif.
  if (/image\/gif/i.test(String(contentType || "")) && size > 0 && size < 4096) return true;
  return false;
}

/**
 * Cache-first access to one page's bytes. Shared by the HTTP handler and by the w2x
 * worker path, which needs the sample to hand to the GPU.
 */
export function createPageLoader(engine, cache) {
  // Requests that arrive while the same page is already being fetched wait for it
  // instead of spending the quota twice. The reader prefetches several pages while you
  // read the current one, so this collides in normal use, not just under load.
  const inflight = new Map();

  async function fetchAndStore(rule, site, id, variant) {
    const resolved = await engine.resolveImage(rule, id, { variant });
    const raw = resolved.raw || unproxy(resolved.url);
    if (!raw) throw httpErr(422, "没有解析出图片地址", "unresolvable");

    if (quotaExhausted(200, raw, "", 0)) {
      throw httpErr(429, "E-Hentai 图片配额已用尽(509)", "quota_exceeded");
    }

    assertHostAllowed(rule, raw); // same SSRF/allowlist guard the media proxy uses
    const headers = buildHeaders(rule, {}, { accept: "image/*,*/*" });
    const { res: upstream, finalUrl } = await openUpstream(rule, raw, { headers });
    const status = upstream.statusCode || 0;
    const contentType = String(upstream.headers["content-type"] || "");

    if (status >= 400) {
      upstream.resume();
      if (status === 509) throw httpErr(429, "E-Hentai 图片配额已用尽(509)", "quota_exceeded");
      throw httpErr(502, `上游返回 ${status}`, "upstream_error");
    }

    const buf = await readAll(upstream, config.pageCache.maxImageBytes);
    if (quotaExhausted(status, finalUrl, contentType, buf.length)) {
      throw httpErr(429, "E-Hentai 图片配额已用尽(509)", "quota_exceeded");
    }
    if (!/^image\//i.test(contentType)) {
      throw httpErr(502, `上游返回的不是图片(${contentType || "未知类型"})`, "upstream_error");
    }

    await cache.put(site, id, variant, buf, contentType);
    return { buf, contentType };
  }

  /** @returns {Promise<{buf: Buffer, contentType: string, cached: boolean}>} */
  async function load(rule, site, id, variant, { fetcher = null } = {}) {
    const hit = await cache.find(site, id, variant);
    if (hit) return { file: hit.file, contentType: hit.contentType, size: hit.size, cached: true };

    const key = `${site} ${id} ${variant}`;
    let job = inflight.get(key);
    if (!job) {
      // `fetcher` lets a caller (w2x) supply its own way of producing the bytes while
      // still getting the cache and the request coalescing for free.
      const run = fetcher ? fetcher() : fetchAndStore(rule, site, id, variant);
      job = Promise.resolve(run).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    const { buf, contentType } = await job;
    return { buf, contentType, cached: false };
  }

  return { load };
}

const W2X_MODELS = new Set(["models-cunet", "models-upconv_7_anime_style_art_rgb", "models-upconv_7_photo"]);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * The waifu2x settings are part of the cache identity: the same page at noise=1 and
 * noise=3 are different pictures, and keying them both as "w2x" would serve whichever
 * was produced first forever.
 */
function w2xVariant(ctx) {
  const model = W2X_MODELS.has(ctx.q("model")) ? ctx.q("model") : "models-cunet";
  const noise = clamp(ctx.int("noise", 1), -1, 3);
  const scale = clamp(ctx.int("scale", 2), 1, 4);
  return { key: `w2x-${model.replace("models-", "")}-n${noise}-s${scale}`, opts: { model, noise, scale } };
}

export function createPageHandler(rules, engine, cache, loader, broker = null) {
  return async function pageImage(ctx) {
    const { req, res } = ctx;
    const site = ctx.q("site");
    const id = ctx.q("id");
    const v = ctx.q("v");
    if (!id) throw httpErr(400, "缺少 id", "bad_request");
    const rule = rules.require(site);

    let variant = v === "original" ? "original" : "";
    let opts = {};
    if (v === "w2x") {
      if (!broker) throw httpErr(503, "waifu2x 未启用", "worker_offline");
      ({ key: variant, opts } = w2xVariant(ctx));
    }

    const got = await loader.load(rule, site, id, variant, {
      fetcher:
        v === "w2x"
          ? async () => {
              // Upscale the SAMPLE, not the original: the sample is what costs no extra
              // quota, and recovering its detail is the whole point of doing this.
              const src = await loader.load(rule, site, id, "");
              const buf = src.cached ? await fsp.readFile(src.file) : src.buf;
              const out = await broker.submit(buf, opts);
              await cache.put(site, id, variant, out.buf, out.contentType);
              return out;
            }
          : null,
    });
    if (got.cached) {
      return cache.send(res, { file: got.file, contentType: got.contentType, size: got.size }, { method: req.method });
    }

    if (res.writableEnded) return;
    res.writeHead(200, {
      "Content-Type": got.contentType,
      "Content-Length": String(got.buf.length),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "X-Cache": "MISS",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(req.method === "HEAD" ? undefined : got.buf);
    log.debug(`miss ${site} ${id} ${variant || "sample"} ${(got.buf.length / 1024) | 0}KB`);
  };
}

export default createPageHandler;
