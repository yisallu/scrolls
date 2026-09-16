// Transient feedback. Replaces v1's alert() calls, which block the page, look like a
// browser error, and on iOS can be suppressed entirely.

import { h } from "../dom.js";

const host = () => document.getElementById("toasts");

export function toast(message, { bad = false, ms = 2600 } = {}) {
  const el = h("div", { class: bad ? "toast bad" : "toast" }, String(message));
  host()?.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 260);
  }, ms);
  return el;
}

export const toastError = (e) => toast(e && e.message ? e.message : String(e), { bad: true, ms: 4200 });

/** Minimal modal prompt — used where a value is needed (new tab keyword, rename). */
export function askText({ title, placeholder = "", value = "", ok = "确定" }) {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", placeholder, value });
    const close = (v) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
      else if (e.key === "Enter" && document.activeElement === input) close(input.value.trim() || null);
    };
    const overlay = h(
      "div.lightbox",
      { style: { alignItems: "center", justifyContent: "center", background: "rgba(4,6,9,.75)" }, onclick: (e) => e.target === overlay && close(null) },
      h(
        "div.panel",
        { style: { width: "min(420px, 92vw)" } },
        h("h3", title),
        input,
        h(
          "div.field",
          { style: { justifyContent: "flex-end" } },
          h("button.btn", { onclick: () => close(null) }, "取消"),
          h("button.btn.solid", { onclick: () => close(input.value.trim() || null) }, ok)
        )
      )
    );
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => input.focus());
  });
}

export function confirmBox(message, { ok = "确定", danger = true } = {}) {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = h(
      "div.lightbox",
      { style: { alignItems: "center", justifyContent: "center", background: "rgba(4,6,9,.75)" }, onclick: (e) => e.target === overlay && close(false) },
      h(
        "div.panel",
        { style: { width: "min(420px, 92vw)" } },
        h("p", { style: { margin: "0 0 16px", fontSize: "14.5px" } }, message),
        h(
          "div.field",
          { style: { justifyContent: "flex-end" } },
          h("button.btn", { onclick: () => close(false) }, "取消"),
          h(danger ? "button.btn.danger" : "button.btn.solid", { onclick: () => close(true) }, ok)
        )
      )
    );
    document.body.appendChild(overlay);
  });
}
