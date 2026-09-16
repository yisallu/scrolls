// Static file serving for the web app, with the two things that actually matter:
// a path-traversal guard, and revalidation caching (ETag) so a redeploy is picked up
// immediately while repeat loads still cost one 304.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const etagOf = (st) => `W/"${st.size.toString(16)}-${st.mtimeMs.toString(36)}"`;

export function createStaticHandler(rootDir, { spaFallback = "index.html" } = {}) {
  const root = path.resolve(rootDir);

  async function statFile(p) {
    try {
      const st = await fsp.stat(p);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<boolean>} true when the request was served. */
  return async function serve(ctx) {
    if (ctx.method !== "GET" && ctx.method !== "HEAD") return false;

    let rel = ctx.pathname.replace(/^\/+/, "");
    if (rel === "") rel = "index.html";
    // Resolve first, then prove the result is still inside the web root — this
    // catches "..", encoded traversal and symlink-ish tricks in one check.
    let file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return false;

    let st = await statFile(file);
    if (!st && !path.extname(file)) {
      const asHtml = file + ".html";
      st = await statFile(asHtml);
      if (st) file = asHtml;
    }
    if (!st) {
      // Client-routed URL (/site/xxx, /play, …): hand back the app shell so the
      // frontend router can take over. Anything with an extension is a real 404.
      if (!spaFallback || path.extname(ctx.pathname)) return false;
      file = path.join(root, spaFallback);
      st = await statFile(file);
      if (!st) return false;
    }

    const ext = path.extname(file).toLowerCase();
    const etag = etagOf(st);
    const immutable = /[\\/]vendor[\\/]/.test(file); // third-party bundles change name, not content
    const headers = {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Last-Modified": st.mtime.toUTCString(),
      ETag: etag,
      "Cache-Control": immutable ? "public, max-age=604800" : "no-cache",
    };

    const inm = ctx.req.headers["if-none-match"];
    if (inm && inm.split(",").some((t) => t.trim() === etag)) {
      ctx.res.writeHead(304, { ETag: etag, "Cache-Control": headers["Cache-Control"] });
      ctx.res.end();
      return true;
    }

    // Range support. A <video> served without it reports seekable.end = 0, so every
    // currentTime assignment clamps to 0 and seeking silently does nothing — which
    // looks exactly like a player bug. (It cost hours once; it is 15 lines.)
    headers["Accept-Ranges"] = "bytes";
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(ctx.req.headers.range || "");
    if (range && st.size > 0) {
      const [, s, e] = range;
      if (s === "" && e === "") return respond();
      if (s === "") {
        start = Math.max(0, st.size - Number(e));
      } else {
        start = Number(s);
        if (e !== "") end = Math.min(end, Number(e));
      }
      if (!Number.isFinite(start) || start > end) {
        ctx.res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        ctx.res.end();
        return true;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
      headers["Content-Length"] = end - start + 1;
    }
    return respond();

    async function respond() {
      ctx.res.writeHead(status, headers);
      if (ctx.method === "HEAD") {
        ctx.res.end();
        return true;
      }
      await pipeline(createReadStream(file, { start, end }), ctx.res).catch(() => {
        try { ctx.res.destroy(); } catch {}
      });
      return true;
    }
  };
}

export const exists = (p) => fs.existsSync(p);
