// What a rule is allowed to say, and what the frontend is allowed to see of it.
//
// The format is deliberately unchanged from v1 — every rule that worked before keeps
// working — but validation now explains *why* something is rejected, and the public
// projection is derived in one place instead of being guessed at three call sites.

import { httpErr } from "../lib/errors.js";

const ID_RE = /^[a-z0-9_-]+$/i;

/** Throws HttpError(400) with a message aimed at whoever is writing the rule. */
export function validateRule(r) {
  const fail = (m) => {
    throw httpErr(400, "规则无效:" + m, "invalid_rule");
  };
  if (!r || typeof r !== "object" || Array.isArray(r)) fail("规则必须是一个 JSON 对象");
  if (!r.id || !ID_RE.test(r.id)) fail("id 必须存在且只含字母/数字/下划线/连字符");
  if (!r.name) fail("缺少 name");
  if (!r.baseUrl || !/^https?:\/\//i.test(r.baseUrl)) fail("baseUrl 必须是 http(s) 开头的地址");
  if (!Array.isArray(r.allowedHosts) || r.allowedHosts.length === 0) {
    fail("allowedHosts 必须是非空数组 —— 这是本服务器唯一的出站白名单");
  }
  if (r.type && r.type !== "video" && r.type !== "image") fail('type 只能是 "video" 或 "image"');
  if (r.discover && !Array.isArray(r.discover)) fail("discover 必须是数组");
  for (const [i, cat] of (r.discover || []).entries()) {
    if (!cat || typeof cat !== "object") fail(`discover[${i}] 必须是对象`);
    const hasSource = cat.url || cat.params || r.provider;
    if (!hasSource) fail(`discover[${i}] 需要 url(或 provider 规则的 params)`);
  }
  if (r.search && typeof r.search !== "object") fail("search 必须是对象");
  if (r.gallery && !r.galleryRule) fail("gallery:true 的规则需要 galleryRule 配置");
  for (const key of ["idRegex", "excludeTitle"]) {
    if (r[key]) {
      try {
        new RegExp(r[key]);
      } catch (e) {
        fail(`${key} 不是合法正则:${e.message}`);
      }
    }
  }
  for (const m of (r.video && r.video.match) || []) {
    if (m && m.from === "regex" && m.regex) {
      try {
        new RegExp(m.regex, m.flags || "i");
      } catch (e) {
        fail(`video.match 正则不合法:${e.message}`);
      }
    }
  }
  return r;
}

/** Fill in the defaults the engine relies on, without mutating the caller's object. */
export function normalizeRule(rule) {
  const r = JSON.parse(JSON.stringify(rule));
  r.type = r.type === "image" ? "image" : "video";
  r.gallery = !!r.gallery;
  r.discover = Array.isArray(r.discover) ? r.discover : [];
  r.allowedHosts = r.allowedHosts.map((h) => String(h).trim()).filter(Boolean);
  r.version = r.version || 1;
  return r;
}

const SECRET_HEADER = /^(authorization|cookie|x-api-key|api-key|token)$/i;

/** The rule as the rules screen may see it: secrets masked, everything else intact. */
export function redactRule(rule) {
  const c = JSON.parse(JSON.stringify(rule));
  if (c.headers) for (const k of Object.keys(c.headers)) if (SECRET_HEADER.test(k)) c.headers[k] = "***";
  return c;
}

/** Re-attach the real secrets when an edited rule comes back with the "***" placeholder. */
export function mergeSecrets(incoming, previous) {
  if (!previous || !previous.headers || !incoming || !incoming.headers) return incoming;
  for (const k of Object.keys(incoming.headers)) {
    if (incoming.headers[k] === "***" && previous.headers[k] != null) incoming.headers[k] = previous.headers[k];
  }
  return incoming;
}

/** Safe-to-expose site metadata: what the library UI needs to render a site. */
export function publicSite(r) {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.baseUrl,
    type: r.type || "video",
    gallery: !!r.gallery,
    hasSearch: !!r.search,
    canFavorite: !!(r.favorite && r.favorite.url),
    // image sites need a second round-trip (post page / API) to get the full-size file
    resolvesImages: !!(r.imageRule || r.provider),
    // Which files this site can serve for one page. exhentai has a cheap 1280px sample
    // and an expensive full-resolution original; the reader offers a switch only when
    // the rule actually tags a matcher for the variant.
    variants: [...new Set((((r.imageRule || {}).match) || []).map((m) => m && m.variant).filter(Boolean))],
    proxied: !!r.provider,
    categories: (r.discover || []).map((d, i) => ({
      index: i,
      name: d.name || `分类 ${i + 1}`,
      // can a search be confined to this category? drives the reader's in-category search
      searchScoped: !!d.searchUrl,
    })),
  };
}
