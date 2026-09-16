// 继续观看 / 收藏 — the two lists that make this a library rather than a search box.

import { h } from "../dom.js";
import { state, loadSites, loadLibrary, removeHistory, clearHistory, toggleFavorite } from "../state.js";
import { historyCard } from "../ui/cards.js";
import { confirmBox, toast } from "../ui/toast.js";

function list(entries, onRemove, removeLabel) {
  const grid = h("div.grid");
  for (const e of entries) {
    const card = historyCard(e, state.sites);
    card.appendChild(
      h(
        "button.btn.sm",
        {
          style: { marginTop: "8px" },
          onclick: async (ev) => {
            ev.preventDefault();
            await onRemove(e);
            card.remove();
          },
        },
        removeLabel
      )
    );
    grid.appendChild(card);
  }
  return grid;
}

export async function historyView() {
  await Promise.all([loadSites(), loadLibrary()]);
  const { history } = state.library;
  if (!history.length) {
    return h("div.empty", h("h2", "还没有观看记录"), h("p", "播放任何一个视频后,进度会自动记在这里,换设备也能接着看。"));
  }
  return h(
    "div",
    h(
      "div.page-head",
      h("h1", "继续观看"),
      h("span.sub", `${history.length} 条`),
      h("span.grow"),
      h(
        "button.btn.sm.danger",
        {
          onclick: async () => {
            if (!(await confirmBox("清空全部观看记录?"))) return;
            await clearHistory();
            toast("已清空");
            location.reload();
          },
        },
        "清空"
      )
    ),
    list(history, (e) => removeHistory(e.key), "移除")
  );
}

export async function favoritesView() {
  await Promise.all([loadSites(), loadLibrary()]);
  const { favorites } = state.library;
  if (!favorites.length) {
    return h("div.empty", h("h2", "还没有收藏"), h("p", "在任意封面右上角点 ★,或在详情页收藏。"));
  }
  return h(
    "div",
    h("div.page-head", h("h1", "收藏"), h("span.sub", `${favorites.length} 条`)),
    list(favorites, (e) => toggleFavorite(e), "取消收藏")
  );
}
