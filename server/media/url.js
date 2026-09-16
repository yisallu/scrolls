// Building /api/stream links lives in its own module so the engine can produce them
// without importing the whole media proxy (and the circular import that would create).

export const STREAM_PATH = "/api/stream";

/** Wrap a third-party media URL so the browser fetches it from *our* origin. */
export function proxiedMediaUrl(site, absoluteUrl) {
  return `${STREAM_PATH}?site=${encodeURIComponent(site)}&u=${encodeURIComponent(absoluteUrl)}`;
}

export function isProxiedUrl(u) {
  return typeof u === "string" && u.startsWith(STREAM_PATH + "?");
}

/** Recover the upstream URL from a proxied one (used when re-proxying would double-wrap). */
export function unproxy(u) {
  if (!isProxiedUrl(u)) return u;
  try {
    return new URL(u, "http://x").searchParams.get("u") || u;
  } catch {
    return u;
  }
}
