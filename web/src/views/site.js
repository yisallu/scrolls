// Browsing one site: its categories, your saved-search tabs, and the grid.
// A saved tab is just a keyword rendered as a category — the trick that makes a
// scraper feel like it has the sections *you* care about, not the ones the site ships.

import { h } from "../dom.js";
import api from "../api.js";
import { loadSites, loadLibrary, siteById, savedSearches, addSavedSearch, removeSavedSearch, setLastSite, state } from "../state.js";
import { paginatedGrid } from "../ui/grid.js";
import { openViewer } from "../ui/viewer.js";
import { askText, toast } from "../ui/toast.js";

/** Image tiles either open the reader (galleries), the player (videos) or the viewer. */
export function openImageItem(site, items, index, navigate) {
  const item = items[index];
  // Where we are standing, so the reader can offer a way back to this exact listing —
  // the right category, the right search — instead of dumping you on the site's front page.
  const from = encodeURIComponent(location.pathname + location.search);
  if (item.gallery || site.gallery) {
    navigate(
      `/read?site=${encodeURIComponent(site.id)}&id=${encodeURIComponent(item.id)}` +
        `&title=${encodeURIComponent(item.title || "")}&from=${from}`
    );
    return;
  }
  if (String(item.fileType || "").startsWith("video")) {
    const q = new URLSearchParams({ site: site.id, id: item.id, title: item.title || "" });
    if (item.cover) q.set("cover", item.cover);
    navigate(`/watch?${q}`);
    return;
  }
  openViewer({ items, index, site });
}

export default async function siteView(ctx) {
  await Promise.all([loadSites(), loadLibrary()]);
  const site = siteById(ctx.params.site) || state.sites[0];
  if (!site) return h("div.empty", h("h2", "还没有站点"), h("a.btn.solid", { href: "/rules" }, "去添加规则"));
  setLastSite(site.id);

  const cat = parseInt(ctx.query.get("cat") || "0", 10) || 0;
  const q = ctx.query.get("q") || "";

  const gridHost = h("div");
  const chips = h("div.chips");

  const chip = (label, href, active, onDelete) =>
    h(
      "a.chip",
      { href, class: active ? "active" : "" },
      label,
      onDelete
        ? h("span.x", {
            title: "删除标签页",
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            },
          }, "✕")
        : null
    );

  function paintChips() {
    chips.replaceChildren();
    for (const c of site.categories) {
      chips.appendChild(chip(c.name, `/s/${encodeURIComponent(site.id)}?cat=${c.index}`, !q && c.index === cat));
    }
    for (const s of savedSearches(site.id)) {
      chips.appendChild(
        chip(s.kw, `/s/${encodeURIComponent(site.id)}?q=${encodeURIComponent(s.kw)}`, q === s.kw, async () => {
          await removeSavedSearch(site.id, s.kw);
          if (q === s.kw) ctx.navigate(`/s/${encodeURIComponent(site.id)}`, { replace: true });
          else paintChips();
        })
      );
    }
    if (site.hasSearch) {
      chips.appendChild(
        h(
          "button.chip.dashed",
          {
            title: "把一个搜索关键词固定成标签页",
            onclick: async () => {
              const kw = await askText({ title: "把关键词存成标签页", placeholder: "例如 pov" });
              if (!kw) return;
              await addSavedSearch(site.id, kw);
              toast("已添加标签页");
              ctx.navigate(`/s/${encodeURIComponent(site.id)}?q=${encodeURIComponent(kw)}`);
            },
          },
          "＋ 标签页"
        )
      );
    }
  }
  paintChips();

  const load = (params) =>
    q
      ? api.search({ site: site.id, kw: q, ...params }, ctx.signal)
      : api.discover({ site: site.id, cat, ...params }, ctx.signal);

  // No page title here on purpose: the top bar already says which site you are on,
  // and a heading that repeats it just pushes the grid down.
  const root = h("div", h("div.catbar", chips), gridHost);

  const grid = paginatedGrid({
    host: gridHost,
    site,
    load,
    signal: ctx.signal,
    onOpenImage: (items, index) => openImageItem(site, items, index, ctx.navigate),
  });
  root.__cleanup = () => grid.destroy();
  return root;
}
