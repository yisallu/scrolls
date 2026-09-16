// The two tile shapes: a 16:9 video card and a natural-ratio image tile.

import { h, fmtTime, fmtAgo } from "../dom.js";
import { entryKey, isFavorite, toggleFavorite, historyFor } from "../state.js";
import { toast } from "./toast.js";

const detailHref = (siteId, url) => `/d?site=${encodeURIComponent(siteId)}&url=${encodeURIComponent(url || "")}`;

/** Star button, wired to 收藏. Shared by every card type. */
function favButton(entry) {
  const key = entryKey(entry);
  const btn = h("button.corner", { title: "收藏", "aria-label": "收藏" }, "★");
  const sync = () => btn.classList.toggle("on", isFavorite(key));
  sync();
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const on = await toggleFavorite(entry);
    sync();
    toast(on ? "已收藏" : "已取消收藏");
  });
  return btn;
}

/**
 * A video listing tile. `item` is {title, url, cover, duration, badge}; the resume bar
 * and the star come from 我的片库, so a card knows whether you have seen it.
 */
export function videoCard(item, site, opts = {}) {
  const entry = { site: site.id, url: item.url, title: item.title, cover: item.cover, kind: "video" };
  const hist = historyFor(entryKey(entry));
  const pct = hist && hist.duration > 0 ? Math.min(100, (hist.position / hist.duration) * 100) : 0;

  const thumb = h(
    "span.thumb",
    item.cover
      ? h("img", { src: item.cover, loading: "lazy", decoding: "async", alt: "" })
      : h("span.ph", "无封面"),
    item.duration ? h("span.badge", item.duration) : null,
    item.badge && !item.duration ? h("span.badge", item.badge) : null,
    pct > 1 ? h("span.progress", h("i", { style: { width: pct + "%" } })) : null,
    favButton(entry)
  );

  return h(
    "a.card",
    { href: opts.href || detailHref(site.id, item.url), title: item.title },
    thumb,
    h("span.cap", item.title),
    opts.meta ? h("span.meta", opts.meta) : null
  );
}

/** A history/favourites tile: same shape, but it also shows where you left off. */
export function historyCard(entry, sites) {
  const site = sites.find((s) => s.id === entry.site) || { id: entry.site, name: entry.site, type: "video" };
  const left = entry.duration > 0 && entry.position > 0 ? `${fmtTime(entry.position)} / ${fmtTime(entry.duration)}` : "";
  const meta = [site.name, left || fmtAgo(entry.updatedAt)].filter(Boolean).join(" · ");

  if (entry.kind === "gallery") {
    return videoCard(
      { title: entry.title, url: entry.url, cover: entry.cover, badge: entry.page ? `第 ${entry.page + 1} 页` : "" },
      site,
      { href: `/read?site=${encodeURIComponent(entry.site)}&id=${encodeURIComponent(entry.id || "")}`, meta }
    );
  }
  const href =
    entry.kind === "image"
      ? `/s/${encodeURIComponent(entry.site)}`
      : `/watch?site=${encodeURIComponent(entry.site)}&url=${encodeURIComponent(entry.url || "")}`;
  return videoCard({ title: entry.title, url: entry.url, cover: entry.cover }, site, { href, meta });
}

/**
 * An image tile. Natural aspect ratio is applied up-front from the API's width/height
 * so the masonry reserves the right space before the image loads — that is what keeps
 * the grid from reflowing as you scroll.
 */
export function imageCard(item, site, onOpen) {
  const isVideo = String(item.fileType || "").startsWith("video");
  const ratio = item.width && item.height ? `${item.width}/${item.height}` : "";
  const img = item.cover
    ? h("img", { src: item.cover, loading: "lazy", decoding: "async", alt: "", style: ratio ? { aspectRatio: ratio } : {} })
    : h("span.noimg", "无缩略图");

  const card = h(
    "button.icard",
    { type: "button", onclick: () => onOpen(item), title: item.title || "" },
    img,
    isVideo ? h("span.play", "▶") : null,
    item.gallery ? h("span.cap", item.title) : null
  );

  if (item.cover) {
    let tries = 0;
    img.addEventListener("error", () => {
      // Proxied thumbnails occasionally lose a race with a rate-limiting CDN; two
      // quiet retries turn a wall of broken tiles back into a grid.
      if (tries++ < 2) {
        const u = new URL(img.src, location.href);
        u.searchParams.set("_r", String(tries));
        setTimeout(() => (img.src = u.toString()), tries * 500);
        return;
      }
      img.replaceWith(h("span.noimg", "加载失败"));
    });
  }
  return card;
}
