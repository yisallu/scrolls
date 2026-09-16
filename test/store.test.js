// The stores own the only irreplaceable state on the box (rules) and the only state a
// user would miss (history / favourites), so both are tested against a real temp dir.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic, readJsonSync, debouncedWriter } from "../server/store/json-file.js";
import { LibraryStore } from "../server/store/library.js";
import { RuleStore } from "../server/store/rules.js";
import { PageCache } from "../server/media/pagecache.js";
import { orderMatchers } from "../server/engine/ops.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scrolls-test-"));

test("atomic writes leave no partial file and keep a backup", async () => {
  const dir = tmp();
  const file = path.join(dir, "rule.json");
  await writeJsonAtomic(file, { v: 1 });
  await writeJsonAtomic(file, { v: 2 }, { backup: true });
  assert.deepEqual(readJsonSync(file), { v: 2 });
  const backups = fs.readdirSync(dir).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(readJsonSync(path.join(dir, backups[0])), { v: 1 }, "the backup holds the previous content");
  assert.equal(fs.readdirSync(dir).some((f) => f.includes(".tmp-")), false, "no temp files left behind");
});

test("debounced writer coalesces a burst into one write", async () => {
  const dir = tmp();
  const file = path.join(dir, "prefs.json");
  const w = debouncedWriter(file, 20, { pretty: false });
  for (let i = 0; i < 20; i++) w.schedule({ i });
  await w.flush();
  assert.deepEqual(readJsonSync(file), { i: 19 }, "the last value wins");
});

test("library: history upserts, keeps metadata and resumes", () => {
  const dir = tmp();
  const lib = new LibraryStore(dir);
  lib.recordHistory({ site: "s", url: "u1", title: "片子", cover: "c.jpg", duration: 120, position: 10 });
  lib.recordHistory({ site: "s", url: "u1", position: 45, duration: 120 }); // a progress ping
  lib.recordHistory({ site: "s", url: "u2", title: "另一部" });

  assert.equal(lib.snapshot().history.length, 2, "same item updates rather than duplicating");
  assert.equal(lib.snapshot().history[0].url, "u2", "most recent first");
  const resumed = lib.progressFor("s", "u1");
  assert.equal(resumed.position, 45);
  assert.equal(resumed.cover, "c.jpg", "a progress ping must not wipe the cover");
  assert.equal(resumed.title, "片子");

  lib.removeHistory(resumed.key);
  assert.equal(lib.snapshot().history.length, 1);
  lib.clearHistory();
  assert.equal(lib.snapshot().history.length, 0);
});

test("library: favourites toggle, saved searches, and rejecting junk", () => {
  const lib = new LibraryStore(tmp());
  const entry = { site: "s", id: "42", title: "图集", kind: "image" };
  assert.equal(lib.toggleFavorite(entry).favorited, true);
  assert.equal(lib.snapshot().favorites.length, 1);
  assert.equal(lib.toggleFavorite(entry).favorited, false);
  assert.equal(lib.snapshot().favorites.length, 0);

  assert.equal(lib.recordHistory({ title: "no site" }), null);
  assert.equal(lib.toggleFavorite({ site: "s" }), null, "an entry needs a url or an id");

  lib.addSavedSearch("s", "  pov  ");
  lib.addSavedSearch("s", "pov"); // duplicate
  assert.deepEqual(lib.snapshot().savedSearches.s, [{ kw: "pov" }]);
  lib.removeSavedSearch("s", "pov");
  assert.deepEqual(lib.snapshot().savedSearches.s, []);
});

test("library migrates v1 saved-search tabs on first run", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "prefs-library.json"), JSON.stringify({ savedSearches: { s: [{ kw: "旧标签" }] } }));
  const lib = new LibraryStore(dir);
  assert.deepEqual(lib.snapshot().savedSearches.s, [{ kw: "旧标签" }]);
});

