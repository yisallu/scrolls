// Talking to /api. Scraping is flaky by nature — an upstream site hiccups, a CDN
// rate-limits — so GETs retry with backoff before surfacing an error, and errors
// carry the server's machine-readable `code` for callers that want to branch.

const RETRY_DELAYS = [0, 400, 1100, 2400];
const RETRYABLE = new Set([429, 502, 503, 504]);

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code || "error";
  }
  /** Upstream-is-blocking errors read very differently from bugs — the UI says so. */
  get transient() {
    return this.status === 424 || this.status === 429 || this.status >= 500;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(path, { method = "GET", body, signal, retry } = {}) {
  const attempts = retry ?? (method === "GET" ? RETRY_DELAYS.length : 1);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (RETRY_DELAYS[i]) await sleep(RETRY_DELAYS[i]);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const res = await fetch("/api" + path, {
        method,
        signal,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text.slice(0, 200) };
      }
      if (res.ok) return data;
      const err = new ApiError(data.error || `HTTP ${res.status}`, res.status, data.code);
      if (i < attempts - 1 && RETRYABLE.has(res.status)) {
        lastErr = err;
        continue;
      }
      throw err;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      lastErr = e instanceof ApiError ? e : new ApiError(e.message || "网络错误", 0, "network");
      if (i === attempts - 1) throw lastErr;
    }
  }
  throw lastErr;
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
};

export const api = {
  sites: (signal) => request("/sites", { signal }),
  stats: () => request("/stats"),

  discover: (params, signal) => request("/discover" + qs(params), { signal }),
  search: (params, signal) => request("/search" + qs(params), { signal }),
  detail: (params, signal) => request("/detail" + qs(params), { signal }),
  resolve: (params, signal) => request("/resolve" + qs(params), { signal }),
  image: (params, signal) => request("/image" + qs(params), { signal }),
  gallery: (params, signal) => request("/gallery" + qs(params), { signal }),
  // Not a JSON call: the URL of one gallery page, served (and cached on disk) by the
  // server. Going straight to it skips the /api/image round-trip AND lets a re-read
  // cost no upstream quota at all — see server/media/page.js.
  pageUrl: ({ site, id, variant, model, noise, scale }) =>
    "/api" + "/page" + qs({ site, id, v: variant || "", model, noise, scale }),
  w2xOnline: (signal) => request("/w2x/online", { signal }),
  // Raise a page the GPU already has queued, without changing the image URL.
  w2xFocus: (params) => request("/w2x/focus" + qs(params)),

  // Favourites on the SITE's account (exhentai), not the local library in 我的片库.
  favoriteState: (params, signal) => request("/favorite" + qs(params), { signal }),
  setFavorite: (body, signal) => request("/favorite", { method: "POST", body, signal }),

  rules: () => request("/rules"),
  saveRule: (rule) => request("/rules", { method: "POST", body: rule }),
  deleteRule: (id) => request("/rules/" + encodeURIComponent(id), { method: "DELETE" }),

  getPrefs: (key) => request("/prefs" + qs({ key })),
  putPrefs: (key, value) => request("/prefs" + qs({ key }), { method: "PUT", body: value }),

  library: (signal) => request("/library", { signal }),
  recordHistory: (entry) => request("/library/history", { method: "POST", body: entry }),
  removeHistory: (key) => request("/library/history" + qs({ key }), { method: "DELETE" }),
  clearHistory: () => request("/library/history", { method: "DELETE" }),
  toggleFavorite: (entry) => request("/library/favorites", { method: "POST", body: entry }),
  removeFavorite: (key) => request("/library/favorites" + qs({ key }), { method: "DELETE" }),
  addSavedSearch: (site, kw) => request("/library/searches", { method: "POST", body: { site, kw } }),
  removeSavedSearch: (site, kw) => request("/library/searches" + qs({ site, kw }), { method: "DELETE" }),
};

export default api;
