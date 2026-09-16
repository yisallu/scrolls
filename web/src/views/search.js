import { h } from "../dom.js";
import api from "../api.js";
import { loadSites, loadLibrary, siteById, addSavedSearch, setLastSite } from "../state.js";
import { paginatedGrid } from "../ui/grid.js";
import { toast } from "../ui/toast.js";
import { openImageItem } from "./site.js";

export default async function searchView(ctx) {
  await Promise.all([loadSites(), loadLibrary()]);
  const siteId = ctx.query.get("site") || "";
  const kw = ctx.query.get("kw") || "";
  const site = siteById(siteId);
  if (!site) return h("div.empty", h("h2", "请先选择一个站点"), h("p", "搜索是在单个站点内进行的。"));
  setLastSite(site.id);

  // Only honour a category the site can actually search inside; anything else would
  // silently return whole-site results under a heading promising otherwise.
  const rawCat = ctx.query.get("cat");
  const scope =
    rawCat == null ? null : site.categories?.find((c) => c.index === parseInt(rawCat, 10) && c.searchScoped) || null;

  const gridHost = h("div");
  const root = h(
    "div",
    h(
      "div.page-head",
      h("h1", `搜索:${kw}`),
      h("span.sub", scope ? `${site.name} · ${scope.name}` : site.name),
      h("span.grow"),
      h(
        "button.btn.sm",
        {
          onclick: async () => {
            await addSavedSearch(site.id, kw);
            toast("已存为标签页");
          },
        },
        "＋ 存为标签页"
      ),
      scope
        ? h(
            "a.btn.sm",
            { href: `/search?site=${encodeURIComponent(site.id)}&kw=${encodeURIComponent(kw)}` },
            "全站搜索"
          )
        : null
    ),
    gridHost
  );

  const grid = paginatedGrid({
    host: gridHost,
    site,
    signal: ctx.signal,
    emptyHint: scope
      ? `「${scope.name}」分类下没有匹配的结果。换个词,或到全站搜索再试。`
      : "这个站点没有匹配的结果。换个词,或确认该站点的搜索规则是否仍然有效。",
    load: (params) => api.search({ site: site.id, kw, ...(scope ? { cat: scope.index } : {}), ...params }, ctx.signal),
    onOpenImage: (items, index) => openImageItem(site, items, index, ctx.navigate),
  });
  root.__cleanup = () => grid.destroy();
  return root;
}
