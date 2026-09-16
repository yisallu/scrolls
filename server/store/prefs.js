// Shared preference documents (no auth — this is a single-tenant box).
//
// Keeping presets on the SERVER instead of localStorage is what makes the player feel
// like one app across phone/desktop: tune the threshold on the laptop, open it on the
// phone, same presets. Key "player" maps to data/prefs.json for compatibility with
// v1 installs; any other key gets its own prefs-<key>.json.

import path from "node:path";
import config from "../config.js";
import { ensureDir, readJsonSync, debouncedWriter } from "./json-file.js";
import { httpErr } from "../lib/errors.js";

const KEY_RE = /^[a-z0-9_-]{1,32}$/i;

export class PrefsStore {
  constructor(dir = config.dataDir) {
    this.dir = ensureDir(dir);
    this.docs = new Map();
    this.writers = new Map();
  }

  #file(key) {
    if (!key || key === "player") return path.join(this.dir, "prefs.json");
    if (!KEY_RE.test(key)) throw httpErr(400, "prefs key 只能是字母数字下划线连字符", "bad_request");
    return path.join(this.dir, `prefs-${key}.json`);
  }

  get(key) {
    const file = this.#file(key);
    if (!this.docs.has(file)) this.docs.set(file, readJsonSync(file, {}) || {});
    return this.docs.get(file);
  }

  set(key, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw httpErr(400, "prefs 必须是一个 JSON 对象", "bad_request");
    }
    const file = this.#file(key);
    this.docs.set(file, value);
    if (!this.writers.has(file)) this.writers.set(file, debouncedWriter(file, 400, { pretty: false }));
    this.writers.get(file).schedule(value);
    return value;
  }

  async flush() {
    await Promise.all([...this.writers.values()].map((w) => w.flush()));
  }
}

export default PrefsStore;
