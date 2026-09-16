// Every knob in one place, so "what does this box do differently" is a single file to read.
// All values come from the environment; the defaults are the ones a dev box wants.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const int = (v, d) => (v == null || v === "" ? d : parseInt(v, 10) || d);
const bool = (v, d = false) => (v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  root: ROOT,
  webDir: process.env.WEB_DIR || path.join(ROOT, "web"),
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),

  host: process.env.HOST || "127.0.0.1",
  port: int(process.env.PORT, 8799),

  // Scraping identity. Rules can override per-site.
  userAgent:
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

  // How long a scraped listing/detail stays warm. Scraping is the slow part of every
  // request and upstreams dislike being hammered, so a short TTL buys a lot on both sides.
  cache: {
    listTtlMs: int(process.env.CACHE_LIST_TTL_MS, 90_000),
    detailTtlMs: int(process.env.CACHE_DETAIL_TTL_MS, 300_000),
    resolveTtlMs: int(process.env.CACHE_RESOLVE_TTL_MS, 120_000), // playable URLs are often signed/expiring
    max: int(process.env.CACHE_MAX, 600),
    enabled: bool(process.env.CACHE, true),
  },

  // Per-IP fixed windows. The media proxy needs a far bigger budget than the JSON API
  // because one HLS stream fans out into hundreds of segment requests.
  rateLimit: {
    api: { windowMs: 60_000, max: int(process.env.RL_API, 600) },
    media: { windowMs: 60_000, max: int(process.env.RL_MEDIA, 3000) },
  },

  upstream: {
    timeoutMs: int(process.env.UPSTREAM_TIMEOUT_MS, 20_000),
    retries: int(process.env.UPSTREAM_RETRIES, 2),
    maxRedirects: int(process.env.UPSTREAM_MAX_REDIRECTS, 5),
    // Default ceiling on parallel upstream media connections per (site, host).
    // Rules may lower it further with `streamConcurrency`.
    streamConcurrency: int(process.env.STREAM_CONCURRENCY, 8),
  },

  // Disk cache for gallery page images, keyed by page id — see media/pagecache.js.
  // This is a QUOTA cache, not a bandwidth cache: on exhentai every page you resolve
  // spends one of the account's image limits and an original spends several, so a
  // re-read that never touches upstream is the difference between reading a gallery
  // twice and being locked out for the rest of the day.
  pageCache: {
    enabled: bool(process.env.IMG_CACHE, true),
    dir: process.env.IMG_CACHE_DIR || path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "cache", "pages"),
    maxBytes: Math.round(parseFloat(process.env.IMG_CACHE_MAX_GB || "30") * 1e9) || 30e9,
    // Bigger than any single manga page has any business being.
    maxImageBytes: int(process.env.IMG_CACHE_MAX_IMAGE_MB, 40) * 1024 * 1024,
  },

  // TLS-impersonation sidecar (curl_cffi) for Cloudflare-walled APIs — see sidecar/.
  sidecarUrl: process.env.TLS_SIDECAR || "http://127.0.0.1:8798",

  // Optional outbound HTTP-CONNECT proxy for geo-blocked media CDNs, scoped by host suffix.
  //   STREAM_PROXY=http://127.0.0.1:3093  STREAM_PROXY_HOSTS=iwara.tv
  streamProxy: process.env.STREAM_PROXY || "",
  streamProxyHosts: list(process.env.STREAM_PROXY_HOSTS).map((h) => h.toLowerCase()),

  // Dev-only escape hatch: allows fetching 127.0.0.1 so the mock catalog can be
  // scraped end-to-end. NEVER set this in production — it disables the SSRF guard.
  allowLocalHosts: bool(process.env.ALLOW_LOCAL_HOSTS, false),

  logLevel: process.env.LOG_LEVEL || "info",
};

export default config;
