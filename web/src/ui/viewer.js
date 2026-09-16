// The image viewer, and — for multi-page galleries — the reader.
//
// Three shapes share one component:
//   lightbox : one booru image, arrow buttons and a caption (a single-image site)
//   page     : the reader — one page filling the screen, tap zones, filmstrip, scrubber
//   scroll   : the reader as a continuous vertical strip with lazy loading
//
// Reader design notes, because they are the reason for most of the code below:
//  * the page image is always fit-to-viewport (object-fit: contain) and the chrome
//    floats OVER it instead of shrinking it, so showing the UI never reflows the page
//    you are reading.
//  * the screen is three tap zones — left and right turn the page, the middle toggles
//    the chrome. Turning a page deliberately does NOT reveal the chrome: reading is
//    meant to be a bare image, and a stray tap near an edge should not keep flashing a
//    toolbar at you.
//  * `items` may be SPARSE (see views/read.js): index i can be missing while the slice
//    of the gallery index containing it is still in flight. Every read of items[i] has
//    to survive undefined, and `ensureAt` is what asks for the missing slice.
//
// Full-size images are resolved on demand (one extra request per page on sites that
// only expose thumbnails in their listing) and prefetched a page ahead.

import { h, clear, cssUrl } from "../dom.js";
import api from "../api.js";
import { toast } from "./toast.js";

// v1's key defaulted to "scroll"; the reader is page-first now, so a new key lets the
// new default actually reach people who had already opened a gallery once.
const MODE_KEY = "scrolls.readerMode.v2";
const CHROME_KEY = "scrolls.readerChrome";
const ORIGINAL_KEY = "scrolls.readerOriginal";
const W2X_KEY = "scrolls.waifu2x";
const FAVCAT_KEY = "scrolls.favcat"; // which of the site's folders to file into
const PREFETCH = 4; // pages warmed ahead of the one on screen
const W2X_PREFETCH = 3; // how many of those also get queued on the GPU

// Denoise costs sharpness, and the first default (1) was too strong. Measured on a
// real page against the true original as the ceiling — mean |∇| of the same crop:
//   sample 5.94 · n=3 7.20 · n=1 7.42 · n=0 7.50 · n=-1 7.69 · 原图 7.82
// So -1 (denoise off) lands closest to the real thing. Noisy scans still want it on,
// which is why there is now a control instead of just a better constant.
const W2X_DEFAULTS = { on: false, model: "models-cunet", noise: -1, scale: 2, v: 2 };

const W2X_MODELS = [
  ["models-cunet", "cunet"],
  ["models-upconv_7_anime_style_art_rgb", "upconv7"],
  ["models-upconv_7_photo", "photo"],
];
// -1 is "no denoise", which is the sharpest and the default; higher is smoother.
const W2X_NOISE = [
  [-1, "关"],
  [0, "0"],
  [1, "1"],
  [2, "2"],
  [3, "3"],
];

const STRIP_H = 76; // rendered height of a filmstrip thumbnail, px — matches .lb-thumb .cell
const ZONE = 0.32; // outer third of the width, each side, turns the page

let active = null;
export const closeViewer = () => active?.close();

/**
 * @param {object} o
 * @param {any[]} o.items         image items; may be sparse when gallery.ensure is used
 * @param {number} o.index        starting index
 * @param {object} o.site
 * @param {object} [o.gallery]    { ensure, total, title, onProgress }
 */
