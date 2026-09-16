// The watch screen: resolve a playable source, mount ShadowPlay, remember where you got to.
//
// Playing inside the SPA (rather than jumping to player.html as v1 did) is what makes
// Back return to the grid you came from, with its scroll position and loaded pages intact.

import { h } from "../dom.js";
import api from "../api.js";
import { loadSites, loadLibrary, siteById, entryKey, historyFor, recordHistory, isFavorite, toggleFavorite, setLastSite } from "../state.js";
import { createPlayer } from "../player/ui.js";
import { toast } from "../ui/toast.js";
import { ensureHls } from "../player/hls-loader.js";

export default async function watchView(ctx) {
  await Promise.all([loadSites(), loadLibrary()]);
  const siteId = ctx.query.get("site");
  const url = ctx.query.get("url") || "";
  const id = ctx.query.get("id") || "";
  const detailUrl = ctx.query.get("d") || "";
  const site = siteById(siteId);
  if (!site || (!url && !id)) return h("div.empty", h("h2", "缺少播放参数"), h("a.btn", { href: "/" }, "回到首页"));
  setLastSite(site.id);

  const backHref = detailUrl
    ? `/d?site=${encodeURIComponent(site.id)}&url=${encodeURIComponent(detailUrl)}`
    : `/s/${encodeURIComponent(site.id)}`;

  const titleEl = h("h1", ctx.query.get("title") || "解析中…");
  const favBtn = h("button.btn.sm", "☆ 收藏");
  const head = h(
    "div.page-head",
    h("a.backlink", { href: backHref, style: { marginBottom: "0" } }, "← 返回"),
    titleEl,
    h("span.grow"),
    favBtn
  );

  const mount = h("div");
  const root = h("div", head, mount);

  // Resolving is a live scrape of the watch page, and on some sites a signed URL —
  // both slow enough that the page must say something while it happens.
  mount.appendChild(h("div.loading", "正在解析可播放地址…"));

  let player = null;
  root.__cleanup = () => player?.destroy();

  try {
    const [resolved, detail] = await Promise.all([
      url ? api.resolve({ site: site.id, url }, ctx.signal) : api.image({ site: site.id, id }, ctx.signal),
      detailUrl ? api.detail({ site: site.id, url: detailUrl }, ctx.signal).catch(() => null) : Promise.resolve(null),
    ]);
    if (ctx.signal.aborted) return root;

    const source = url ? resolved.sources?.[0] : { url: resolved.url, kind: /\.m3u8(\?|$)/i.test(resolved.url) ? "hls" : "file" };
    if (!source?.url) throw new Error("没有可播放的源");

    const title = ctx.query.get("title") || detail?.title || resolved.title || "未命名";
    titleEl.textContent = title;
    document.title = `${title} · 千卷`;

    const entry = {
      site: site.id,
      url: url || undefined,
      id: id || undefined,
      title,
      cover: detail?.cover || ctx.query.get("cover") || "",
      detailUrl,
      tags: detail?.tags || [],
      kind: "video",
    };
    const key = entryKey(entry);
    const resume = historyFor(key);
    // Don't "resume" someone into the last 15 seconds of a video they finished.
    const startAt = resume && resume.duration && resume.position < resume.duration - 15 ? resume.position : 0;

    const syncFav = () => (favBtn.textContent = isFavorite(key) ? "★ 已收藏" : "☆ 收藏");
    favBtn.onclick = async () => {
      const on = await toggleFavorite(entry);
      syncFav();
      toast(on ? "已收藏" : "已取消收藏");
    };
    syncFav();

    if (source.kind === "hls") await ensureHls();
    if (ctx.signal.aborted) return root;

    player = createPlayer({
      onProgress: ({ position, duration, ended }) =>
        recordHistory({ ...entry, position: ended ? 0 : position, duration }, { flush: ended }),
    });
    mount.replaceChildren(player.el);
    player.setTags(entry.tags, site.id);
    player.setEmpty(h("div", h("h2", "准备就绪"), h("p", "点击画面开始。播放时会按声音自动断句。")));
    player.loadMedia({ src: source.url, type: source.kind, startAt });
    recordHistory({ ...entry, position: startAt, duration: 0 });

    root.appendChild(
      h(
        "div.p-foot",
        h("b", "有声则播 · 静音则停 · 点击继续"),
        h("br"),
        h("kbd", "空格"), " 播放/暂停　", h("kbd", "←"), h("kbd", "→"), " 退/进 5 秒　", h("kbd", "R"), " 重听本句　", h("kbd", "F"), " 全屏"
      )
    );
  } catch (e) {
    if (ctx.signal.aborted) return root;
    mount.replaceChildren(
      h(
        "div.error-box",
        e.status === 424 ? `暂时不可用:${e.message}` : `解析失败:${e.message}`,
        h("a.btn.sm", { href: backHref }, "返回")
      )
    );
  }
  return root;
}
