// A title's page: poster, synopsis, tags, episode list.
// Single-episode content skips this screen entirely (most sites here are one video per
// page) — with replace:true, so Back returns to the grid instead of bouncing through
// an auto-playing detail page forever.

import { h, cssUrl } from "../dom.js";
import api from "../api.js";
import { loadSites, loadLibrary, siteById, entryKey, isFavorite, toggleFavorite, setLastSite } from "../state.js";
import { toast } from "../ui/toast.js";

export const watchHref = ({ site, url, detailUrl, title }) => {
  const q = new URLSearchParams({ site, url });
  if (detailUrl) q.set("d", detailUrl);
  if (title) q.set("title", title);
  return `/watch?${q}`;
};

export default async function detailView(ctx) {
  await Promise.all([loadSites(), loadLibrary()]);
  const siteId = ctx.query.get("site");
  const url = ctx.query.get("url");
  const site = siteById(siteId);
  if (!site || !url) return h("div.empty", h("h2", "缺少参数"), h("a.btn", { href: "/" }, "回到首页"));
  setLastSite(site.id);

  const d = await api.detail({ site: site.id, url }, ctx.signal);

  if (d.episodes.length === 1) {
    ctx.navigate(watchHref({ site: site.id, url: d.episodes[0].url, detailUrl: url, title: d.title }), { replace: true });
    return h("div.loading", "解析中…");
  }

  const entry = { site: site.id, url, title: d.title, cover: d.cover, kind: "video" };
  const favBtn = h("button.btn", { onclick: onFav }, isFavorite(entryKey(entry)) ? "★ 已收藏" : "☆ 收藏");
  async function onFav() {
    const on = await toggleFavorite(entry);
    favBtn.textContent = on ? "★ 已收藏" : "☆ 收藏";
    toast(on ? "已收藏" : "已取消收藏");
  }

  const eps = h(
    "div.eps",
    d.episodes.map((ep) =>
      h("a.btn", { href: watchHref({ site: site.id, url: ep.url, detailUrl: url, title: d.title }), title: ep.title }, ep.title)
    )
  );

  return h(
    "div",
    h("a.backlink", { href: `/s/${encodeURIComponent(site.id)}` }, "← 返回片库"),
    h(
      "div.detail",
      h("div.poster", { style: d.cover ? { backgroundImage: cssUrl(d.cover) } : {} }),
      h(
        "div",
        h("h1", d.title || "未命名"),
        d.intro ? h("p.intro", d.intro) : null,
        h("div.actions", favBtn, h("a.btn.ghost", { href: d.url || url, target: "_blank", rel: "noreferrer noopener" }, "原页面 ↗")),
        d.tags.length
          ? h(
              "div.taglist",
              d.tags.map((t) => h("a", { href: `/search?site=${encodeURIComponent(site.id)}&kw=${encodeURIComponent(t)}` }, t))
            )
          : null
      )
    ),
    h("div.section-head", h("h2", "剧集"), h("span.sub", `${d.episodes.length} 集`)),
    d.episodes.length ? eps : h("div.note", "没有解析到剧集 —— 可能要调整该规则的 detail.episodes 选择器。")
  );
}
