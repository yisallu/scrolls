import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";

import { pluck, field, numericField, getPath, jsonField, buildUrl, absUrl } from "../server/engine/dsl.js";
import { extractList, extractTags, extractTagLinks, extractGallery, runMatchers } from "../server/engine/extract.js";
import { rewriteM3u8 } from "../server/media/stream.js";
import { ipIsPrivate, hostMatches, assertHostAllowed, assertPublicUrl } from "../server/lib/net.js";
import { TtlCache } from "../server/lib/cache.js";
import { validateRule, publicSite, redactRule, mergeSecrets } from "../server/engine/rule-schema.js";

const HTML = `
<html><body>
  <div class="list">
    <a class="item" href="/v/1"><img class="cov" src="/a.jpg" style="width:250px;height:350px"><span class="t">第一集</span></a>
    <a class="item" href="/v/2"><img class="cov" data-src="/b.jpg" width="120" height="90"><span class="t">第二集</span></a>
    <a class="item" href="/v/1"><img class="cov" src="/a.jpg"><span class="t">第一集(重复)</span></a>
  </div>
  <div id="tags"><a href="/tag/a"># 甜品 (12)</a><a href="/tag/b">search.夜宵</a><a href="/tag/a"># 甜品 (12)</a></div>
  <video><source src="//cdn.example.com/x.mp4"></video>
  <p class="gpc">Showing 1 - 20 of 1,234 images</p>
  <div id="gdt"><a href="/s/tok/99-1"></a><a href="/s/tok/99-2"></a></div>
</body></html>`;

test("selector DSL: attributes, text, fallbacks", () => {
  const $ = cheerio.load(HTML);
  assert.equal(pluck($, null, ".item .t"), "第一集");
  assert.equal(pluck($, null, ".item@href"), "/v/1");
  assert.equal(pluck($, null, ".item .cov@src"), "/a.jpg");
  assert.equal(field($, null, ".nope@src||.item .cov@src"), "/a.jpg");
  assert.equal(field($, null, ".nope"), "");
  // "@attr" with no selector means the scoped element itself
  const first = $(".item").first();
  assert.equal(pluck($, first, "@href"), "/v/1");
});

test("numericField reads dimensions out of a style attribute", () => {
  const $ = cheerio.load(HTML);
  const first = $(".item").first();
  assert.equal(numericField($, first, ".cov@width||.cov@style", "width"), 250);
  assert.equal(numericField($, first, ".cov@height||.cov@style", "height"), 350);
  const second = $(".item").eq(1);
  assert.equal(numericField($, second, ".cov@width||.cov@style", "width"), 120);
});

test("extractList resolves URLs, proxies covers and drops duplicates", () => {
  const $ = cheerio.load(HTML);
  const rule = { id: "t", baseUrl: "https://x.test", proxyImages: true };
  const items = extractList(
    $,
    { item: ".item", title: ".t", url: "@href", cover: ".cov@src||.cov@data-src", width: ".cov@width||.cov@style", height: ".cov@height||.cov@style" },
    "https://x.test/list",
    rule
  );
  assert.equal(items.length, 2, "the repeated /v/1 card is collapsed");
  assert.equal(items[0].url, "https://x.test/v/1");
  assert.match(items[0].cover, /^\/api\/stream\?site=t&u=https%3A%2F%2Fx\.test%2Fa\.jpg$/);
  assert.equal(items[0].width, 250);
  assert.equal(items[1].cover.includes("b.jpg"), true);
});

test("extractTags strips noise and de-duplicates", () => {
  const $ = cheerio.load(HTML);
  const tags = extractTags($, { item: "#tags a", strip: "^\\s*#\\s*|^search\\.|\\s*\\(\\d+\\)\\s*$" });
  assert.deepEqual(tags, ["甜品", "夜宵"]);
});

test("extractGallery parses the total out of the count line", () => {
  const $ = cheerio.load(HTML);
  const g = extractGallery($, { count: ".gpc@text", item: "#gdt a" }, "https://x.test/g/99/tok/");
  assert.equal(g.total, 1234);
  assert.deepEqual(g.pages.map((p) => p.id), ["/s/tok/99-1", "/s/tok/99-2"]);
});

test("extractList drops titles matching rule.excludeTitle", () => {
  const $ = cheerio.load(`<div class="itg">
    <div class="gl1t"><a href="/g/1/a"><span class="glink">普通的本子</span></a></div>
    <div class="gl1t"><a href="/g/2/b"><span class="glink">[枕] 某游戏 - キャラクター立ち絵</span></a></div>
    <div class="gl1t"><a href="/g/3/c"><span class="glink">[bootUP!] 某游戏 （角色立绘）</span></a></div>
    <div class="gl1t"><a href="/g/4/d"><span class="glink">Some Game Character CG</span></a></div>
    <div class="gl1t"><a href="/g/5/e"><span class="glink">另一个正常的</span></a></div>
  </div>`);
  const list = { item: ".gl1t", url: "a@href", title: ".glink@text" };
  const rule = { id: "t", excludeTitle: "立ち?絵|立绘|character *(cg|sprite)|tachie" };

  const all = extractList($, list, "https://x.test/", { id: "t" });
  assert.equal(all.length, 5, "no filter without the rule field");

  const kept = extractList($, list, "https://x.test/", rule);
  assert.deepEqual(kept.map((i) => i.title), ["普通的本子", "另一个正常的"]);
  // the count rides along so a short page can be explained rather than just looking empty
  assert.equal(kept.dropped, 3);
});

