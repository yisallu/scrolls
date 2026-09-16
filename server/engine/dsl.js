// The selector DSL that rules are written in. Semantics are unchanged from v1 — every
// existing rule keeps working — this file just makes them explicit and testable.
//
//   "cssSelector@attr"        pull an attribute
//   "cssSelector"             text content (same as "@text")
//   "cssSelector@html"        inner HTML
//   "@attr"                   the matched item element itself (inside a list item)
//   "a@href || img@data-src"  try each alternative, first non-empty wins
//
// JSON rules use dotted paths with the same "||" fallback: "file.url||sample_url".

import { URL } from "node:url";

export function absUrl(base, u) {
  if (!u) return u || "";
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

/** One selector token → string. Returns "" when nothing matched. */
export function pluck($, scopeEl, token) {
  token = String(token == null ? "" : token).trim();
  if (!token) return "";
  const at = token.lastIndexOf("@");
  let sel, attr;
  if (at === -1) {
    sel = token;
    attr = "text";
  } else {
    sel = token.slice(0, at).trim();
    attr = token.slice(at + 1).trim() || "text";
  }
  let el;
  if (!sel) el = scopeEl ? $(scopeEl) : null;
  else el = scopeEl ? $(scopeEl).find(sel).first() : $(sel).first();
  if (!el || el.length === 0) return "";
  if (attr === "text") return el.text().trim();
  if (attr === "html") return (el.html() || "").trim();
  const v = el.attr(attr);
  return v == null ? "" : String(v).trim();
}

/** A field spec: alternatives separated by "||", first non-empty wins. */
export function field($, scopeEl, spec) {
  if (!spec) return "";
  for (const token of String(spec).split("||")) {
    const v = pluck($, scopeEl, token);
    if (v) return v;
  }
  return "";
}

/**
 * Numbers hidden in attributes. `cssProp` handles the "dimensions live in a style
 * attribute" case (exhentai: style="width:250px;height:350px").
 */
export function numberFromValue(v, cssProp) {
  if (!v) return 0;
  const s = String(v);
  if (cssProp) {
    const prop = String(cssProp).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*(-?\\d+(?:\\.\\d+)?)", "i").exec(s);
    if (m) return Math.max(0, Number(m[1]) || 0);
  }
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? Math.max(0, Number(m[0]) || 0) : 0;
}

export function numericField($, scopeEl, spec, cssProp) {
  if (!spec) return 0;
  for (const token of String(spec).split("||")) {
    const t = token.trim();
    const n = numberFromValue(pluck($, scopeEl, t), /@style\s*$/i.test(t) ? cssProp : "");
    if (n > 0) return n;
  }
  return 0;
}

/** Dotted path with optional [n] indexing: "meta.next", "data[0].id". */
export function getPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (cur == null) return undefined;
    const m = /^(\w+)\[(\d+)\]$/.exec(seg);
    if (m) {
      cur = cur[m[1]];
      if (Array.isArray(cur)) cur = cur[Number(m[2])];
    } else {
      cur = cur[seg];
    }
  }
  return cur;
}

export function jsonField(item, spec) {
  if (!spec) return undefined;
  for (const p of String(spec).split("||")) {
    const v = getPath(item, p.trim());
    if (v != null && v !== "") return v;
  }
  return undefined;
}

/** URL templates: {page}, {kw} (percent-encoded), {id}, plus anything else passed in. */
export function buildUrl(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars) || vars[k] == null) return m;
    return k === "kw" ? encodeURIComponent(vars[k]) : String(vars[k]);
  });
}

/** Compile a rule-supplied regex without letting a typo take the process down. */
export function safeRegExp(source, flags) {
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}