test("rule store: save, list, redact, hot-reload from disk, delete keeps a copy", async () => {
  const dir = tmp();
  const store = new RuleStore(dir);
  assert.equal(store.all().length, 0);

  await store.save({
    id: "demo",
    name: "示例",
    baseUrl: "https://example.test",
    allowedHosts: ["example.test"],
    headers: { Cookie: "s3cret" },
    discover: [{ name: "全部", url: "/list?p={page}", list: { item: ".c", url: "@href" } }],
  });
  assert.equal(store.get("demo").headers.Cookie, "s3cret");
  assert.equal(store.listRules()[0].headers.Cookie, "***", "the API dump never leaks the cookie");
  assert.equal(store.listSites()[0].categories.length, 1);

  // an invalid rule is rejected, and the good one survives
  await assert.rejects(() => store.save({ id: "bad" }), /规则无效/);
  assert.equal(store.all().length, 1);

  // hot reload: a file edited underneath us is picked up on the next loadAll
  const file = path.join(dir, "demo.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.name = "改过的名字";
  fs.writeFileSync(file, JSON.stringify(raw));
  store.loadAll();
  assert.equal(store.get("demo").name, "改过的名字");

  await store.remove("demo");
  assert.equal(store.get("demo"), null);
  assert.equal(fs.existsSync(file + ".deleted"), true, "a deleted rule is recoverable");
  await assert.rejects(() => store.remove("demo"), /没有名为/);
});

// ---- the page cache -------------------------------------------------------------
// This cache is what keeps re-reading a gallery from costing E-Hentai image quota a
// second time, so its correctness is a quota question, not a performance one.

test("page cache: id-addressed round-trip, variants are separate entries", async () => {
  const dir = tmp();
  const c = new PageCache({ enabled: true, dir, maxBytes: 1e9 });
  const id = "/s/abc123/4187842-7";

  assert.equal(await c.find("exhentai", id, ""), null, "cold cache misses");

  await c.put("exhentai", id, "", Buffer.from("sample-bytes"), "image/webp");
  const hit = await c.find("exhentai", id, "");
  assert.ok(hit, "the page is found by its id alone — no URL involved");
  assert.equal(hit.contentType, "image/webp");
  assert.equal(fs.readFileSync(hit.file, "utf8"), "sample-bytes");

  // The original is a different file for the same page: asking for one must never
  // serve the other, or turning the switch on would silently show the sample.
  assert.equal(await c.find("exhentai", id, "original"), null);
  await c.put("exhentai", id, "original", Buffer.from("original-bytes-which-are-bigger"), "image/jpeg");
  const orig = await c.find("exhentai", id, "original");
  assert.equal(orig.contentType, "image/jpeg");
  assert.notEqual(orig.file, hit.file);

  assert.equal(fs.readdirSync(dir).some((f) => f.includes(".tmp-")), false, "no temp files left behind");
});

test("page cache: sweep evicts the least recently used until under the cap", async () => {
  const dir = tmp();
  const c = new PageCache({ enabled: true, dir, maxBytes: 1e9 });
  const big = Buffer.alloc(1000, 1);
  for (const n of [1, 2, 3, 4]) await c.put("s", `/p/${n}`, "", big, "image/jpeg");

  // Age pages 1 and 2 so they are the obvious eviction candidates.
  for (const n of [1, 2]) {
    const h = await c.find("s", `/p/${n}`, "");
    const old = new Date(Date.now() - 86400_000 * n);
    fs.utimesSync(h.file, old, old);
  }

  c.maxBytes = 2500; // room for two of the four
  const swept = await c.sweep();
  assert.equal(swept.removed, 2);
  assert.equal(await c.find("s", "/p/1", ""), null, "oldest went first");
  assert.equal(await c.find("s", "/p/2", ""), null);
  assert.ok(await c.find("s", "/p/3", ""), "recently touched pages survive");
  assert.ok(await c.find("s", "/p/4", ""));
});

test("page cache: disabled is a no-op, never a crash", async () => {
  const c = new PageCache({ enabled: false, dir: path.join(tmp(), "unused"), maxBytes: 1 });
  assert.equal(await c.put("s", "/p/1", "", Buffer.from("x"), "image/png"), null);
  assert.equal(await c.find("s", "/p/1", ""), null);
});

test("orderMatchers: the asked-for variant first, everything else still a fallback", () => {
  const sample = { from: "selector", selector: "#img@src", variant: "sample" };
  const original = { from: "selector", selector: "a[href*='/fullimg/']@href", variant: "original" };
  const match = [sample, original];

  assert.deepEqual(orderMatchers(match, ""), [sample, original], "no variant = declared order");
  assert.deepEqual(orderMatchers(match, "original"), [original, sample], "original first, sample as fallback");
  assert.deepEqual(orderMatchers(match, "sample"), [sample, original]);
  // A site with no tagged matchers must not lose its matchers by asking for a variant
  // it does not have — it degrades to whatever it does serve.
  const untagged = [{ from: "selector", selector: "img@src" }];
  assert.deepEqual(orderMatchers(untagged, "original"), untagged);
  assert.deepEqual(orderMatchers(undefined, "original"), []);
});
