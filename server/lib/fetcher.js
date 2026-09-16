// The one outbound HTTP client. Everything upstream — page scrapes, JSON APIs and
// the media proxy — goes through openUpstream(), so redirects, timeouts, the host
// allowlist and the geo-proxy behave identically no matter who asks.
//
// It is built on node:http rather than fetch() on purpose: fetch() gives no way to
// install a DNS hook (see lib/net.js safeLookup), and the media proxy needs the raw
// response stream with its Range/206 headers intact anyway.

import zlib from "node:zlib";
import { URL } from "node:url";
import iconv from "iconv-lite";
import config from "../config.js";
import { httpErr } from "./errors.js";
import { assertHostAllowed, agentFor, clientFor } from "./net.js";

/** Case-insensitive lookup into a rule's `headers` map. */
export function ruleHeader(rule, name) {
  const h = (rule && rule.headers) || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
}

/**
 * Headers for an upstream request: our UA, the rule's site-specific identity
 * (Referer/Cookie/Origin/Authorization defeat hot-link protection and token gates),
 * then anything the caller adds last.
 */
export function buildHeaders(rule, extra = {}, { accept, acceptEncoding } = {}) {
  const h = {
    "User-Agent": ruleHeader(rule, "User-Agent") || config.userAgent,
    Accept: accept || "*/*",
    "Accept-Encoding": acceptEncoding || "identity",
  };
  for (const name of ["Referer", "Cookie", "Origin", "Authorization"]) {
    const v = ruleHeader(rule, name);
    if (v) h[name] = v;
  }
  // Any other rule header the site needs (api-version, platform, x-*, …).
  for (const [k, v] of Object.entries((rule && rule.headers) || {})) {
    if (!/^(user-agent|referer|cookie|origin|authorization)$/i.test(k) && v != null) h[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v != null) h[k] = v;
  return h;
}

/**
 * Open an upstream response stream, following redirects manually so the allowlist is
 * re-checked on every hop (an open redirect on an allowed host must not become a way
 * out of the allowlist).
 *
 * @returns {Promise<{res: import("node:http").IncomingMessage, finalUrl: string}>}
 */
export function openUpstream(rule, urlStr, opts = {}) {
  const { headers = {}, method = "GET", body = null, depth = 0, timeoutMs = config.upstream.timeoutMs } = opts;
  if (depth > config.upstream.maxRedirects) return Promise.reject(httpErr(508, "too many redirects"));
  const u = assertHostAllowed(rule, urlStr);
  const reqHeaders = { ...headers, Host: u.host };
  if (body != null) reqHeaders["Content-Length"] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const req = clientFor(u).request(u, { method, headers: reqHeaders, agent: agentFor(u) }, (res) => {
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume(); // drain so the socket can be reused
        let next;
        try {
          next = new URL(res.headers.location, u).toString();
        } catch {
          return reject(httpErr(502, "bad redirect target"));
        }
        // 302/303 after a POST becomes a GET without the body — what every browser
        // does, and what E-Hentai's "now go look at the gallery" redirect expects.
        const drop = sc === 302 || sc === 303;
        return openUpstream(rule, next, {
          ...opts,
          depth: depth + 1,
          method: drop ? "GET" : method,
          body: drop ? null : body,
        }).then(resolve, reject);
      }
      resolve({ res, finalUrl: u.toString() });
    });
    req.on("error", (e) => reject(e.status ? e : httpErr(502, "upstream error: " + e.message)));
    req.setTimeout(timeoutMs, () => req.destroy(httpErr(504, "upstream timeout")));
    req.end(body == null ? undefined : body);
  });
}

/** Read a whole response into a Buffer, transparently decompressing, with a hard size cap. */
export function readAll(res, maxBytes = 8 * 1024 * 1024) {
  const enc = String(res.headers["content-encoding"] || "").toLowerCase();
  let stream = res;
  if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
  else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
  else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        res.destroy();
        reject(httpErr(502, "upstream response too large"));
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (e) => reject(httpErr(502, "upstream read failed: " + e.message)));
  });
}

// ---- text (HTML) -------------------------------------------------------------

function detectCharset(contentType, buf) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || "");
  if (m) return m[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString("latin1");
  const m2 = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (m2) return m2[1].toLowerCase();
  const m3 = /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
  if (m3) return m3[1].toLowerCase();
  return null;
}

export function decodeBody(buf, contentType, forcedCharset) {
  let cs = (forcedCharset || detectCharset(contentType, buf) || "utf-8").toLowerCase();
  if (cs === "utf8") cs = "utf-8";
  if (cs === "utf-8") return buf.toString("utf8");
  return iconv.encodingExists(cs) ? iconv.decode(buf, cs) : buf.toString("utf8");
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a URL and return decoded text. Retries transient failures with backoff — remote
 * sites hiccup constantly and a single 502 should not surface as a broken grid.
 */
export async function fetchText(rule, urlStr, opts = {}) {
  const { accept = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", headers = {}, maxBytes } = opts;
  // headersMode "public" sends only the generic UA — some endpoints (Sankaku's public
  // post API) reject the very session cookie the rest of the rule needs.
  const identity = opts.headersMode === "public" ? null : rule;
  let lastErr;
  for (let attempt = 0; attempt <= config.upstream.retries; attempt++) {
    if (attempt) await sleep(300 * attempt * attempt); // 0ms, 300ms, 1200ms
    try {
      const { res, finalUrl } = await openUpstream(rule, urlStr, {
        headers: buildHeaders(identity, headers, { accept, acceptEncoding: "gzip, deflate, br" }),
      });
      const status = res.statusCode || 0;
      if (RETRYABLE.has(status) && attempt < config.upstream.retries) {
        res.resume();
        lastErr = httpErr(status === 429 ? 429 : 502, `upstream returned HTTP ${status}`);
        continue;
      }
      const buf = await readAll(res, maxBytes);
      const contentType = res.headers["content-type"] || "";
      return { text: decodeBody(buf, contentType, rule && rule.charset), url: finalUrl, status, contentType };
    } catch (e) {
      lastErr = e;
      const transient = !e.status || e.status === 502 || e.status === 504;
      if (!transient || attempt === config.upstream.retries) throw e;
    }
  }
  throw lastErr;
}

/** GET a JSON API. A non-JSON body almost always means an expired token or a bot wall. */
export async function fetchJson(rule, urlStr, opts = {}) {
  const { text, status, contentType } = await fetchText(rule, urlStr, {
    accept: "application/json,*/*;q=0.8",
    headers: opts.headers,
    headersMode: opts.headersMode,
  });
  try {
    return { json: JSON.parse(text), status };
  } catch {
    const hint = /text\/html/i.test(contentType) ? " — the site answered with HTML (token expired or bot wall?)" : "";
    throw httpErr(status === 200 ? 502 : status, `API returned non-JSON (HTTP ${status})${hint}`);
  }
}
