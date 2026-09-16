// A 60-line hyperscript instead of innerHTML string building.
//
// v1 built pages by concatenating HTML strings and remembering to escape every
// interpolation. One missed escape is an XSS hole and scraped titles are attacker
// controlled, so here nothing is ever parsed as markup: text goes in as text.

export function h(tag, props, ...children) {
  // "div.card.wide" / "a#brand.link" shorthand
  const [name, ...rest] = String(tag).split(/(?=[.#])/);
  const el = document.createElement(name || "div");
  for (const token of rest) {
    if (token[0] === ".") el.classList.add(token.slice(1));
    else if (token[0] === "#") el.id = token.slice(1);
  }
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = el.className ? `${el.className} ${v}` : v;
    else if (k === "style" && typeof v === "object") {
      for (const [prop, val] of Object.entries(v)) {
        // custom properties are invisible to the CSSStyleDeclaration property setter —
        // el.style["--x"] = … silently does nothing, setProperty is the only way in
        if (prop.startsWith("--")) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v; // only ever used with literals we wrote
    else if (k in el && k !== "list" && typeof v !== "object") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false || c === "") continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Safe background-image value — quotes and parens in a URL would break out of url(). */
export const cssUrl = (u) => `url("${String(u).replace(/["\\\n\r]/g, encodeURIComponent)}")`;

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtAgo(ts) {
  const d = Date.now() - Number(ts || 0);
  if (!ts || d < 0) return "";
  const min = Math.round(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

/** Trailing-edge debounce. */
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
