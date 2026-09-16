// Turning a fetched HTML page into the normalized shapes the API promises:
// listings, detail pages, gallery indexes, and the "find the playable file" matchers.

import * as cheerio from "cheerio";
import { absUrl, field, numericField, pluck, safeRegExp, getPath } from "./dsl.js";
import { proxiedMediaUrl, isProxiedUrl } from "../media/url.js";
import { fetchText } from "../lib/fetcher.js";

export const load = (html) => cheerio.load(html);

const MAX_ITEMS = 240; // one page of a listing; anything beyond this is a runaway selector

/** Route a cover through our proxy when the site hot-link-protects its CDN. */
function coverUrl(rule, pageUrl, raw) {
  if (!raw) return "";
  const abs = absUrl(pageUrl, raw);
  return rule && rule.proxyImages && !isProxiedUrl(abs) ? proxiedMediaUrl(rule.id, abs) : abs;
}

/**
 * A listing page → items. `list` is { item, title, url, cover, width, height, duration, badge }.
 * Items are de-duplicated by URL: several real sites emit the same card twice (a
 * mobile and a desktop variant), which used to show up as duplicate tiles in the grid.
 */
export function extractList($, listCfg, pageUrl, rule) {
  const items = [];
  if (!listCfg || !listCfg.item) return items;
  const seen = new Set();
  // rule.excludeTitle drops junk by title before it ever reaches the grid. Applied here
  // because this is the one function every listing goes through — discover, search, and
  // every category, on image and video sites alike.
  const exclude = rule && rule.excludeTitle ? safeRegExp(rule.excludeTitle, "i") : null;
  let dropped = 0;
  $(listCfg.item).each((_i, el) => {
    if (items.length >= MAX_ITEMS) return false;
    const node = $(el);
    const title = field($, node, listCfg.title);
    const url = absUrl(pageUrl, field($, node, listCfg.url));
    if (!title && !url) return;
    if (exclude && title && exclude.test(title)) {
      dropped++;
      return;
    }
    if (url) {
      if (seen.has(url)) return;
      seen.add(url);
    }
    const item = {
      title: title || "(无标题)",
      url,
      cover: coverUrl(rule, pageUrl, field($, node, listCfg.cover)),
    };
    const width = numericField($, node, listCfg.width, "width");
    const height = numericField($, node, listCfg.height, "height");
    if (width) item.width = width;
    if (height) item.height = height;
    const duration = listCfg.duration ? field($, node, listCfg.duration) : "";
    if (duration) item.duration = duration.replace(/\s+/g, " ").trim().slice(0, 16);
    const badge = listCfg.badge ? field($, node, listCfg.badge) : "";
    if (badge) item.badge = badge.replace(/\s+/g, " ").trim().slice(0, 24);
    items.push(item);
  });
  // Not silent: the caller reports it, so "why are there only 4 results" has an answer.
  items.dropped = dropped;
  return items;
}

