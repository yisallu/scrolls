// Rules live as one JSON file each under data/rules/ and are kept in memory.
//
// New in v2: the directory is WATCHED. Editing a rule file on the server (or rsyncing
// one in) now takes effect immediately — in v1 the file was read once at boot, so a
// hand-edited rule silently did nothing until the process restarted, which cost real
// debugging time more than once.

import fs from "node:fs";
import path from "node:path";
import config from "../config.js";
import { logger } from "../lib/log.js";
import { ensureDir, readJsonSync, writeJsonAtomic } from "./json-file.js";
import { validateRule, normalizeRule, redactRule, mergeSecrets, publicSite } from "../engine/rule-schema.js";
import { httpErr } from "../lib/errors.js";

const log = logger("rules");

export class RuleStore {
  constructor(dir = path.join(config.dataDir, "rules")) {
    this.dir = ensureDir(dir);
    this.map = new Map();
    this.listeners = new Set();
    this.loadAll();
    this.#watch();
  }

  loadAll() {
    const next = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue; // ignores the .bak-* files we leave behind
      const raw = readJsonSync(path.join(this.dir, f));
      if (!raw || !raw.id) {
        if (raw) log.warn("skipping rule without id:", f);
        continue;
      }
      try {
        validateRule(raw);
        next.set(raw.id, normalizeRule(raw));
      } catch (e) {
        log.warn(`skipping invalid rule ${f}: ${e.message}`);
      }
    }
    this.map = next;
    log.info(`loaded ${this.map.size} rule(s) from ${this.dir}`);
    return this.map;
  }

  #watch() {
    let timer = null;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.loadAll();
        for (const fn of this.listeners) {
          try { fn(); } catch (e) { log.warn("reload listener failed:", e.message); }
        }
      }, 250); // editors write in bursts; collapse them into one reload
      timer.unref?.();
    };
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_ev, name) => {
        if (!name || String(name).endsWith(".json")) reload();
      });
      this.watcher.on("error", (e) => log.warn("rule watch error:", e.message));
    } catch (e) {
      log.warn("rule directory is not watchable, falling back to no hot-reload:", e.message);
    }
  }

  /** Called after any change (used to drop cached listings for the affected site). */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(id) {
    return this.map.get(String(id || "")) || null;
  }

  /** The rule for a request, or a 400 explaining which site was missing. */
  require(id) {
    const rule = this.get(id);
    if (!rule) throw httpErr(400, id ? `未知站点:${id}` : "缺少 site 参数", "unknown_site");
    return rule;
  }

  all() {
    return [...this.map.values()];
  }

  listSites() {
    return this.all().map(publicSite);
  }

  listRules() {
    return this.all().map(redactRule);
  }

  async save(rule) {
    validateRule(rule);
    const normalized = normalizeRule(mergeSecrets(rule, this.map.get(rule.id)));
    this.map.set(normalized.id, normalized);
    await writeJsonAtomic(path.join(this.dir, normalized.id + ".json"), normalized, { backup: true });
    log.info("saved rule", normalized.id);
    for (const fn of this.listeners) fn();
    return normalized;
  }

  async remove(id) {
    if (!this.map.has(id)) throw httpErr(404, `没有名为 ${id} 的规则`, "not_found");
    this.map.delete(id);
    const file = path.join(this.dir, id + ".json");
    // Keep a backup rather than really deleting: rules are expensive to recreate.
    try {
      await writeJsonAtomic(file + ".deleted", readJsonSync(file, {}), { backup: false });
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    log.info("deleted rule", id);
    for (const fn of this.listeners) fn();
    return { ok: true };
  }
}

export default RuleStore;
