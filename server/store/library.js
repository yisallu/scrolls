// 我的片库 — watch history with resume positions, favourites, and the saved-search
// tabs. Server-side and unauthenticated, exactly like the player presets, so the
// phone and the desktop see the same library.
//
// This is the feature v1 never had: it knew how to *find* things and nothing about
// what you had already watched. Continue-watching turns a scraper into a library.

import path from "node:path";
import config from "../config.js";
import { logger } from "../lib/log.js";
import { ensureDir, readJsonSync, debouncedWriter } from "./json-file.js";

const log = logger("library");

const MAX_HISTORY = 400;
const MAX_FAVORITES = 2000;
const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

/** Stable identity for a piece of content: its site plus its URL (videos) or id (images). */
export const entryKey = (e) => `${e.site || ""}|${e.url || e.id || ""}`;

function normalizeEntry(input = {}) {
  const e = {
    site: clip(input.site, 64),
    kind: input.kind === "gallery" || input.kind === "image" ? input.kind : "video",
    url: clip(input.url, 1024),
    id: clip(input.id, 512),
    // Left empty on purpose when absent: a progress ping carries only a position, and
    // must not overwrite the title we learned when playback started.
    title: clip(input.title, 300),
    cover: clip(input.cover, 2048),
    detailUrl: clip(input.detailUrl, 1024),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 40).map((t) => clip(String(t), 60)) : [],
    position: Number.isFinite(+input.position) ? Math.max(0, +input.position) : 0,
    duration: Number.isFinite(+input.duration) ? Math.max(0, +input.duration) : 0,
    page: Number.isFinite(+input.page) ? Math.max(0, Math.floor(+input.page)) : 0, // gallery reading position
  };
  e.key = entryKey(e);
  return e;
}

export class LibraryStore {
  constructor(dir = config.dataDir) {
    this.dir = ensureDir(dir);
    this.file = path.join(this.dir, "library.json");
    this.doc = readJsonSync(this.file, null) || this.#seedFromV1();
    this.doc.history = Array.isArray(this.doc.history) ? this.doc.history : [];
    this.doc.favorites = Array.isArray(this.doc.favorites) ? this.doc.favorites : [];
    this.doc.savedSearches = this.doc.savedSearches && typeof this.doc.savedSearches === "object" ? this.doc.savedSearches : {};
    this.writer = debouncedWriter(this.file, 600, { pretty: false });
  }

  // v1 kept the saved-search tabs in prefs-library.json. Carry them over once so
  // upgrading an existing install doesn't lose someone's tabs.
  #seedFromV1() {
    const legacy = readJsonSync(path.join(this.dir, "prefs-library.json"), null);
    if (legacy && legacy.savedSearches) {
      log.info("migrating saved-search tabs from prefs-library.json");
      return { history: [], favorites: [], savedSearches: legacy.savedSearches };
    }
    return { history: [], favorites: [], savedSearches: {} };
  }

  #save() {
    this.writer.schedule(this.doc);
    return this.doc;
  }

  snapshot() {
    return {
      history: this.doc.history,
      favorites: this.doc.favorites,
      savedSearches: this.doc.savedSearches,
    };
  }

  // ---- history ----------------------------------------------------------------

  /** Upsert a watch entry. Called on play and then periodically with the position. */
  recordHistory(input) {
    const e = normalizeEntry(input);
    if (!e.site || (!e.url && !e.id)) return null;
    const now = Date.now();
    const idx = this.doc.history.findIndex((h) => h.key === e.key);
    const prev = idx >= 0 ? this.doc.history[idx] : null;
    const merged = {
      ...prev,
      ...e,
      // a later progress ping usually omits title/cover/tags — keep what we already knew
      title: e.title || (prev && prev.title) || "(无标题)",
      cover: e.cover || (prev && prev.cover) || "",
      tags: e.tags.length ? e.tags : (prev && prev.tags) || [],
      duration: e.duration || (prev && prev.duration) || 0,
      addedAt: (prev && prev.addedAt) || now,
      updatedAt: now,
    };
    if (idx >= 0) this.doc.history.splice(idx, 1);
    this.doc.history.unshift(merged);
    if (this.doc.history.length > MAX_HISTORY) this.doc.history.length = MAX_HISTORY;
    this.#save();
    return merged;
  }

  removeHistory(key) {
    const before = this.doc.history.length;
    this.doc.history = this.doc.history.filter((h) => h.key !== key);
    if (this.doc.history.length !== before) this.#save();
    return { ok: true, removed: before - this.doc.history.length };
  }

  clearHistory() {
    this.doc.history = [];
    this.#save();
    return { ok: true };
  }

  /** Resume info for one item — the player asks for this before it starts. */
  progressFor(site, ref) {
    const key = entryKey({ site, url: ref, id: ref });
    return this.doc.history.find((h) => h.key === key) || null;
  }

  // ---- favourites ---------------------------------------------------------------

  toggleFavorite(input) {
    const e = normalizeEntry(input);
    if (!e.site || (!e.url && !e.id)) return null;
    const idx = this.doc.favorites.findIndex((f) => f.key === e.key);
    if (idx >= 0) {
      this.doc.favorites.splice(idx, 1);
      this.#save();
      return { favorited: false, key: e.key };
    }
    this.doc.favorites.unshift({ ...e, title: e.title || "(无标题)", addedAt: Date.now() });
    if (this.doc.favorites.length > MAX_FAVORITES) this.doc.favorites.length = MAX_FAVORITES;
    this.#save();
    return { favorited: true, key: e.key, entry: this.doc.favorites[0] };
  }

  removeFavorite(key) {
    const before = this.doc.favorites.length;
    this.doc.favorites = this.doc.favorites.filter((f) => f.key !== key);
    if (this.doc.favorites.length !== before) this.#save();
    return { ok: true, removed: before - this.doc.favorites.length };
  }

  // ---- saved-search tabs ---------------------------------------------------------

  addSavedSearch(site, kw) {
    kw = clip(String(kw || "").trim(), 120);
    if (!site || !kw) return null;
    const arr = (this.doc.savedSearches[site] ||= []);
    if (!arr.some((s) => s.kw === kw)) arr.push({ kw });
    this.#save();
    return arr;
  }

  removeSavedSearch(site, kw) {
    if (!this.doc.savedSearches[site]) return [];
    this.doc.savedSearches[site] = this.doc.savedSearches[site].filter((s) => s.kw !== kw);
    this.#save();
    return this.doc.savedSearches[site];
  }

  async flush() {
    await this.writer.flush();
  }
}

export default LibraryStore;
