// App bootstrap: routes, the site list in the top bar, the overflow menu, and the
// search box's notion of "current site" (searching is per-site, so the box has to
// know where you are).

import { h, clear } from "./dom.js";
import { route, setNotFound, startRouter, onRender, navigate, render } from "./router.js";
import { state, loadSites, loadLibrary, subscribe, siteById } from "./state.js";

import homeView from "./views/home.js";
import siteView from "./views/site.js";
import searchView from "./views/search.js";
import detailView from "./views/detail.js";
import watchView from "./views/watch.js";
import readView from "./views/read.js";
import rulesView from "./views/rules.js";
import { historyView, favoritesView } from "./views/library.js";

route("/", homeView);
route("/s/:site", siteView, { keepAlive: true }); // Back re-attaches this exact page
route("/search", searchView, { keepAlive: true }); // Back re-attaches this exact page
route("/d", detailView);
route("/watch", watchView);
route("/read", readView);
route("/history", historyView);
route("/favorites", favoritesView);
route("/rules", rulesView);
setNotFound(() => h("div.empty", h("h2", "页面不存在"), h("a.btn.solid", { href: "/" }, "回到首页")));

// ---- sites in the top bar -------------------------------------------------------

const siteNav = document.getElementById("siteNav");

function paintSites() {
  clear(siteNav);
  for (const s of state.sites) {
    siteNav.appendChild(h("a.site-link", { href: `/s/${encodeURIComponent(s.id)}`, dataset: { nav: "site:" + s.id } }, s.name));
  }
  paintActive(location.pathname, new URLSearchParams(location.search));
}

function paintActive(pathname, query) {
  const current =
    pathname === "/" ? "home"
    : pathname.startsWith("/s/") ? "site:" + decodeURIComponent(pathname.slice(3))
    : pathname === "/history" ? "history"
    : pathname === "/favorites" ? "favorites"
    : pathname === "/rules" ? "rules"
    : pathname === "/search" || pathname === "/watch" || pathname === "/d" || pathname === "/read"
      ? "site:" + (query.get("site") || "")
      : "";
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("active", a.dataset.nav === current);
}

subscribe(paintSites);

// ---- overflow menu + theme --------------------------------------------------------

const menuBtn = document.getElementById("menuBtn");
const menu = document.getElementById("menu");

function closeMenu() {
  menu.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
}
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

const THEMES = [
  { id: "indigo", name: "靛", accent: "#8ea2ff" },
  { id: "ink", name: "墨", accent: "#e4e4e6" },
  { id: "amber", name: "琥珀", accent: "#d9a05b" },
  { id: "teal", name: "青", accent: "#4db6a4" },
];
const themeRow = document.getElementById("themeRow");

function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem("scrolls.theme", id);
  } catch {
    /* private mode */
  }
  for (const b of themeRow.children) b.setAttribute("aria-pressed", String(b.dataset.theme === id));
}

for (const t of THEMES) {
  themeRow.appendChild(
    h("button.swatch", {
      title: t.name,
      "aria-label": "配色 " + t.name,
      dataset: { theme: t.id },
      style: { "--sw-accent": t.accent },
      onclick: () => applyTheme(t.id),
    })
  );
}
applyTheme(document.documentElement.dataset.theme || "indigo");

// ---- search box ---------------------------------------------------------------

const form = document.getElementById("searchForm");
const input = document.getElementById("searchInput");

/** Which site a search applies to: the one you are looking at, else the last one used. */
function currentSiteId(ctx) {
  const fromPath = ctx.path.startsWith("/s/") ? decodeURIComponent(ctx.path.slice(3)) : "";
  return fromPath || ctx.query.get("site") || state.lastSite || state.sites[0]?.id || "";
}

let searchSite = "";
let searchCat = null;
let lastCtx = null;

/**
 * Which category a search applies to. Searching from the GameCG tab should stay in
 * GameCG. This deliberately does NOT depend on the site list having loaded — on a cold
 * page load it has not, and gating on it silently dropped the category. The server
 * ignores a category that cannot scope a search, so carrying it is always safe; the
 * site list is only consulted to name the scope in the placeholder.
 */
function currentSearchCat(ctx) {
  const onSite = ctx.path.startsWith("/s/") && !ctx.query.get("q");
  if (!onSite && ctx.path !== "/search") return null;
  const n = parseInt(ctx.query.get("cat") ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/** Split out so it can run again once the site list arrives. */
function paintSearchBox(ctx) {
  if (!ctx) return;
  searchSite = currentSiteId(ctx);
  searchCat = currentSearchCat(ctx);
  const site = siteById(searchSite);
  const scope = site && searchCat != null
    ? site.categories?.find((c) => c.index === searchCat && c.searchScoped)
    : null;
  input.placeholder = site
    ? scope
      ? `在「${site.name} · ${scope.name}」内搜索`
      : `在「${site.name}」内搜索`
    : "搜索…";
}

onRender((ctx) => {
  lastCtx = ctx;
  paintSearchBox(ctx);
  input.value = ctx.path === "/search" ? ctx.query.get("kw") || "" : "";
  paintActive(ctx.path, ctx.query);
  closeMenu();
  if (ctx.path !== "/watch" && ctx.path !== "/read") document.title = "千卷";
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const kw = input.value.trim();
  if (!kw || !searchSite) return;
  input.blur();
  const cat = searchCat == null ? "" : `&cat=${searchCat}`;
  navigate(`/search?site=${encodeURIComponent(searchSite)}&kw=${encodeURIComponent(kw)}${cat}`);
});

// ---- go -----------------------------------------------------------------------

loadSites().then(() => {
  paintSites();
  paintSearchBox(lastCtx); // the first render ran before the site list existed
});
loadLibrary();
startRouter(document.getElementById("view"));

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// A refresh gesture that costs nothing to keep: re-pull sites + library and re-render.
window.addEventListener("keydown", (e) => {
  if (e.key === "r" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    Promise.all([loadSites(true), loadLibrary(true)]).then(() => render());
  }
});
