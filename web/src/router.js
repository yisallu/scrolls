// History-API router. Real URLs (/s/hanime1?cat=1) instead of hash fragments, so
// pages can be shared, bookmarked and opened in a new tab — the server already serves
// the app shell for any non-/api path.
//
// Each view gets an AbortSignal that fires the moment the user navigates away, so
// in-flight scrapes for the page you just left stop instead of racing the new one.

const routes = [];
let mounted = null; // what is on screen: { entryKey, url, node, cleanup, controller, keepAlive }
let mountEl = null;
let notFound = null;

// Detached-but-alive listing pages, keyed by history entry. Going Back re-attaches the
// very DOM you left — already populated, already laid out — so the page is simply THERE
// at the right offset instead of rebuilding and visibly scrolling down to catch up.
// Their AbortControllers are deliberately NOT aborted while cached, or "load more" would
// be dead on return.
const viewCache = new Map();
const VIEW_CACHE_MAX = 5;

// Where each history entry was scrolled to. Keyed by a stamp put in history.state,
// because the URL is not unique enough — the same listing can be several entries deep.
const scrollMemory = new Map();
let entryKey = null;
let renderCount = 0;

const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** True once we have rendered more than one view, i.e. history.back() stays in the app. */
export const canGoBack = () => renderCount > 1;

function rememberScroll() {
  if (entryKey) scrollMemory.set(entryKey, window.scrollY);
}

/**
 * Put the page back where it was. The catch is that a listing renders empty and fills
 * in asynchronously, so the target is usually far below the page's current height:
 * scroll as far as we can, which parks the grid's sentinel in view and makes it load
 * the next page, then try again. Bounded, because a listing can also legitimately be
 * shorter than it was (an item vanished upstream).
 */
function restoreScroll(target) {
  if (!target) {
    window.scrollTo(0, 0);
    return;
  }
  let tries = 0;
  const step = () => {
    if (entryKey == null) return;
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.min(target, max));
    if (window.scrollY < target - 4 && tries++ < 40) setTimeout(step, 150);
  };
  step();
}

function destroyEntry(entry) {
  if (!entry) return;
  try {
    entry.controller?.abort();
  } catch {
    /* already gone */
  }
  try {
    entry.cleanup?.();
  } catch (e) {
    console.warn("view cleanup failed", e);
  }
}

function trimViewCache() {
  while (viewCache.size > VIEW_CACHE_MAX) {
    const oldest = viewCache.keys().next().value;
    destroyEntry(viewCache.get(oldest));
    viewCache.delete(oldest);
  }
}

/** Park the current view for later, or tear it down. Uses ITS key, not the new one. */
function releaseMounted() {
  if (!mounted) return;
  if (mounted.keepAlive && mounted.entryKey) {
    scrollMemory.set(mounted.entryKey, window.scrollY);
    viewCache.delete(mounted.entryKey); // re-insert so Map order is LRU
    viewCache.set(mounted.entryKey, mounted);
    trimViewCache();
  } else {
    destroyEntry(mounted);
  }
  mounted = null;
}

function compile(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  return (pathParts) => {
    if (parts.length !== pathParts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      else if (parts[i] !== pathParts[i]) return null;
    }
    return params;
  };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.keepAlive] survive navigation so Back restores it instantly.
 *   For long, scrollable, expensive-to-rebuild listings — never for views that own an
 *   overlay or a player, which must be torn down when you leave.
 */
export function route(pattern, view, opts = {}) {
  routes.push({ match: compile(pattern), view, pattern, keepAlive: !!opts.keepAlive });
}

export function setNotFound(view) {
  notFound = view;
}

export function navigate(url, { replace = false } = {}) {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin) {
    location.href = target.href;
    return;
  }
  if (target.href === location.href && !replace) return;
  rememberScroll(); // before the entry changes, or we lose where this page was
  const key = replace && history.state?.key ? history.state.key : newKey();
  history[replace ? "replaceState" : "pushState"]({ key }, "", target.href);
  entryKey = key;
  render();
}

const listeners = new Set();
export const onRender = (fn) => listeners.add(fn);

export async function render() {
  releaseMounted();
  const controller = new AbortController();
  const ctx = {
    path: location.pathname,
    query: new URLSearchParams(location.search),
    params: {},
    signal: controller.signal,
    navigate,
  };
  const pathParts = location.pathname.split("/").filter(Boolean);
  const hit = routes.map((r) => ({ r, params: r.match(pathParts) })).find((x) => x.params);
  const view = hit ? hit.r.view : notFound;
  ctx.params = hit ? hit.params : {};
  ctx.pattern = hit ? hit.r.pattern : "*";
  const keepAlive = hit ? hit.r.keepAlive : false;
  renderCount++;

  for (const fn of listeners) fn(ctx);

  // Coming back to a page we parked: re-attach it and put the scrollbar where it was,
  // both in this same task so nothing is ever painted at the wrong offset. No refetch,
  // no progressive catch-up scroll — it just looks like the page never went away.
  const parked = viewCache.get(entryKey);
  if (parked && parked.url === location.href) {
    viewCache.delete(entryKey);
    controller.abort(); // the fresh one is unused; the parked view keeps its own
    mountEl.replaceChildren(parked.node);
    window.scrollTo(0, scrollMemory.get(entryKey) || 0);
    mounted = parked;
    mountEl.focus({ preventScroll: true });
    return;
  }

  mounted = { entryKey, url: location.href, node: null, cleanup: null, controller, keepAlive };

  try {
    const node = await view(ctx);
    if (controller.signal.aborted) return; // navigated away while the view was building
    mountEl.replaceChildren(node instanceof Node ? node : document.createTextNode(""));
    if (mounted && mounted.controller === controller) {
      mounted.node = node;
      mounted.cleanup = node && node.__cleanup;
    }
    // Nothing parked for this entry (a reload, or it aged out of the cache), so fall
    // back to chasing the position as the listing fills in.
    restoreScroll(scrollMemory.get(entryKey) || 0);
    mountEl.focus({ preventScroll: true });
  } catch (e) {
    if (controller.signal.aborted || e.name === "AbortError") return;
    console.error(e);
    mountEl.replaceChildren(errorNode(e));
  }
}

function errorNode(e) {
  const div = document.createElement("div");
  div.className = "error-box";
  div.textContent = (e && e.message) || "页面出错了";
  const btn = document.createElement("button");
  btn.className = "btn sm";
  btn.textContent = "重试";
  btn.onclick = () => render();
  div.appendChild(btn);
  return div;
}

/** Intercept in-app links once, globally, instead of wiring onclick everywhere. */
function interceptLinks() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const url = new URL(a.getAttribute("href"), location.href);
    if (url.origin !== location.origin) return;
    // player.html (and anything else with a file extension) is a real page load
    if (/\.\w{2,5}$/.test(url.pathname)) return;
    e.preventDefault();
    navigate(url.href);
  });
}

export function startRouter(el) {
  mountEl = el;
  // We restore scroll ourselves; the browser's own attempt fights the async content.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  interceptLinks();

  // Keep the current entry's position fresh, so Back has something to return to even
  // though popstate gives no chance to save on the way out.
  let raf = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        rememberScroll();
      });
    },
    { passive: true }
  );

  window.addEventListener("popstate", () => {
    entryKey = history.state?.key || null;
    render();
  });

  if (!history.state?.key) {
    entryKey = newKey();
    history.replaceState({ key: entryKey }, "", location.href);
  } else {
    entryKey = history.state.key;
  }
  render();
}
