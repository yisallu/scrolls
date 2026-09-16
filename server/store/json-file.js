// JSON documents on disk, written the careful way.
//
// The rules directory is the only irreplaceable thing on this box — every rule in it
// took real work to get right. So writes are atomic (tmp file + rename, so a crash
// mid-write can never truncate a rule) and every overwrite leaves a timestamped
// backup, pruned to the last few.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { logger } from "../lib/log.js";

const log = logger("store");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") log.warn("unreadable JSON", file, e.message);
    return fallback;
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") log.warn("unreadable JSON", file, e.message);
    return fallback;
  }
}

const BACKUP_KEEP = 5;

/** Keep the newest BACKUP_KEEP `<name>.bak-*` files next to `file`, delete the rest. */
async function pruneBackups(file) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + ".bak-";
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.startsWith(prefix)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
      await fsp.unlink(path.join(dir, n)).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Atomically write a JSON document.
 * @param {string} file
 * @param {any} data
 * @param {{ backup?: boolean, pretty?: boolean }} [opts] backup: keep a copy of the previous content
 */
export async function writeJsonAtomic(file, data, opts = {}) {
  const { backup = false, pretty = true } = opts;
  ensureDir(path.dirname(file));
  if (backup) {
    try {
      await fsp.copyFile(file, `${file}.bak-${stamp()}`);
      await pruneBackups(file);
    } catch (e) {
      if (e.code !== "ENOENT") log.warn("backup failed", file, e.message);
    }
  }
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  const text = JSON.stringify(data, null, pretty ? 2 : 0);
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync(); // the bytes must be on disk before the rename claims they are
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file); // atomic on both POSIX and NTFS
  return data;
}

/**
 * Coalesce bursts of writes to one file (progress updates arrive every few seconds).
 * Returns a function that schedules a write and resolves when it lands.
 */
export function debouncedWriter(file, delayMs = 400, opts = {}) {
  let timer = null;
  let pending = null;
  let chain = Promise.resolve();
  return {
    schedule(data) {
      pending = data;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const snapshot = pending;
        chain = chain.then(() => writeJsonAtomic(file, snapshot, opts)).catch((e) => log.error("write failed", file, e.message));
      }, delayMs);
      timer.unref?.();
    },
    /** Force any pending write out now (used on shutdown). */
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        if (pending != null) chain = chain.then(() => writeJsonAtomic(file, pending, opts));
      }
      await chain;
    },
  };
}
