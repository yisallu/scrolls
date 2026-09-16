// Sites that expose a JSON API instead of HTML (Sankaku's keyset endpoint, …).
// The rule maps API field names onto our normalized item shape, and keyset cursors
// replace page numbers so deep paging stays correct while new posts arrive.

import { buildUrl, getPath, jsonField, absUrl } from "./dsl.js";
import { fetchJson } from "../lib/fetcher.js";
import { proxiedMediaUrl, isProxiedUrl } from "../media/url.js";

export function mapJsonItem(rule, item, fields = {}) {
  const id = jsonField(item, fields.id);
  const proxied = (u) => {
    if (!u) return "";
    const abs = absUrl(rule.baseUrl, u);
    // JSON media hosts nearly always check Referer, so proxying is the default here
    // (opt out with "proxyImages": false).
    return rule.proxyImages !== false && !isProxiedUrl(abs) ? proxiedMediaUrl(rule.id, abs) : abs;
  };
  const cover = proxied(jsonField(item, fields.thumb));
  const image = proxied(jsonField(item, fields.image));
  const tags = jsonField(item, fields.tags);
  return {
    id: id == null ? "" : String(id),
    title: jsonField(item, fields.title) || (id != null ? "#" + id : "(无标题)"),
    cover: cover || "",
    image: image || cover || "",
    fileType: jsonField(item, fields.fileType) || "",
    width: Number(jsonField(item, fields.width)) || 0,
    height: Number(jsonField(item, fields.height)) || 0,
    duration: Number(jsonField(item, fields.duration)) || 0,
    tags: Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/\s+/).filter(Boolean) : [],
    link: rule.postUrl && id != null ? rule.postUrl.replace("{id}", encodeURIComponent(id)) : "",
  };
}

/**
 * One page of a JSON listing.
 * @param {object} cfg { items, next, cursorParam, fields }
 */
export async function jsonList(rule, urlTemplate, cfg, { kw, cursor } = {}) {
  let url = buildUrl(urlTemplate, { kw: kw || "", page: 1 });
  if (cursor) url += (url.includes("?") ? "&" : "?") + (cfg.cursorParam || "next") + "=" + encodeURIComponent(cursor);
  const { json } = await fetchJson(rule, url);
  const arr = getPath(json, cfg.items);
  const items = (Array.isArray(arr) ? arr : [])
    .map((it) => mapJsonItem(rule, it, cfg.fields))
    .filter((x) => x.cover || x.image);
  const next = cfg.next ? getPath(json, cfg.next) : null;
  return { items, cursor: next || null, hasNext: !!next && items.length > 0 };
}
