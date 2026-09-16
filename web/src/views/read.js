// The gallery reader route. A grid tile on a gallery site is a whole book, so this
// route loads its page index and hands it to the viewer, which opens immediately —
// clicking a cover is meant to land you in the reader, not on a landing page.
//
// The index is itself paginated (exhentai returns ~20 page links per request). v2's
// first cut only ever walked it forwards, which was fine for scrolling and useless for
// a scrubber: reaching the middle of a 600-page gallery meant fifteen sequential
// requests. So the page array is SPARSE — pre-sized to the reported total and filled
// one slice at a time — and any page can be reached with the single request that
// covers it. Everything downstream therefore has to tolerate items[i] === undefined.

import { h } from "../dom.js";
import api from "../api.js";
import { loadSites, loadLibrary, siteById, recordHistory, entryKey, historyFor, setLastSite } from "../state.js";
import { openViewer, closeViewer } from "../ui/viewer.js";
import { canGoBack } from "../router.js";

export default async function readView(ctx) {
  await Promise.all([loadSites(), loadLibrary()]);
  const siteId = ctx.query.get("site");
  const id = ctx.query.get("id");
  const site = siteById(siteId);
  if (!site || !id) return h("div.empty", h("h2", "缺少画廊参数"), h("a.btn", { href: "/" }, "回到首页"));
  setLastSite(site.id);

  const titleFromQuery = ctx.query.get("title") || "";
  // Fall back to the site's front page only when we genuinely do not know (a shared link).
  const backHref = ctx.query.get("from") || `/s/${encodeURIComponent(site.id)}`;
  // Going BACK (rather than navigating to the same URL) is what restores the scroll
  // position, because the saved position belongs to that history entry.
  const goBack = () => (canGoBack() ? history.back() : ctx.navigate(backHref));
  const pages = []; // sparse; pages[i] stays undefined until its slice arrives
  const loaded = new Set();
  const inflight = new Map();
  let total = 0;
  let perSlice = 0; // page links returned by one index request, learned from the first
  let step = 1;
  let meta = null;
  let ended = false; // only consulted when the site does not report a total

  function absorb(slice, r) {
    meta ||= r;
    if (r.total) total = r.total;
    step = r.step || step;
    const got = r.pages || [];
    if (!perSlice && got.length) perSlice = got.length;
    const link = site.baseUrl && id.includes("/") ? `${site.baseUrl.replace(/\/+$/, "")}/g/${id}/` : "";
    const base = slice * (perSlice || got.length || 1);
    got.forEach((p, k) => {
      pages[base + k] = { ...p, tags: r.tags || [], link, title: titleFromQuery || r.title || "" };
    });
    if (total > pages.length) pages.length = total; // sparse: length without elements
    if (!got.length) ended = true;
    return got.length;
  }

  function loadSlice(slice) {
    if (loaded.has(slice)) return Promise.resolve(0);
    const running = inflight.get(slice);
    if (running) return running;
    const p = api
      .gallery({ site: site.id, id, page: slice * step }, ctx.signal)
      .then((r) => {
        loaded.add(slice);
        return absorb(slice, r);
      })
      .finally(() => inflight.delete(slice));
    inflight.set(slice, p);
    return p;
  }

  /** Make sure page `index` is loaded. Resolves true when new pages arrived. */
  async function ensure(index) {
    if (index < 0 || pages[index]) return false;
    if (total && index >= total) return false;
    if (!perSlice) return (await loadSlice(0)) > 0;
    if (!total && ended) return false;
    return (await loadSlice(Math.floor(index / perSlice))) > 0;
  }

  const root = h("div", h("div.loading", "正在打开画廊…"));

  try {
    await loadSlice(0);
  } catch (e) {
    return h(
      "div",
      h("a.backlink", { href: backHref }, "← 返回"),
      h("div.error-box", `打开画廊失败:${e.message}`)
    );
  }
  if (ctx.signal.aborted) return root;
  if (!pages.length) {
    return h(
      "div",
      h("a.backlink", { href: backHref }, "← 返回"),
      h("div.empty", h("h2", "这个画廊没有可读页面"), h("p", "可能需要更新该规则的 galleryRule.item 选择器。"))
    );
  }

  const title = titleFromQuery || meta?.title || "画廊";
  document.title = `${title} · 千卷`;
  const entry = { site: site.id, id, title, cover: ctx.query.get("cover") || "", kind: "gallery", tags: meta?.tags || [] };
  const resume = historyFor(entryKey(entry));
  const count = total || pages.length;
  const startIndex = resume?.page && resume.page < count ? resume.page : 0;

  // What you see behind the reader, and after closing it.
  root.replaceChildren(
    h("a.backlink", { href: backHref, onclick: (e) => { e.preventDefault(); goBack(); } }, "← 返回片库"),
    h("div.page-head", h("h1", title), h("span.sub", `${count} 页`)),
    h(
      "div.empty",
      h("p", "阅读器已打开。关闭后可以从这里再次进入。"),
      h("button.btn.solid", { onclick: () => open(lastPage >= 0 ? lastPage : startIndex) }, "继续阅读"),
      meta?.tags?.length ? h("div.taglist", meta.tags.slice(0, 40).map((t) => h("span", t))) : null
    )
  );

  let lastPage = -1;
  function open(index) {
    openViewer({
      items: pages,
      index,
      site,
      gallery: {
        ensure,
        id, // the site's own gallery id, for account-level favourites
        onClose: goBack,
        tags: meta?.tagLinks || (meta?.tags || []).map((t) => ({ text: t, q: t })),
        onTag: (q) => ctx.navigate(`/search?site=${encodeURIComponent(site.id)}&kw=${encodeURIComponent(q)}`),
        total: () => total || pages.length,
        title,
        onProgress: (i) => {
          if (i === lastPage) return;
          lastPage = i;
          recordHistory({ ...entry, page: i, position: i, duration: total || pages.length });
        },
      },
    });
  }
  open(startIndex);

  root.__cleanup = () => closeViewer();
  return root;
}