export function openViewer({ items, index = 0, site, gallery = null }) {
  closeViewer();
  const paged = !!gallery;
  const total = () => Math.max(items.length, (paged && gallery.total?.()) || 0);
  let i = Math.max(0, Math.min(index, Math.max(0, total() - 1)));
  let mode = paged ? (localStorage.getItem(MODE_KEY) === "scroll" ? "scroll" : "page") : "page";
  // Whether the bars are up is a preference, not a per-gallery state: someone who reads
  // bare wants the next book bare too.
  let chromeOn = paged ? localStorage.getItem(CHROME_KEY) !== "off" : true;
  // Read originals instead of the 1280px sample. Sticky, but any 509 turns it back off
  // (and forgets it), so a quota wall can never be inherited into the next session.
  const canOriginal = paged && (site.variants || []).includes("original");
  let original = canOriginal && localStorage.getItem(ORIGINAL_KEY) === "on";
  // waifu2x, run on the desktop's GPU via the server-side worker queue (media/w2x.js).
  // Page mode only, and it is just another /api/page variant — so it works identically
  // on a phone or an iPad over plain https, with nothing to install on that device.
  let w2x = readW2x();
  let w2xUp = false; // is the desktop GPU worker connected? asked once on open
  // Favourite ON THE SITE'S ACCOUNT. Distinct from 我的片库's local star, which is why
  // the button lives in the reader and says so in its tooltip.
  const canFavorite = paged && !!site.canFavorite && !!gallery?.id;
  let fav = null; // { favorited, cat, cats } once the site has told us
  let favBusy = false;
  let pending = 0; // in-flight index-slice requests, for the "载入中…" hint

  const overlay = h("div.lightbox", { id: "lightbox" });
  const stage = h("div.lb-stage", { dataset: { act: "bg" } });
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  // ---- fullscreen / immersive -------------------------------------------------
  // Desktop, Android and iPadOS get the real Fullscreen API. iPhone has no element
  // fullscreen at all (every iOS browser is WebKit), so immersive mode is CSS in
  // 100dvh — which also adapts as iOS shows and hides its own chrome.
  const nativeFs = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const immersive = () => overlay.classList.contains("immersive");
  async function enterImmersive() {
    overlay.classList.add("immersive");
    const req = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
    if (req) {
      try {
        await req.call(overlay, { navigationUI: "hide" });
      } catch {
        /* needs a gesture, or iOS — the CSS mode still applies */
      }
    }
    setTimeout(() => window.scrollTo(0, 1), 60); // nudge iOS to collapse the URL bar
    paint();
  }
  function exitImmersive() {
    const was = nativeFs();
    overlay.classList.remove("immersive");
    if (was) document.exitFullscreen?.().catch(() => {});
    paint();
  }
  const toggleImmersive = () => (immersive() ? exitImmersive() : enterImmersive());
  const onFsChange = () => {
    if (!nativeFs() && immersive()) {
      overlay.classList.remove("immersive");
      paint();
    }
  };

  // ---- loading -------------------------------------------------------------------

  function readW2x() {
    try {
      const v = JSON.parse(localStorage.getItem(W2X_KEY) || "{}");
      // v<2 was written before the default changed; carry the switch, redo the strength.
      if (!(v.v >= 2)) return { ...W2X_DEFAULTS, on: !!v.on, model: v.model || W2X_DEFAULTS.model };
      return {
        on: !!v.on,
        model: v.model || W2X_DEFAULTS.model,
        noise: Number.isFinite(+v.noise) ? +v.noise : W2X_DEFAULTS.noise,
        scale: Number(v.scale) || 2,
        v: 2,
      };
    } catch {
      return { ...W2X_DEFAULTS };
    }
  }

  function saveW2x() {
    try {
      localStorage.setItem(W2X_KEY, JSON.stringify({ ...w2x, v: 2 }));
    } catch {
      /* private mode — the choice still applies for this session */
    }
  }

  /** Change a waifu2x setting: new params mean a different cache entry, so repaint. */
  function setW2xOpt(patch) {
    w2x = { ...w2x, ...patch };
    saveW2x();
    paintW2xBar();
    syncW2xButton();
    if (mode === "page") paintPage();
  }

  // 原图 wins over waifu2x when both are on. The server upscales the SAMPLE (that is
  // what costs no extra quota), so running it while the real original is available
  // would serve invented pixels in place of real ones — strictly worse.
  const w2xOn = () => paged && w2x.on && w2xUp && !original && mode === "page";

  function syncW2xButton() {
    const btn = overlay.querySelector(".lb-w2x");
    if (!btn) return;
    const shadowed = w2x.on && w2xUp && original;
    btn.classList.toggle("on", w2x.on && w2xUp && !shadowed);
    btn.classList.toggle("busy", !!(w2xOn() && busyIdx === i));
    btn.title = shadowed
      ? "waifu2x:已让位给原图(原图本来就是真实像素)"
      : w2x.on
        ? `waifu2x:开(${w2x.model.replace("models-", "")}) — 点此关闭 (W)`
        : "waifu2x:关 — 用电脑显卡放大 (W)";
  }

  /** A gallery page is addressed by id; the server resolves and caches it for us. */  /** A gallery page is addressed by id; the server resolves and caches it for us. */
  function pageUrl(item, variant) {
    const v = variant !== undefined ? variant : original ? "original" : "";
    return api.pageUrl({
      site: site.id,
      id: item.id,
      variant: v,
      ...(v === "w2x" ? { model: w2x.model, noise: w2x.noise, scale: w2x.scale } : {}),
    });
  }

  function srcFor(item) {
    if (!item) return "";
    if (paged && item.id) return pageUrl(item);
    return item._full || item.image || item.cover || "";
  }

  function resolve(idx, { onReady } = {}) {
    if (paged) return; // gallery pages need no resolve round-trip — see pageUrl()
    const it = items[idx];
    if (!it || it._full || it._resolving) return;
    if (!site.resolvesImages || !it.id || String(it.fileType || "").startsWith("video")) return;
    it._resolving = true;
    api
      .image({ site: site.id, id: it.id })
      .then((r) => {
        it._resolving = false;
        if (!r?.url) return;
        it._full = r.url;
        onReady?.(idx, r.url);
      })
      .catch(() => {
        it._resolving = false;
      });
  }

  /** Ask the route for the gallery-index slice holding `idx`. True when it arrived. */
  async function ensureAt(idx) {
    if (!paged || idx < 0 || items[idx]) return false;
    pending++;
    updateMeta();
    try {
      return await gallery.ensure(idx);
    } catch {
      return false;
    } finally {
      pending--;
      updateMeta();
    }
  }

  // ---- page mode ---------------------------------------------------------------

  function paintPage() {
    scroller = null; // the strip is gone; the scroll handler must not read a detached node
    const it = items[i];
    const plain = srcFor(it);
    if (plain) {
      const shown = i;
      const img = h("img.lb-media", { src: plain, alt: "" });
      img.addEventListener("error", () => onPageError(shown, plain));
      watchVariantInfo(img);
      clear(stage).appendChild(img);
      if (w2xOn()) requestW2x(shown);
    } else {
      clear(stage).appendChild(h("div.lb-loading", `第 ${i + 1} 页 · 载入中…`));
    }
    if (!it) {
      ensureAt(i).then((got) => got && mode === "page" && paintPage());
    } else {
      resolve(i, {
        onReady: (idx, url) => {
          if (idx !== i || mode !== "page") return;
          const img = stage.querySelector("img");
          if (img) img.src = url;
          else paintPage();
        },
      });
      // Warm a WINDOW of upcoming pages, not just the next one: a waifu2x pass costs
      // seconds, so the queue has to run several pages ahead of the reader to stay
      // invisible. Missing index slices are pulled in on the way.
      for (let n = 1; n <= PREFETCH; n++) {
        const k = i + n;
        if (k >= total()) break;
        if (items[k]) prefetch(k);
        else ensureAt(k).then((got) => got && prefetch(k));
      }
    }
    syncW2xButton();
    gallery?.onProgress?.(i);
    syncFoot();
  }

  let busyIdx = -1;

  /**
   * Say which version of the page you are actually looking at, and at what resolution.
   * Without this the three variants are indistinguishable once the picture is fitted to
   * the screen — waifu2x can be working perfectly and look like it did nothing, which is
   * exactly the confusion that prompted adding it.
   */
  function showVariantInfo(img) {
    if (!vinfoEl || !img) return;
    const short = W2X_MODELS.find(([id]) => id === w2x.model)?.[1] || w2x.model;
    const label = /[?&]v=w2x/.test(img.src)
      ? `waifu2x ${short}${w2x.noise >= 0 ? ` 降噪${w2x.noise}` : ""}`
      : /[?&]v=original/.test(img.src)
        ? "原图"
        : "样本";
    const dims = img.naturalWidth ? ` · ${img.naturalWidth}×${img.naturalHeight}` : "";
    vinfoEl.textContent = label + dims;
    vinfoEl.classList.toggle("hot", label !== "样本");
  }

  function watchVariantInfo(img) {
    if (img.complete && img.naturalWidth) showVariantInfo(img);
    img.addEventListener("load", () => {
      if (stage.contains(img)) showVariantInfo(img);
    });
  }

  /**
   * Ask for the upscaled page. The server queues the job on the desktop worker and
   * holds the request until it is ready, so this is a plain <img> load that may take
   * seconds — fetched off-screen and swapped in only if you are still on that page.
   * The sample stays visible throughout; there is never a spinner instead of a page.
   */
  function requestW2x(shown) {
    const it = items[shown];
    if (!it) return;
    const url = pageUrl(it, "w2x");
    if (shown === i) {
      busyIdx = shown;
      syncW2xButton();
    }
    const probe = new Image();
    probe.decoding = "async";
    probe.addEventListener("load", () => {
      if (busyIdx === shown) busyIdx = -1;
      if (shown !== i || !w2xOn()) return syncW2xButton();
      const cur = stage.querySelector("img.lb-media");
      if (cur) {
        cur.src = url;
        watchVariantInfo(cur);
      }
      syncW2xButton();
    });
    probe.addEventListener("error", async () => {
      if (busyIdx === shown) busyIdx = -1;
      syncW2xButton();
      if (shown !== i) return;
      // An <img> never says why it failed. Ask once, so "the desktop is off" reads
      // as that instead of as a broken page.
      try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        if (r.ok) return;
        const code = (await r.json().catch(() => ({}))).code || "";
        if (code === "worker_offline") {
          w2xUp = false;
          syncW2xButton();
          toast("电脑上的 waifu2x 工作进程没运行,已回到样本");
        } else if (code) toast(`waifu2x:${code}`);
      } catch {
        /* offline; the sample is still on screen */
      }
    });
    probe.src = url;
  }

  function prefetch(idx) {
    const it = items[idx];
    if (!it) return;
    if (!paged) return resolve(idx);
    const src = pageUrl(it);
    const warm = new Image(); // the browser cache does the rest
    warm.decoding = "async";
    warm.src = src;
    // Warm the GPU queue too. The server dispatches serially, so asking a few pages
    // ahead is what makes the upscale invisible while you read.
    if (w2xOn() && idx <= i + W2X_PREFETCH) {
      const ahead = new Image();
      ahead.decoding = "async";
      ahead.src = pageUrl(it, "w2x");
    }
  }

  /**
   * An <img> only tells us "failed", never why. On a gallery page the why matters —
   * running out of E-Hentai image quota looks identical to a dead CDN node — so the
   * URL is re-requested once to read the server's error code.
   */
  async function onPageError(idx, src) {
    if (!paged) return;
    let code = "";
    try {
      const r = await fetch(src, { headers: { Accept: "application/json" } });
      if (r.ok) return; // it works now: a transient H@H node, the retry below is enough
      code = (await r.json().catch(() => ({}))).code || "";
    } catch {
      /* offline; leave the placeholder */
    }
    if (idx !== i || mode !== "page") return;
    if (code === "quota_exceeded" && original) {
      // Fall back rather than leave a broken page, and do not inherit this next time.
      setOriginal(false, { remember: true });
      toast("原图配额已用尽,已切回样本");
      return;
    }
    if (code === "quota_exceeded") toast("E-Hentai 图片配额已用尽,稍后再试");
  }

  function go(delta) {
    if (paged) i = Math.max(0, Math.min(i + delta, total() - 1));
    else {
      // In a mixed booru grid, videos open in the player — skip past them here.
      for (let n = 0; n < items.length; n++) {
        i = (i + delta + items.length) % items.length;
        if (!String(items[i].fileType || "").startsWith("video")) break;
      }
    }
    paint();
  }

  function jumpTo(n) {
    const next = Math.max(0, Math.min(n, total() - 1));
    if (next === i) return;
    i = next;
    if (mode === "scroll") {
      const target = scroller?.children[i];
      if (target) stage.scrollTop = target.offsetTop - 40;
      hydrate(i);
      syncFoot();
    } else paintPage();
  }

  // ---- scroll (reader) mode ------------------------------------------------------

  let scroller = null;
  let io = null;

  function slotFor(idx) {
    const it = items[idx];
    const slot = h("div.slot", { dataset: { idx: String(idx) } });
    const src = srcFor(it);
    if (src && it._full) slot.appendChild(h("img", { src, alt: "", loading: "lazy", decoding: "async" }));
    else slot.appendChild(h("div.ph", `第 ${idx + 1} 页`));
    return slot;
  }

  function paintScroll() {
    clear(stage);
    scroller = h("div.lb-scroll");
    for (let k = 0; k < total(); k++) scroller.appendChild(slotFor(k));
    stage.appendChild(scroller);
    // The observer only decides what to LOAD (with a generous margin, so pages are
    // ready before you reach them). Where you *are* comes from the scroll position —
    // an observer with a 1200px margin reports a dozen slots at once and the reading
    // position would jump to whichever one happened to be reported last.
    io?.disconnect();
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          hydrate(Number(e.target.dataset.idx));
        }
      },
      { root: stage, rootMargin: "1200px 0px", threshold: 0 }
    );
    for (const slot of scroller.children) io.observe(slot);
    stage.addEventListener("scroll", onScroll, { passive: true });
    requestAnimationFrame(() => {
      const target = scroller.children[i];
      if (target) stage.scrollTop = target.offsetTop - 40;
    });
  }

  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!scroller) return;
      const y = stage.scrollTop + 60; // a page counts as "current" once its top passes here
      const kids = scroller.children;
      let idx = kids.length - 1;
      for (let k = 0; k < kids.length; k++) {
        if (kids[k].offsetTop + kids[k].offsetHeight > y) {
          idx = k;
          break;
        }
      }
      if (idx === i) return;
      i = idx;
      syncFoot();
      gallery?.onProgress?.(i);
    });
  }

  function hydrate(idx) {
    const slot = scroller?.querySelector(`.slot[data-idx="${idx}"]`);
    if (!slot) return;
    const it = items[idx];
    if (!it) {
      ensureAt(idx).then((got) => got && hydrate(idx));
      return;
    }
    const swap = (url) => {
      if (slot.querySelector("img")) return;
      clear(slot).appendChild(h("img", { src: url, alt: "", decoding: "async" }));
    };
    if (srcFor(it) && (paged || it._full || !site.resolvesImages)) swap(srcFor(it));
    else resolve(idx, { onReady: (_k, url) => swap(url) });
  }

  // ---- filmstrip + scrubber (reader, page mode) -----------------------------------

  let strip = null;
  let stripIo = null;
  let stripArmed = false;
  let range = null;
  let curEl = null;
  let totalEl = null;
  let vinfoEl = null;
  let w2xBar = null;
  let favBar = null;
  let scrubbing = false;

  function thumbSlot(k) {
    return h(
      "button.lb-thumb",
      { type: "button", dataset: { idx: String(k), act: "jump" }, title: `第 ${k + 1} 页` },
      h("span.cell"),
      h("span.n", String(k + 1))
    );
  }

  /**
   * Draw one page's thumbnail. exhentai packs twenty of them into a single sprite
   * sheet, so the common case is a fixed-size cell scaled down with a transform rather
   * than an <img> — see pageThumb() in server/engine/extract.js.
   */
  function fillThumb(el, idx) {
    if (el.dataset.filled) return;
    const t = items[idx]?.thumb;
    if (!t?.url) return;
    const cell = el.querySelector(".cell");
    if (!cell) return;
    el.dataset.filled = "1";
    if (t.w && t.h) {
      const k = STRIP_H / t.h;
      cell.style.width = Math.round(t.w * k) + "px";
      cell.appendChild(
        h("i", {
          style: {
            width: t.w + "px",
            height: t.h + "px",
            backgroundImage: cssUrl(t.url),
            backgroundPosition: `-${t.x || 0}px -${t.y || 0}px`,
            transform: `scale(${k})`,
          },
        })
      );
    } else {
      cell.appendChild(h("img", { src: t.url, loading: "lazy", decoding: "async", alt: "" }));
    }
  }

  /** Fill every strip cell whose page has since arrived. Cheap: filled ones are skipped. */
  function hydrateStrip() {
    if (!strip) return;
    for (const el of strip.children) if (!el.dataset.filled) fillThumb(el, Number(el.dataset.idx));
  }

  /**
   * Start loading thumbnails. Deliberately NOT done at build time: the strip exists
   * (with a real width) while the chrome is hidden, and arming it then would pull
   * sprite sheets down for a filmstrip nobody has asked to see yet.
   */
  function armStrip() {
    if (!strip || stripArmed) return;
    stripArmed = true;
    stripIo?.disconnect();
    stripIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const idx = Number(e.target.dataset.idx);
          if (items[idx]) fillThumb(e.target, idx);
          // Scrolling the strip into unloaded territory pulls the index slices in.
          // One request covers ~20 cells, so a fast drag does not become a stampede.
          else ensureAt(idx).then((got) => got && hydrateStrip());
        }
      },
      { root: strip, rootMargin: "0px 400px" }
    );
    for (const el of strip.children) stripIo.observe(el);
  }

  function buildFoot() {
    strip = h("div.lb-strip");
    for (let k = 0; k < total(); k++) strip.appendChild(thumbSlot(k));

    curEl = h("span.lb-cur");
    totalEl = h("span.lb-total");
    range = h("input.lb-range", {
      type: "range",
      min: "1",
      max: String(Math.max(1, total())),
      step: "1",
      value: String(i + 1),
      "aria-label": "跳转到某一页",
    });
    // Dragging only previews (moving the strip and the counter); the jump happens on
    // release. Index pages are scraped, and a live jump would fetch every slice the
    // thumb slid over.
    range.addEventListener("input", () => {
      scrubbing = true;
      const n = Number(range.value) - 1;
      if (curEl) curEl.textContent = String(n + 1);
      paintRange(n);
      markThumb(n);
    });
    const commit = () => {
      if (!scrubbing) return;
      scrubbing = false;
      jumpTo(Number(range.value) - 1);
    };
    range.addEventListener("change", commit);
    range.addEventListener("pointerup", commit);

    vinfoEl = h("span.lb-vinfo");
    w2xBar = h("div.lb-w2xbar");
    paintW2xBar();
    favBar = h("div.lb-favbar");
    paintFavBar();
    return h("div.lb-foot", favBar, buildTagBar(), w2xBar, strip, h("div.lb-bar", curEl, range, totalEl), vinfoEl);
  }

  function buildHead() {
    const link = items[i]?.link;
    return h(
      "div.lb-head",
      h("button.lb-back", { dataset: { act: "close" }, title: "返回 (Esc)" }, "‹"),
      h("div.lb-title", gallery?.title || items[i]?.title || ""),
      link ? h("a.lb-icon", { href: link, target: "_blank", rel: "noreferrer noopener", title: "原帖" }, "↗") : null,
      canFavorite
        ? h(
            "button.lb-icon.lb-fav",
            {
              dataset: { act: "fav" },
              class: fav?.favorited ? "on" : "",
              title: favTitle(),
            },
            fav?.favorited ? "★" : "☆"
          )
        : null,
      canOriginal
        ? h(
            "button.lb-icon.lb-orig",
            {
              dataset: { act: "orig" },
              class: original ? "on" : "",
              title: original ? "原图:开 — 点此切回样本 (O)" : "原图:关 — 点此加载原图,更清晰但更费配额 (O)",
            },
            "原"
          )
        : null,
      paged
        ? h(
            "button.lb-icon.lb-w2x",
            {
              dataset: { act: "w2x" },
              class: w2x.on && w2xUp ? "on" : "",
              title: "waifu2x — 用本机显卡放大 (W)",
            },
            "✦"
          )
        : null,
      h("button.lb-icon", { dataset: { act: "mode" }, title: "切换阅读方式:翻页 / 长条 (M)" }, mode === "scroll" ? "▤" : "▦"),
      h("button.lb-icon", { dataset: { act: "fs" }, title: immersive() ? "退出全屏 (F)" : "全屏 (F)" }, immersive() ? "🗗" : "⛶")
    );
  }

  /** Paint the filled part of the scrubber track (native range inputs cannot do it). */
  function paintRange(n) {
    if (!range) return;
    const max = Math.max(1, total() - 1);
    range.style.setProperty("--pct", `${(Math.max(0, n) / max) * 100}%`);
  }

  function paintW2xBar() {
    if (!w2xBar) return;
    clear(w2xBar);
    w2xBar.hidden = !w2xOn();
    if (w2xBar.hidden) return;
    w2xBar.append(
      h("span.lb-w2xlabel", "waifu2x"),
      ...W2X_MODELS.map(([id, label]) =>
        h(
          "button.lb-chip",
          { type: "button", class: w2x.model === id ? "on" : "", onclick: () => setW2xOpt({ model: id }) },
          label
        )
      ),
      h("span.lb-w2xlabel", "降噪"),
      ...W2X_NOISE.map(([n, label]) =>
        h(
          "button.lb-chip",
          { type: "button", class: w2x.noise === n ? "on" : "", onclick: () => setW2xOpt({ noise: n }) },
          label
        )
      )
    );
  }

  const favTitle = () =>
    !fav
      ? "收藏到 ExHentai 账号"
      : fav.favorited
        ? `已收藏到「${fav.cats?.find((c) => c.value === fav.cat)?.label || fav.cat}」— 点此取消`
        : "收藏到 ExHentai 账号 (F)";

  function syncFavButton() {
    const btn = overlay.querySelector(".lb-fav");
    if (!btn) return;
    btn.textContent = favBusy ? "…" : fav?.favorited ? "★" : "☆";
    btn.classList.toggle("on", !!fav?.favorited);
    btn.title = favTitle();
  }

  async function loadFav() {
    if (!canFavorite) return;
    try {
      fav = await api.favoriteState({ site: site.id, id: gallery.id });
    } catch {
      fav = null; // the site said no; leave the button inert rather than lying
    }
    syncFavButton();
    paintFavBar();
  }

  /** Add to the folder you used last, or remove if it is already in one. */
  async function toggleFav(catOverride) {
    if (!canFavorite || favBusy) return;
    const target =
      catOverride !== undefined ? catOverride : fav?.favorited ? null : localStorage.getItem(FAVCAT_KEY) || "0";
    favBusy = true;
    syncFavButton();
    try {
      fav = await api.setFavorite({ site: site.id, id: gallery.id, cat: target });
      if (target !== null) {
        try {
          localStorage.setItem(FAVCAT_KEY, String(target));
        } catch {
          /* private mode */
        }
      }
      toast(fav.favorited ? `已收藏到「${fav.cats?.find((c) => c.value === fav.cat)?.label || fav.cat}」` : "已取消收藏");
    } catch (e) {
      toast(`收藏失败:${e.message}`);
    } finally {
      favBusy = false;
      syncFavButton();
      paintFavBar();
    }
  }

  /** Folder picker — only worth showing once it is actually in one. */
  function paintFavBar() {
    if (!favBar) return;
    clear(favBar);
    favBar.hidden = !(canFavorite && fav?.favorited && fav.cats?.length);
    if (favBar.hidden) return;
    favBar.append(
      h("span.lb-w2xlabel", "收藏夹"),
      ...fav.cats.map((c) =>
        h(
          "button.lb-chip",
          { type: "button", class: c.value === fav.cat ? "on" : "", onclick: () => toggleFav(c.value) },
          c.label
        )
      )
    );
  }

  /** The gallery's tags, each a shortcut to more of the same. */
  function buildTagBar() {
    const tags = gallery?.tags || [];
    if (!tags.length || !gallery?.onTag) return null;
    return h(
      "div.lb-tagbar",
      ...tags.slice(0, 40).map((t) =>
        h(
          "button.lb-chip.lb-tag",
          { type: "button", title: `搜索 ${t.q}`, onclick: () => gallery.onTag(t.q) },
          t.text
        )
      )
    );
  }

  function markThumb(n) {
    if (!strip) return;
    const prev = strip.querySelector(".lb-thumb.on");
    if (prev) prev.classList.remove("on");
    const el = strip.children[n];
    if (!el) return;
    el.classList.add("on");
    // scrollIntoView would also try to scroll the page; centring by hand does not.
    strip.scrollLeft = el.offsetLeft - strip.clientWidth / 2 + el.offsetWidth / 2;
  }

  function syncFoot() {
    updateMeta();
    if (!range) return;
    const max = Math.max(1, total());
    if (range.max !== String(max)) range.max = String(max);
    if (totalEl) totalEl.textContent = String(total());
    if (!scrubbing) {
      range.value = String(i + 1);
      if (curEl) curEl.textContent = String(i + 1);
      paintRange(i);
      markThumb(i);
    }
  }

  // ---- chrome ------------------------------------------------------------------

  let metaEl = null;

  function paintChrome() {
    overlay.querySelectorAll(".lb-btn, .lb-nav, .lb-info, .lb-foot, .lb-head").forEach((n) => n.remove());
    strip = range = curEl = totalEl = vinfoEl = w2xBar = favBar = metaEl = null;
    stripIo?.disconnect();
    stripArmed = false;

    const parts = [];
    if (paged) {
      // The reader gets a real title bar; the single-image lightbox keeps its floating
      // round buttons, which suit a caption-and-tags layout better.
      parts.push(buildHead());
      if (mode === "page") parts.push(buildFoot());
    } else {
      parts.push(
        h("button.lb-btn.lb-close", { dataset: { act: "close" }, title: "关闭 (Esc)" }, "✕"),
        h(
          "button.lb-btn.lb-fs",
          { dataset: { act: "fs" }, title: immersive() ? "退出全屏 (F)" : "全屏 (F)" },
          immersive() ? "🗗" : "⛶"
        ),
        h("button.lb-nav.lb-prev", { dataset: { act: "prev" }, title: "上一张 (←)" }, "‹"),
        h("button.lb-nav.lb-next", { dataset: { act: "next" }, title: "下一张 (→)" }, "›")
      );
    }

    if (!paged || mode === "scroll") {
      metaEl = h("div.lb-meta");
      const info = h("div.lb-info", metaEl);
      const tags = Array.isArray(items[i]?.tags) ? items[i].tags : [];
      if (tags.length) info.appendChild(h("div.lb-tags", tags.slice(0, 60).map((t) => h("span", t))));
      parts.push(info);
    }
    overlay.append(...parts);
    syncFoot();
  }

  function updateMeta() {
    if (!metaEl) return;
    const it = items[i] || {};
    const dims = it.width && it.height ? `${it.width}×${it.height}` : "";
    clear(metaEl);
    const bits = [gallery?.title, dims, `${i + 1} / ${total()}`].filter(Boolean);
    metaEl.appendChild(document.createTextNode(bits.join("  ·  ")));
    if (it.link) {
      metaEl.append(
        document.createTextNode("  ·  "),
        h("a", { href: it.link, target: "_blank", rel: "noreferrer noopener" }, "原帖 ↗")
      );
    }
    if (pending > 0) metaEl.append(document.createTextNode("  ·  载入中…"));
  }

  /**
   * Switch between the 1280px sample and the full-resolution original. Only the image
   * is repainted — the filmstrip comes from the gallery index and is variant-agnostic,
   * so rebuilding it here would scroll it back to the top for nothing.
   */
  function setOriginal(on, { remember = true } = {}) {
    if (!canOriginal || original === !!on) return;
    original = !!on;
    if (remember) localStorage.setItem(ORIGINAL_KEY, original ? "on" : "off");
    const btn = overlay.querySelector(".lb-orig");
    if (btn) {
      btn.classList.toggle("on", original);
      btn.title = original ? "原图:开 — 点此切回样本 (O)" : "原图:关 — 点此加载原图,更清晰但更费配额 (O)";
    }
    if (mode === "page") paintPage();
    else paintScroll();
    syncW2xButton();
    paintW2xBar();
    if (original && w2x.on && w2xUp) toast("原图已开启 — waifu2x 让位(原图是真实像素,更清晰)");
  }

  async function setW2x(on) {
    if (!paged) return;
    if (on) {
      // Re-ask every time it is switched on: the usual reason it was off is that the
      // desktop worker was not running yet, and you have just gone and started it.
      w2xUp = await api
        .w2xOnline()
        .then((r) => !!r.online)
        .catch(() => false);
      if (!w2xUp) {
        toast("电脑上的 waifu2x 工作进程没运行 — 在电脑上跑 node tools/w2x-worker.mjs");
        syncW2xButton();
        return;
      }
    }
    w2x = { ...w2x, on: !!on };
    saveW2x();
    syncW2xButton();
    paintW2xBar();
    paintPage();
    toast(on ? `waifu2x 已开启 · ${w2x.model.replace("models-", "")} · 电脑显卡` : "waifu2x 已关闭");
  }

  function setChrome(on, { remember = false } = {}) {
    chromeOn = on;
    overlay.classList.toggle("chrome", chromeOn);
    if (remember && paged) localStorage.setItem(CHROME_KEY, chromeOn ? "on" : "off");
    if (chromeOn) {
      armStrip();
      hydrateStrip();
      markThumb(i);
    }
  }

  function paint() {
    overlay.classList.toggle("reader", paged);
    overlay.classList.toggle("scrollmode", mode === "scroll");
    paintChrome();
    // The long strip has no tap zones to bring the chrome back, so it always keeps it.
    setChrome(mode === "scroll" ? true : chromeOn);
    if (mode === "scroll") paintScroll();
    else paintPage();
  }

  function setMode(next) {
    mode = next;
    if (paged) localStorage.setItem(MODE_KEY, mode);
    paint();
  }

  // ---- input --------------------------------------------------------------------

  function onKey(e) {
    if (e.key === "Escape") {
      if (immersive()) exitImmersive();
      else close({ user: true });
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
      if (mode === "page") go(-1);
      else return;
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") {
      if (mode === "page") go(1);
      else return;
    } else if (e.key === "Home") jumpTo(0);
    else if (e.key === "End") jumpTo(total() - 1);
    else if (e.key === "f" || e.key === "F") toggleImmersive();
    else if ((e.key === "m" || e.key === "M") && paged) setMode(mode === "scroll" ? "page" : "scroll");
    else if ((e.key === "h" || e.key === "H") && paged && mode === "page") setChrome(!chromeOn, { remember: true });
    else if ((e.key === "o" || e.key === "O") && canOriginal) setOriginal(!original);
    else if ((e.key === "w" || e.key === "W") && paged) setW2x(!w2x.on);
    else if ((e.key === "f" || e.key === "F") && canFavorite && !e.repeat) toggleFav();
    else return;
    e.preventDefault();
  }

  overlay.addEventListener("click", (e) => {
    const target = e.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    if (act === "close") close({ user: true });
    else if (act === "fs") toggleImmersive();
    else if (act === "mode") setMode(mode === "scroll" ? "page" : "scroll");
    else if (act === "prev") go(-1);
    else if (act === "next") go(1);
    else if (act === "orig") setOriginal(!original);
    else if (act === "w2x") setW2x(!w2x.on);
    else if (act === "fav") toggleFav();
    else if (act === "jump") jumpTo(Number(target.dataset.idx));
    else if (act === "bg") {
      if (paged && mode === "page") {
        // Three zones. Paging never touches the chrome — see the header comment.
        const x = e.clientX / (window.innerWidth || 1);
        if (x < ZONE) go(-1);
        else if (x > 1 - ZONE) go(1);
        else setChrome(!chromeOn, { remember: true });
      } else if (mode === "page") {
        // Single-image lightbox: immersive taps page, windowed backdrop closes.
        if (immersive()) go(e.clientX >= window.innerWidth / 2 ? 1 : -1);
        else if (e.target === target) close();
      }
    }
  });

  /**
   * `user` separates "you pressed ‹ or Esc" from "the route tore the viewer down".
   * Only the first should navigate — the second is already mid-navigation, and calling
   * back() there would bounce you a page further than you asked for.
   */
  function close({ user = false } = {}) {
    if (nativeFs()) document.exitFullscreen?.().catch(() => {});
    io?.disconnect();
    stripIo?.disconnect();
    stage.removeEventListener("scroll", onScroll);
    cancelAnimationFrame(scrollRaf);
    overlay.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
    if (active?.close === close) active = null;
    if (user) gallery?.onClose?.();
  }

  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  overlay.appendChild(stage);
  active = { close, overlay };
  paint();
  // Probing is async, so the first paint happens without it; if the service is up and
  // the switch was left on, repaint once we know.
  loadFav();
  if (paged && w2x.on) {
    api
      .w2xOnline()
      .then((r) => {
        w2xUp = !!r.online;
        // The foot is built before this resolves, so the控制条 was rendered hidden and
        // nothing ever brought it back — repaint it here, not just the button.
        syncW2xButton();
        paintW2xBar();
        if (w2xUp && mode === "page") paintPage();
      })
      .catch(() => {});
  }
  return active;
}
