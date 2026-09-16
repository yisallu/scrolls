// Segmentation presets, stored on the SERVER so they follow you between devices.
// localStorage is kept only as an instant-render cache and an offline fallback: the
// UI paints from it immediately, then reconciles with the server a moment later.
//
// Wire format is unchanged from v1 ({presets, activeId, current}), so an existing
// data/prefs.json keeps working after the upgrade.

import api from "../api.js";

const STORE_KEY = "shadowplay.presets.v1";
export const DEFAULTS = { mode: "silence", threshold: -45, gap: 600, drop: 9 };

const uid = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function normValues(c = {}) {
  return {
    mode: c.mode === "adaptive" ? "adaptive" : "silence",
    threshold: typeof c.threshold === "number" ? c.threshold : DEFAULTS.threshold,
    gap: typeof c.gap === "number" ? c.gap : DEFAULTS.gap,
    drop: typeof c.drop === "number" ? c.drop : DEFAULTS.drop,
  };
}

function defaultDoc() {
  const mk = (name, o) => ({ id: uid(), name, ...DEFAULTS, ...o });
  const presets = [
    mk("默认", {}),
    mk("慢速跟读", { gap: 1000 }),
    mk("嘈杂环境", { threshold: -38, gap: 700 }),
    mk("背景音乐 · 自适应", { mode: "adaptive", drop: 9, gap: 500 }),
  ];
  return { presets, activeId: presets[0].id, current: { ...DEFAULTS } };
}

function sanitize(d) {
  if (!d || !Array.isArray(d.presets)) return null;
  const doc = {
    presets: d.presets.filter((p) => p && typeof p.name === "string").map((p) => ({ id: p.id || uid(), name: p.name, ...normValues(p) })),
    current: normValues(d.current),
    activeId: d.activeId || null,
  };
  if (doc.activeId && !doc.presets.some((p) => p.id === doc.activeId)) doc.activeId = null;
  return doc;
}

export class PresetStore extends EventTarget {
  constructor() {
    super();
    let cached = null;
    try {
      cached = sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || "null"));
    } catch {
      /* private mode / corrupt */
    }
    this.doc = cached || defaultDoc();
    this.saveTimer = null;
  }

  get presets() {
    return this.doc.presets;
  }
  get current() {
    return this.doc.current;
  }
  get activeId() {
    return this.doc.activeId;
  }
  get active() {
    return this.doc.presets.find((p) => p.id === this.doc.activeId) || null;
  }

  isModified() {
    const a = this.active;
    if (!a) return false;
    const c = this.doc.current;
    return a.mode !== c.mode || a.threshold !== c.threshold || a.gap !== c.gap || a.drop !== c.drop;
  }

  changed() {
    this.dispatchEvent(new Event("change"));
  }

  /** Pull the server copy; if the server has none, push ours up (migrates v1 installs). */
  async sync() {
    try {
      const server = await api.getPrefs("player");
      const clean = sanitize(server);
      if (clean) {
        this.doc = clean;
        this.#writeLocal();
        this.changed();
        return;
      }
    } catch {
      /* offline — keep the local copy */
    }
    api.putPrefs("player", this.doc).catch(() => {});
  }

  #writeLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.doc));
    } catch {
      /* quota / private mode */
    }
  }

  persist() {
    this.#writeLocal();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => api.putPrefs("player", this.doc).catch(() => {}), 400);
  }

  setCurrent(partial) {
    this.doc.current = normValues({ ...this.doc.current, ...partial });
    this.persist();
    this.changed();
  }

  select(id) {
    const p = this.doc.presets.find((x) => x.id === id);
    if (!p) return null;
    this.doc.activeId = p.id;
    this.doc.current = normValues(p);
    this.persist();
    this.changed();
    return this.doc.current;
  }

  updateActive() {
    const a = this.active;
    if (!a) return;
    Object.assign(a, normValues(this.doc.current));
    this.persist();
    this.changed();
  }

  create(name) {
    const p = { id: uid(), name: name || `预设 ${this.doc.presets.length + 1}`, ...normValues(this.doc.current) };
    this.doc.presets.push(p);
    this.doc.activeId = p.id;
    this.persist();
    this.changed();
    return p;
  }

  rename(name) {
    const a = this.active;
    if (!a || !name) return;
    a.name = name;
    this.persist();
    this.changed();
  }

  removeActive() {
    this.doc.presets = this.doc.presets.filter((p) => p.id !== this.doc.activeId);
    this.doc.activeId = null; // becomes 自定义, keeping the current values
    this.persist();
    this.changed();
  }
}

/** Playback preferences that are global rather than per-preset (rewind, jog, speed). */
export class LocalPrefs {
  constructor(key, defaults) {
    this.key = key;
    this.values = { ...defaults };
    try {
      const s = JSON.parse(localStorage.getItem(key) || "null");
      if (s && typeof s === "object") {
        for (const k of Object.keys(defaults)) if (typeof s[k] === typeof defaults[k]) this.values[k] = s[k];
      }
    } catch {
      /* ignore */
    }
  }
  get(k) {
    return this.values[k];
  }
  set(k, v) {
    this.values[k] = v;
    try {
      localStorage.setItem(this.key, JSON.stringify(this.values));
    } catch {
      /* ignore */
    }
  }
}