/** Tag lists: either a selector string, or { item, strip } where strip is a cleanup regex. */
export function extractTags($, spec, limit = 80) {
  if (!spec) return [];
  const item = typeof spec === "string" ? spec : spec.item;
  if (!item) return [];
  const strip = typeof spec === "object" && spec.strip ? safeRegExp(spec.strip, "g") : null;
  const out = [];
  const seen = new Set();
  $(item).each((_i, el) => {
    if (out.length >= limit) return false;
    let t = ($(el).text() || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    if (strip) t = t.replace(strip, "").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  });
  return out;
}

/**
 * Tags with the query that finds more of them. The visible text is only the tag's name
 * ("blowjob"), while the href carries the namespace ("/tag/female:blowjob") — and the
 * namespaced, anchored form is the one that actually matches: on exhentai
 * `female:"sole female$"` returns a different (correct) set from a loose `sole female`.
 */
export function extractTagLinks($, spec, limit = 60) {
  const item = typeof spec === "string" ? spec : spec && spec.item;
  if (!item) return [];
  const out = [];
  const seen = new Set();
  $(item).each((_i, el) => {
    if (out.length >= limit) return false;
    const node = $(el);
    const text = (node.text() || "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) return;
    const href = node.attr("href") || "";
    const m = /\/tag\/([^/?#]+)/.exec(href);
    let q = text;
    if (m) {
      const full = decodeURIComponent(m[1]).replace(/\+/g, " ");
      const c = full.indexOf(":");
      // anchored + quoted, or a two-word value degrades into two loose keywords
      q = c > 0 ? `${full.slice(0, c)}:"${full.slice(c + 1)}$"` : `"${full}$"`;
    }
    seen.add(text);
    out.push({ text, q });
  });
  return out;
}

export function extractDetail($, rule, finalUrl) {
  const d = rule.detail || {};
  const out = {
    title: field($, null, d.title),
    cover: coverUrl(rule, finalUrl, field($, null, d.cover)),
    intro: field($, null, d.intro),
    url: finalUrl,
    episodes: [],
    tags: extractTags($, d.tags),
  };
  const ep = d.episodes;
  if (ep && ep.item) {
    $(ep.item).each((_i, el) => {
      const node = $(el);
      const u = absUrl(finalUrl, field($, node, ep.url));
      if (!u) return;
      out.episodes.push({ title: field($, node, ep.title) || `第 ${out.episodes.length + 1} 集`, url: u });
    });
  }
  return out;
}

/**
 * One page's thumbnail on a gallery index. Two shapes exist in the wild:
 *
 *   <a><img src="thumb.jpg"></a>                                  one file per page
 *   <a><div style="…url(sheet.webp) -200px 0 no-repeat"></div>    a CSS sprite sheet
 *
 * exhentai ships the second by default: twenty pages share ONE sheet image, each cell
 * addressed by background-position. That is why this returns geometry and not just a
 * URL — the reader's filmstrip has to draw one cell out of a sheet, and it is also why
 * a strip of 20 thumbnails costs a single image request instead of twenty.
 */
function pageThumb($, el, finalUrl, rule) {
  const node = $(el);
  const direct = node.find("img").attr("src") || node.find("img").attr("data-src") || "";
  if (direct) return { url: coverUrl(rule, finalUrl, direct) };

  const styled = node.is("[style*='url(']") ? node : node.find("[style*='url(']").first();
  const style = (styled.length ? styled.attr("style") : "") || "";
  const m = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/.exec(style);
  if (!m) return null;
  const px = (re) => {
    const x = re.exec(style);
    return x ? Math.round(parseFloat(x[1])) : 0;
  };
  // The two lengths right after url(...) are the background-position; they are negative
  // (the sheet is pulled left), so flip the sign into an offset INTO the sheet.
  const pos = /url\([^)]*\)\s*(-?[\d.]+)px\s+(-?[\d.]+)(?:px)?/.exec(style);
  const thumb = {
    url: coverUrl(rule, finalUrl, m[1]),
    w: px(/(?:^|;)\s*width\s*:\s*(-?[\d.]+)px/i),
    h: px(/(?:^|;)\s*height\s*:\s*(-?[\d.]+)px/i),
    // `|| 0` is not redundant: Math.round(-0) is -0, which survives JSON and reads oddly.
    x: pos ? Math.round(-parseFloat(pos[1])) || 0 : 0,
    y: pos ? Math.round(-parseFloat(pos[2])) || 0 : 0,
  };
  return thumb.w && thumb.h ? thumb : { url: thumb.url };
}

/** A gallery index page (exhentai-style): its pages, title, tags and total count. */
export function extractGallery($, galleryCfg, finalUrl, rule = null) {
  const g = galleryCfg;
  const title = field($, null, g.title);
  let total = 0;
  if (g.count) {
    const text = field($, null, g.count) || "";
    // "Showing 1-20 of 1,234 images" — the count we want is the one after "of"
    const m = /of\s+([\d,]+)/i.exec(text) || /([\d,]+)\s*(?:pages|images|张|页)/i.exec(text);
    if (m) total = parseInt(m[1].replace(/,/g, ""), 10) || 0;
  }
  const pages = [];
  if (g.item) {
    $(g.item).each((_i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const abs = absUrl(finalUrl, href);
      let id = abs;
      try {
        id = new URL(abs).pathname; // page ids are path-shaped; keeps them short in URLs
      } catch {
        /* keep the absolute URL */
      }
      const thumb = pageThumb($, el, finalUrl, rule);
      pages.push(thumb ? { id, thumb } : { id });
    });
  }
  return { title, tags: extractTags($, g.tags), tagLinks: extractTagLinks($, g.tags), total, pages };
}

/**
 * "Where is the actual file?" — a list of strategies tried in order:
 *   { from:"selector", selector } | { from:"regex", regex, flags, group }
 *   { from:"json", path }         | { from:"iframe", selector, then }
 * The iframe strategy re-fetches the embed page and recurses (depth-capped).
 */
export async function runMatchers(rule, matchers, html, pageUrl, depth = 0) {
  if (depth > 3 || !matchers || !matchers.length) return null;
  const $ = load(html);
  for (const m of matchers) {
    let cand = "";
    if (!m || !m.from) continue;
    if (m.from === "selector") {
      cand = field($, null, m.selector);
    } else if (m.from === "regex") {
      const re = safeRegExp(m.regex, m.flags || "i");
      if (!re) continue;
      const mm = re.exec(html);
      if (mm) cand = (m.group != null ? mm[m.group] : mm[1] || mm[0]) || "";
      if (cand) cand = cand.replace(/\\\//g, "/"); // JSON-escaped slashes inside inline scripts
    } else if (m.from === "json") {
      try {
        const v = getPath(JSON.parse(html), m.path);
        cand = v == null ? "" : String(v);
      } catch {
        continue;
      }
    } else if (m.from === "iframe") {
      const iframeUrl = field($, null, m.selector);
      if (!iframeUrl) continue;
      try {
        const sub = await fetchText(rule, absUrl(pageUrl, iframeUrl));
        const next = m.then ? [m.then] : (rule.video && rule.video.match) || [];
        const r = await runMatchers(rule, next, sub.text, sub.url, depth + 1);
        if (r) return r;
      } catch {
        /* embed unreachable — try the next strategy */
      }
      continue;
    }
    if (cand) return absUrl(pageUrl, cand);
  }
  return null;
}

export { pluck, field };
