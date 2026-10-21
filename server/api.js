// The JSON API. Every handler is a thin shell: validate the query, call the engine or
// a store, return a plain object. Errors are thrown as HttpError and formatted centrally.

import { Router, rateLimit, readJsonBody } from "./lib/router.js";
import { httpErr } from "./lib/errors.js";
import config from "./config.js";
import { openUpstream, readAll, buildHeaders } from "./lib/fetcher.js";
import { providerHealthy } from "./engine/provider.js";
import { redactRule } from "./engine/rule-schema.js";
import { w2xCacheKey } from "./media/page.js";

export function createApiRouter({ rules, engine, prefs, library, pageCache = null, w2x = null, startedAt }) {
  const api = new Router({ prefix: "/api" });

  api.use(rateLimit({ ...config.rateLimit.api, name: "api" }));
  api.use((ctx) => {
    // Everything here is live scraped data or user state — never let a proxy cache it.
    ctx.res.setHeader("Cache-Control", "no-store");
  });

  const site = (ctx) => rules.require(ctx.q("site"));
  const optionalInt = (ctx, name) => (ctx.query.has(name) ? ctx.int(name, undefined) : undefined);

  // ---- health / meta ----------------------------------------------------------

  api.get("/healthz", () => ({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000) }));

  api.get("/stats", async () => ({
    ok: true,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    sites: rules.all().length,
    cache: engine.stats(),
    sidecar: rules.all().some((r) => r.provider) ? await providerHealthy() : null,
    pageCache: pageCache ? pageCache.stats() : null,
    w2x: w2x ? w2x.stats() : null,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  }));

  api.get("/sites", () => rules.listSites());

  // Is the desktop GPU worker connected? The reader greys out waifu2x when it is not,
  // rather than queueing work nobody will ever pick up.
  api.get("/w2x/online", () => ({ online: !!w2x && w2x.online, ...(w2x ? w2x.stats() : {}) }));

  // The reader opened a page that a prefetch already queued at the back. Pull it
  // forward. The image URL itself does not change, so this is a separate call.
  api.get("/w2x/focus", (ctx) => {
    if (!w2x) return { ok: false };
    const site = ctx.q("site");
    const id = ctx.q("id");
    if (!site || !id) throw httpErr(400, "缺少 id", "bad_request");
    const { key } = w2xCacheKey(site, id, {
      model: ctx.q("model"),
      noise: ctx.query.has("noise") ? ctx.q("noise") : undefined,
      scale: ctx.query.has("scale") ? ctx.q("scale") : undefined,
    });
    const priority = Math.max(0, Math.min(2, ctx.int("priority", 2)));
    return { ok: w2x.boost(key, priority) };
  });

  // ---- browsing ----------------------------------------------------------------

  api.get("/discover", (ctx) =>
    engine.discover(site(ctx), { cat: ctx.int("cat", 0), page: optionalInt(ctx, "page"), cursor: ctx.q("cursor", null) })
  );

  api.get("/search", (ctx) =>
    engine.search(site(ctx), {
      kw: ctx.q("kw").trim(),
      page: optionalInt(ctx, "page"),
      cursor: ctx.q("cursor", null),
      cat: optionalInt(ctx, "cat"),
    })
  );

  api.get("/detail", (ctx) => engine.detail(site(ctx), ctx.q("url")));

  api.get("/resolve", (ctx) => engine.resolve(site(ctx), ctx.q("url")));

  api.get("/image", (ctx) => engine.resolveImage(site(ctx), ctx.q("id"), { variant: ctx.q("v") }));

  api.get("/gallery", (ctx) => engine.gallery(site(ctx), ctx.q("id"), optionalInt(ctx, "page")));

  // ---- favourites on the site's own account ---------------------------------------

  api.get("/favorite", (ctx) => engine.favoriteState(site(ctx), ctx.q("id")));

  api.post("/favorite", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const rule = rules.require(body.site || ctx.q("site"));
    const id = body.id || ctx.q("id");
    // `cat: null` means remove; anything else is the folder to file it under. Note the
    // `in` test: `body.cat ?? "0"` would turn an explicit null back into folder 0, i.e.
    // silently move the gallery instead of removing it.
    const cat = body && "cat" in body ? body.cat : "0";
    return engine.setFavorite(rule, id, { cat, note: body.note || "" });
  });

  // ---- rules --------------------------------------------------------------------

  api.get("/rules", () => rules.listRules());

  api.get("/rules/:id", (ctx) => {
    const r = rules.get(ctx.params.id);
    if (!r) throw httpErr(404, "没有这条规则", "not_found");
    return redactRule(r);
  });

  api.post("/rules", async (ctx) => {
    let payload = await readJsonBody(ctx.req);
    if (!payload || typeof payload !== "object") throw httpErr(400, "请求体必须是规则 JSON", "bad_request");

    if (payload.url && !payload.id) {
      payload = await fetchRemoteRule(payload.url); // import by link
    } else if (typeof payload.json === "string") {
      try {
        payload = JSON.parse(payload.json);
      } catch (e) {
        throw httpErr(400, "规则 JSON 解析失败:" + e.message, "bad_request");
      }
    }
    const saved = await rules.save(payload);
    engine.invalidate(saved.id);
    return { ok: true, rule: redactRule(saved) };
  });

  api.delete("/rules/:id", async (ctx) => {
    const out = await rules.remove(ctx.params.id);
    engine.invalidate(ctx.params.id);
    return out;
  });

  // ---- player / UI preferences ----------------------------------------------------

  api.get("/prefs", (ctx) => prefs.get(ctx.q("key", "player")));
  api.put("/prefs", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    prefs.set(ctx.q("key", "player"), body);
    return { ok: true };
  });

  // ---- 我的片库: history, favourites, saved searches ---------------------------------

  api.get("/library", () => library.snapshot());

  api.post("/library/history", async (ctx) => {
    const entry = library.recordHistory(await readJsonBody(ctx.req));
    if (!entry) throw httpErr(400, "记录缺少 site 与 url/id", "bad_request");
    return { ok: true, entry };
  });

  api.delete("/library/history", (ctx) => {
    const key = ctx.q("key");
    return key ? library.removeHistory(key) : library.clearHistory();
  });

  api.get("/library/progress", (ctx) => library.progressFor(ctx.q("site"), ctx.q("ref")) || {});

  api.post("/library/favorites", async (ctx) => {
    const out = library.toggleFavorite(await readJsonBody(ctx.req));
    if (!out) throw httpErr(400, "收藏缺少 site 与 url/id", "bad_request");
    return out;
  });

  api.delete("/library/favorites", (ctx) => library.removeFavorite(ctx.q("key")));

  api.post("/library/searches", async (ctx) => {
    const b = (await readJsonBody(ctx.req)) || {};
    const out = library.addSavedSearch(b.site, b.kw);
    if (!out) throw httpErr(400, "需要 site 与 kw", "bad_request");
    return { ok: true, savedSearches: library.snapshot().savedSearches };
  });

  api.delete("/library/searches", (ctx) => {
    library.removeSavedSearch(ctx.q("site"), ctx.q("kw"));
    return { ok: true, savedSearches: library.snapshot().savedSearches };
  });

  return api;
}

/**
 * Import a rule from a link. This is the one fetch that has no rule to authorise it,
 * so the allowlist is built from the link's own host — it can reach that host and
 * nothing else, and the SSRF guard still rejects private addresses.
 */
async function fetchRemoteRule(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw httpErr(400, "规则链接不是合法 URL", "bad_request");
  }
  const syntheticRule = { id: "_import", allowedHosts: [host] };
  const { res } = await openUpstream(syntheticRule, url, {
    headers: buildHeaders(null, {}, { accept: "application/json,*/*" }),
  });
  if ((res.statusCode || 0) >= 400) {
    res.resume();
    throw httpErr(502, `拉取规则失败:HTTP ${res.statusCode}`, "upstream_failed");
  }
  const text = (await readAll(res, 1024 * 1024)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw httpErr(400, "链接返回的不是合法 JSON:" + e.message, "bad_request");
  }
}
