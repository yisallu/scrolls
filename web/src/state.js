// Shared client state: the site list and 我的片库 (history / favourites / saved tabs).
// Both are small, both are needed by several views, and both are cheap to keep warm —
// so they are fetched once, mutated optimistically, and broadcast to subscribers.

import api from "./api.js";

export const state = {
  sites: [],
  library: { history: [], favorites: [], savedSearches: {} },
  lastSite: localStorage.getItem("scrolls.lastSite") || "",
};

const subs = new Set();
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
function emit() {
  for (const fn of subs) {
    try {
      fn(state);
    } catch (e) {
      console.warn("subscriber failed", e);
    }
  }
}

export const entryKey = (e) => `${e.site || ""}|${e.url || e.id || ""}`;

let sitesPromise = null;
export function loadSites(force = false) {
  if (force) sitesPromise = null;
  sitesPromise ||= api.sites().then((list) => {
    state.sites = Array.isArray(list) ? list : [];
    emit();
    return state.sites;
  });
  return sitesPromise;
}

export const siteById = (id) => state.sites.find((s) => s.id === id) || null;

export function setLastSite(id) {
  if (!id || state.lastSite === id) return;
  state.lastSite = id;
  try {
    localStorage.setItem("scrolls.lastSite", id);
  } catch {
    /* private mode */
  }
}

let libraryPromise = null;
export function loadLibrary(force = false) {
  if (force) libraryPromise = null;
  libraryPromise ||= api
    .library()
    .then((doc) => {
      state.library = {
        history: doc.history || [],
        favorites: doc.favorites || [],
        savedSearches: doc.savedSearches || {},
      };
      emit();
      return state.library;
    })
    .catch(() => state.library); // the library is a nicety; never block browsing on it
  return libraryPromise;
}

// ---- history ----------------------------------------------------------------

export const historyFor = (key) => state.library.history.find((h) => h.key === key) || null;
export const savedSearches = (siteId) => state.library.savedSearches[siteId] || [];

/**
 * Record (or update) a watch entry. The local copy updates immediately so the UI
 * reacts at once; the POST is coalesced per item because the player calls this every
 * few seconds while playing.
 */
const pending = new Map();
export function recordHistory(entry, { flush = false } = {}) {
  const key = entryKey(entry);
  const merged = { ...(historyFor(key) || {}), ...entry, key, updatedAt: Date.now() };
  state.library.history = [merged, ...state.library.history.filter((h) => h.key !== key)];
  emit();

  const send = () => {
    pending.delete(key);
    api.recordHistory(merged).catch(() => {});
  };
  if (flush) {
    clearTimeout(pending.get(key));
    send();
    return;
  }
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(send, 1500));
}

export async function removeHistory(key) {
  state.library.history = state.library.history.filter((h) => h.key !== key);
  emit();
  await api.removeHistory(key).catch(() => {});
}

export async function clearHistory() {
  state.library.history = [];
  emit();
  await api.clearHistory().catch(() => {});
}

// ---- favourites ---------------------------------------------------------------

export const isFavorite = (key) => state.library.favorites.some((f) => f.key === key);

export async function toggleFavorite(entry) {
  const key = entryKey(entry);
  const on = isFavorite(key);
  state.library.favorites = on
    ? state.library.favorites.filter((f) => f.key !== key)
    : [{ ...entry, key, addedAt: Date.now() }, ...state.library.favorites];
  emit();
  try {
    await api.toggleFavorite(entry);
  } catch {
    loadLibrary(true); // server disagreed — resync rather than lie to the user
  }
  return !on;
}

// ---- saved-search tabs ----------------------------------------------------------

export async function addSavedSearch(site, kw) {
  kw = String(kw || "").trim();
  if (!kw) return;
  const arr = savedSearches(site);
  if (!arr.some((s) => s.kw === kw)) state.library.savedSearches[site] = [...arr, { kw }];
  emit();
  await api.addSavedSearch(site, kw).catch(() => {});
}

export async function removeSavedSearch(site, kw) {
  state.library.savedSearches[site] = savedSearches(site).filter((s) => s.kw !== kw);
  emit();
  await api.removeSavedSearch(site, kw).catch(() => {});
}
