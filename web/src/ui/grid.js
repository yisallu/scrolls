// The paginated grid every browsing screen is built from.
//
// It hides the fact that the API paginates three different ways (page numbers with a
// step, keyset cursors, or "no more pages") behind one loop: ask for the next page,
// append, repeat while the sentinel is near the viewport.

import { h, clear, debounce } from "../dom.js";
import { videoCard, imageCard } from "./cards.js";

const ROW_H = 8;   // must match .imagegrid grid-auto-rows
const ROW_GAP = 14;

/** Give every image tile a row span matching its rendered height (row-major masonry). */
function layoutMasonry(grid) {
  if (!grid.isConnected) return;
  for (const card of grid.children) {
    const height = card.getBoundingClientRect().height;
    if (height > 0) card.style.gridRowEnd = `span ${Math.ceil((height + ROW_GAP) / ROW_H)}`;
  }
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host        where to render
 * @param {object} opts.site             site metadata (drives video vs image layout)
 * @param {(cursor:{page?:number,cursor?:string}) => Promise<any>} opts.load
 * @param {(items:any[], index:number) => void} [opts.onOpenImage]
 * @param {AbortSignal} [opts.signal]
 */
export function paginatedGrid({ host, site, load, onOpenImage, signal, emptyHint }) {
  const isImage = site.type === "image";
  const items = [];
  const grid = h(isImage ? "div.imagegrid" : "div.grid");
  const sentinel = h("div.morewrap");
  const moreBtn = h("button.btn", { onclick: () => loadMore() }, "加载更多");

  let page = null;
  let step = 1;
  let cursor = null;
  let ended = false;
  let loading = false;
  let observer = null;

  const relayout = debounce(() => isImage && layoutMasonry(grid), 120);
  const onResize = () => relayout();
  window.addEventListener("resize", onResize);

  function appendItems(newItems) {
    const start = items.length;
    items.push(...newItems);
    const frag = document.createDocumentFragment();
    newItems.forEach((item, i) => {
      const index = start + i;
      if (isImage) {
        const card = imageCard(item, site, () => onOpenImage?.(items, index));
        card.querySelector("img")?.addEventListener("load", () => relayout());
        frag.appendChild(card);
      } else {
        frag.appendChild(videoCard(item, site));
      }
    });
    grid.appendChild(frag);
    if (isImage) requestAnimationFrame(() => layoutMasonry(grid));
  }

  async function fetchPage(first) {
    const params = {};
    if (!first) {
      if (cursor) params.cursor = cursor;
      else if (page != null) params.page = page + step;
    }
    const data = await load(params);
    page = data.page ?? null;
    step = data.step || 1;
    cursor = data.cursor || null;
    if (!data.hasNext) ended = true;
    appendItems(data.items || []);
    return data;
  }

  async function loadMore() {
    if (loading || ended || signal?.aborted) return;
    loading = true;
    moreBtn.textContent = "加载中…";
    moreBtn.disabled = true;
    try {
      await fetchPage(false);
      moreBtn.textContent = ended ? "没有更多了" : "加载更多";
      moreBtn.disabled = ended;
    } catch (e) {
      if (e.name === "AbortError") return;
      moreBtn.textContent = "加载失败,点此重试";
      moreBtn.disabled = false;
    } finally {
      loading = false;
    }
  }

  function armAutoLoad() {
    observer?.disconnect();
    if (ended) return;
    // 600px of lead time: start the next page before the user reaches the bottom.
    observer = new IntersectionObserver(
      async (entries) => {
        if (!entries[0].isIntersecting || loading || ended) return;
        await loadMore();
        // Short pages (a 12-item category on a wide screen) would otherwise stop after
        // one fetch; re-observing keeps filling until the viewport is covered.
        if (!ended && observer) {
          observer.unobserve(sentinel);
          observer.observe(sentinel);
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(sentinel);
  }

  function destroy() {
    observer?.disconnect();
    window.removeEventListener("resize", onResize);
  }
  signal?.addEventListener("abort", destroy);

  // ---- first paint -------------------------------------------------------------
  clear(host).appendChild(skeleton(isImage));

  (async () => {
    try {
      const first = await fetchPage(true);
      if (signal?.aborted) return;
      clear(host);
      if (!first.items || !first.items.length) {
        host.appendChild(emptyState(emptyHint));
        return;
      }
      host.append(grid, sentinel);
      sentinel.appendChild(moreBtn);
      if (ended) {
        moreBtn.disabled = true;
        moreBtn.textContent = "没有更多了";
      } else {
        armAutoLoad();
      }
    } catch (e) {
      if (signal?.aborted || e.name === "AbortError") return;
      clear(host).appendChild(
        h(
          "div.error-box",
          e.status === 424 ? `暂时不可用:${e.message}` : `出错:${e.message}`,
          h("button.btn.sm", { onclick: () => paginatedGrid({ host, site, load, onOpenImage, signal, emptyHint }) }, "重试")
        )
      );
    }
  })();

  return { items, destroy, reload: () => paginatedGrid({ host, site, load, onOpenImage, signal, emptyHint }) };
}

function skeleton(isImage) {
  const wrap = h(isImage ? "div.imagegrid" : "div.grid");
  const n = isImage ? 18 : 12;
  for (let i = 0; i < n; i++) {
    const card = h("div.sk");
    if (isImage) {
      const span = 22 + ((i * 7) % 16);
      card.style.aspectRatio = "auto";
      card.style.gridRowEnd = `span ${span}`;
    }
    wrap.appendChild(card);
  }
  return wrap;
}

function emptyState(hint) {
  return h(
    "div.empty",
    h("h2", "没有结果"),
    h("p", hint || "换个分类或关键词试试。如果整站都空,多半是该规则的选择器需要更新了。")
  );
}