test("extractGallery reads sprite-sheet page thumbnails", () => {
  // exhentai's default gallery view packs 20 page thumbs into one sheet and addresses
  // each with a background-position, so the reader's filmstrip needs the geometry too.
  const $ = cheerio.load(`<div id="gdt">
    <a href="/s/aa/99-1"><div style="width:200px;height:283px;background:transparent url(https://cdn.test/sheet.webp) -0px 0 no-repeat"></div></a>
    <a href="/s/bb/99-2"><div style="width:200px;height:283px;background:transparent url(https://cdn.test/sheet.webp) -200px 0 no-repeat"></div></a>
    <a href="/s/cc/99-3"><img src="https://cdn.test/solo.jpg"></a>
  </div>`);
  const rule = { id: "t", proxyImages: true };
  const g = extractGallery($, { item: "#gdt a" }, "https://x.test/g/99/tok/", rule);
  assert.equal(g.pages.length, 3);
  assert.deepEqual(g.pages[1].thumb, {
    url: "/api/stream?site=t&u=" + encodeURIComponent("https://cdn.test/sheet.webp"),
    w: 200,
    h: 283,
    x: 200,
    y: 0,
  });
  assert.equal(g.pages[0].thumb.x, 0);
  // A plain <img> thumbnail needs no geometry — it is just a URL.
  assert.deepEqual(Object.keys(g.pages[2].thumb), ["url"]);
});

test("extractTagLinks turns a tag href into a query that actually matches", () => {
  const $ = cheerio.load(`<div id="taglist">
    <a href="https://exhentai.org/tag/female:sole+female">sole female</a>
    <a href="https://exhentai.org/tag/group:ensemble">ensemble</a>
    <a href="https://exhentai.org/tag/misc">misc</a>
    <a href="/nope">not a tag link</a>
  </div>`);
  const tags = extractTagLinks($, "#taglist a");
  // the namespace lives in the href, not the text, and the value needs anchoring —
  // a bare `female:sole female` degrades into two loose keywords upstream
  assert.deepEqual(tags.slice(0, 3), [
    { text: "sole female", q: 'female:"sole female$"' },
    { text: "ensemble", q: 'group:"ensemble$"' },
    { text: "misc", q: '"misc$"' },
  ]);
  assert.equal(tags[3].q, "not a tag link", "no /tag/ in the href: fall back to the text");
});

test("runMatchers: selector then regex, protocol-relative URLs resolved", async () => {
  const rule = { id: "t", baseUrl: "https://x.test", allowedHosts: ["x.test"] };
  const found = await runMatchers(rule, [{ from: "selector", selector: "video source@src" }], HTML, "https://x.test/watch");
  assert.equal(found, "https://cdn.example.com/x.mp4");

  const viaRegex = await runMatchers(
    rule,
    [{ from: "selector", selector: ".missing@src" }, { from: "regex", regex: "(https?:[^\"']+\\.m3u8[^\"']*)", group: 1 }],
    'var s = "https://cdn.example.com/a/index.m3u8?token=1";',
    "https://x.test/watch"
  );
  assert.equal(viaRegex, "https://cdn.example.com/a/index.m3u8?token=1");

  // A rule with a broken regex must be skipped, not crash the request
  assert.equal(await runMatchers(rule, [{ from: "regex", regex: "([" }], HTML, "https://x.test/"), null);
});

test("buildUrl encodes keywords but not page numbers", () => {
  assert.equal(buildUrl("/s?q={kw}&p={page}", { kw: "a b&c", page: 3 }), "/s?q=a%20b%26c&p=3");
  assert.equal(buildUrl("/g/{id}/", { id: "12/ab" }), "/g/12/ab/");
  assert.equal(absUrl("https://x.test/a/b", "../c.jpg"), "https://x.test/c.jpg");
});

test("JSON paths with array indexes and || fallbacks", () => {
  const doc = { data: [{ id: 7, file: { url: "u" } }], meta: { next: "cur" } };
  assert.equal(getPath(doc, "data[0].id"), 7);
  assert.equal(getPath(doc, "meta.next"), "cur");
  assert.equal(jsonField(doc.data[0], "missing||file.url"), "u");
  assert.equal(jsonField(doc.data[0], "nope"), undefined);
});

