// The standalone player page: local files, a direct URL, or ?src= handed over by the
// library. Same engine as the in-app player — one implementation, so a fix to the
// rewind loop can never again land in only one of two copies.
//
// Note on direct URLs typed by hand: the analyser needs same-origin (or CORS) audio.
// Anything opened from the library already comes through /api/stream, so it is fine.

import { h } from "../dom.js";
import { createPlayer } from "./ui.js";
import { ensureHls } from "./hls-loader.js";

const host = document.getElementById("host");
const player = createPlayer();
host.appendChild(player.el);

const fileInput = h("input", { type: "file", accept: "video/*,audio/*", hidden: true });
document.body.appendChild(fileInput);

const urlInput = h("input", { type: "text", placeholder: "或粘贴视频直链(需同源 / CORS)" });
const emptyState = h(
  "div",
  h("h2", "载入一段视频开始"),
  h("p", "拖入文件,或选择本地视频。播放后会按声音自动断句。"),
  h("button.btn.solid", { onclick: () => fileInput.click() }, "选择视频文件"),
  h("div.url", urlInput, h("button.btn", { onclick: loadFromUrl }, "载入"))
);
player.setEmpty(emptyState);

function loadFile(file) {
  if (!file) return;
  document.title = `${file.name} · 千卷`;
  player.engine.loadSource(URL.createObjectURL(file), { objectUrl: true });
}

async function loadFromUrl() {
  const u = urlInput.value.trim();
  if (!u) return;
  const isHls = /\.m3u8(\?|$)/i.test(u);
  // The single-file build has no hls.js next to it; a plain file still plays.
  if (isHls) await ensureHls().catch(() => {});
  player.loadMedia({ src: u, type: isHls ? "hls" : "file" });
}

fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));
urlInput.addEventListener("keydown", (e) => e.key === "Enter" && loadFromUrl());

for (const ev of ["dragenter", "dragover"]) {
  player.stage.addEventListener(ev, (e) => {
    e.preventDefault();
    player.stage.classList.add("drag");
  });
}
for (const ev of ["dragleave", "drop"]) {
  player.stage.addEventListener(ev, (e) => {
    e.preventDefault();
    player.stage.classList.remove("drag");
  });
}
player.stage.addEventListener("drop", (e) => loadFile(e.dataTransfer?.files?.[0]));

player.engine.addEventListener("error", () => {
  player.setEmpty(
    h(
      "div",
      h("h2", "无法载入该视频"),
      h("p", "直链可能缺少 CORS 头,或浏览器不支持这个格式。建议改用本地文件。"),
      h("button.btn.solid", { onclick: () => fileInput.click() }, "选择本地文件")
    )
  );
});

// ---- ?src= bootstrap (kept compatible with v1 links) -------------------------------
(async function bootstrap() {
  const q = new URLSearchParams(location.search);
  const src = q.get("src");
  if (!src) return;
  const title = q.get("title");
  if (title) document.title = `${title} · 千卷`;
  try {
    const tags = JSON.parse(q.get("tags") || "[]");
    if (Array.isArray(tags)) player.setTags(tags, q.get("site"));
  } catch {
    /* malformed tags — skip */
  }
  const isHls = q.get("type") === "hls" || /\.m3u8(\?|$)/i.test(src);
  if (isHls) await ensureHls().catch(() => {});
  player.loadMedia({ src, type: isHls ? "hls" : "file", startAt: Number(q.get("t")) || 0 });
})();
