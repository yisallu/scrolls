// Home: what you were watching, what you kept, and where to go next.
// v1 opened straight into the first site's first category — useful once, then never
// again. A library should remember you.

import { h } from "../dom.js";
import { state, loadSites, loadLibrary } from "../state.js";
import { historyCard } from "../ui/cards.js";

const TYPE_LABEL = { video: "影片", image: "图集" };

function rail(title, entries, moreHref) {
  if (!entries.length) return null;
  return h(
    "section.section",
    h("div.section-head", h("h2", title), moreHref ? h("a.more", { href: moreHref }, "查看全部 →") : null),
    h("div.rail", entries.map((e) => historyCard(e, state.sites)))
  );
}

function siteTile(site) {
  const kinds = [TYPE_LABEL[site.type] || site.type, site.gallery ? "画廊" : null, site.hasSearch ? "可搜索" : null]
    .filter(Boolean)
    .join(" · ");
  return h(
    "a.card",
    { href: `/s/${encodeURIComponent(site.id)}` },
    h(
      "span.thumb",
      { style: { display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--panel-2), var(--bg-2))" } },
      h("span", { style: { fontSize: "17px", fontWeight: "700" } }, site.name)
    ),
    h("span.meta", { style: { marginTop: "9px" } }, kinds)
  );
}

export default async function homeView() {
  const [sites] = await Promise.all([loadSites(), loadLibrary()]);
  const { history, favorites } = state.library;

  if (!sites.length) {
    return h(
      "div.empty",
      h("h2", "还没有任何站点规则"),
      h("p", "千卷 用「规则」把一个视频/图片站点变成可浏览的片库。先导入一条规则开始。"),
      h("a.btn.solid", { href: "/rules" }, "去添加规则")
    );
  }

  const unfinished = history.filter((e) => !e.duration || e.position < e.duration * 0.97).slice(0, 12);

  return h(
    "div",
    rail("继续观看", unfinished, unfinished.length > 6 ? "/history" : null),
    rail("收藏", favorites.slice(0, 12), favorites.length > 6 ? "/favorites" : null),
    h(
      "section.section",
      h("div.section-head", h("h2", "站点"), h("a.more", { href: "/rules" }, "管理规则 →")),
      h("div.grid", sites.map(siteTile))
    )
  );
}