test("m3u8 rewriting sends every segment and key back through the proxy", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"/api/hls/key/9\",IV=0x0",
    "#EXTINF:4.0,",
    "seg_000.ts",
    "#EXTINF:4.0,",
    "https://cdn.example.com/seg_001.ts",
    "",
  ].join("\n");
  const out = rewriteM3u8(playlist, "https://cdn.example.com/hls/33/index.m3u8", "ttvlog");
  assert.match(out, /URI="\/api\/stream\?site=ttvlog&u=https%3A%2F%2Fcdn\.example\.com%2Fapi%2Fhls%2Fkey%2F9"/);
  assert.match(out, /^\/api\/stream\?site=ttvlog&u=https%3A%2F%2Fcdn\.example\.com%2Fhls%2F33%2Fseg_000\.ts$/m);
  assert.match(out, /u=https%3A%2F%2Fcdn\.example\.com%2Fseg_001\.ts/);
  assert.equal(out.split("\n")[0], "#EXTM3U");
});

test("SSRF guard: private ranges and the allowlist", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(ipIsPrivate(ip), true, ip + " must be considered private");
  }
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700::1111"]) {
    assert.equal(ipIsPrivate(ip), false, ip + " is public");
  }
  assert.equal(hostMatches("cdn.iwara.tv", ["iwara.tv"]), true);
  assert.equal(hostMatches("iwara.tv", ["*.iwara.tv"]), true);
  assert.equal(hostMatches("eviliwara.tv", ["iwara.tv"]), false);

  const rule = { allowedHosts: ["example.com"] };
  assert.throws(() => assertHostAllowed(rule, "https://evil.test/x"), /allowlist/);
  assert.throws(() => assertHostAllowed(rule, "https://127.0.0.1/x"), /private/);
  assert.throws(() => assertPublicUrl("file:///etc/passwd"), /protocol/);
  assert.equal(assertHostAllowed(rule, "https://a.example.com/x").hostname, "a.example.com");
});

test("TtlCache expires, evicts and coalesces concurrent misses", async () => {
  const c = new TtlCache({ max: 2, ttl: 20 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), undefined, "oldest entry evicted at max size");
  assert.equal(c.get("c"), 3);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.get("c"), undefined, "entries expire");

  let calls = 0;
  const slow = () => new Promise((r) => setTimeout(() => r(++calls), 20));
  const [x, y, z] = await Promise.all([c.cached("k", slow), c.cached("k", slow), c.cached("k", slow)]);
  assert.deepEqual([x, y, z], [1, 1, 1]);
  assert.equal(calls, 1, "three simultaneous misses cause one upstream fetch");
});

test("rule validation explains what is wrong", () => {
  assert.throws(() => validateRule({}), /id/);
  assert.throws(() => validateRule({ id: "a", name: "A" }), /baseUrl/);
  assert.throws(() => validateRule({ id: "a", name: "A", baseUrl: "https://x.t" }), /allowedHosts/);
  assert.throws(() => validateRule({ id: "a", name: "A", baseUrl: "https://x.t", allowedHosts: ["x.t"], gallery: true }), /galleryRule/);
  assert.throws(
    () => validateRule({ id: "a", name: "A", baseUrl: "https://x.t", allowedHosts: ["x.t"], idRegex: "([" }),
    /正则/
  );
  validateRule({ id: "a", name: "A", baseUrl: "https://x.t", allowedHosts: ["x.t"] });
});

test("secrets are redacted on the way out and restored on the way in", () => {
  const rule = { id: "a", name: "A", baseUrl: "https://x.t", allowedHosts: ["x.t"], headers: { Cookie: "secret", "User-Agent": "UA" } };
  const shown = redactRule(rule);
  assert.equal(shown.headers.Cookie, "***");
  assert.equal(shown.headers["User-Agent"], "UA");
  const merged = mergeSecrets(JSON.parse(JSON.stringify(shown)), rule);
  assert.equal(merged.headers.Cookie, "secret", "editing a rule must not wipe its session cookie");
});

test("publicSite exposes metadata but never headers", () => {
  const site = publicSite({
    id: "a",
    name: "A",
    baseUrl: "https://x.t",
    type: "image",
    gallery: true,
    search: {},
    imageRule: {},
    headers: { Cookie: "s" },
    discover: [{ name: "最新" }, {}, { name: "GameCG", searchUrl: "https://x.t/?f_search={kw}&f_cats=1007" }],
  });
  assert.equal(site.hasSearch, true);
  assert.equal(site.resolvesImages, true);
  // searchScoped tells the reader which tabs can confine a search to themselves
  assert.deepEqual(site.categories, [
    { index: 0, name: "最新", searchScoped: false },
    { index: 1, name: "分类 2", searchScoped: false },
    { index: 2, name: "GameCG", searchScoped: true },
  ]);
  assert.equal("headers" in site, false);
});
