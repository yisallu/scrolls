// The rules screen: what this server is allowed to scrape, and how to change it.
// New here: you can open an existing rule, edit its JSON and save it back — v1 could
// only import or delete, so fixing one selector meant re-pasting the whole file.

import { h, clear } from "../dom.js";
import api from "../api.js";
import { loadSites } from "../state.js";
import { toast, toastError, confirmBox } from "../ui/toast.js";

export default async function rulesView(ctx) {
  const rules = await api.rules();
  const editor = h("textarea", { placeholder: "在此粘贴规则 JSON,或从上方点「编辑」载入一条现有规则…", spellcheck: false });
  const urlInput = h("input", { type: "url", placeholder: "规则文件直链 https://…/rule.json" });
  const listHost = h("div");

  async function refresh() {
    const fresh = await api.rules();
    clear(listHost);
    listHost.append(...fresh.map(row));
    await loadSites(true);
  }

  function row(r) {
    return h(
      "div.rule-row",
      h(
        "div.m",
        h("b", r.name),
        h("div", `${r.id} · ${r.baseUrl} · ${r.type === "image" ? "图集" : "影片"}${r.gallery ? " · 画廊" : ""}`)
      ),
      h(
        "div.sp",
        h("a.btn.sm", { href: `/s/${encodeURIComponent(r.id)}` }, "浏览"),
        h(
          "button.btn.sm",
          {
            onclick: () => {
              editor.value = JSON.stringify(r, null, 2);
              editor.scrollIntoView({ behavior: "smooth", block: "center" });
              toast("已载入到编辑器,注意 *** 表示服务端保留的密钥");
            },
          },
          "编辑"
        ),
        h(
          "button.btn.sm.danger",
          {
            onclick: async () => {
              if (!(await confirmBox(`删除规则「${r.name}」?服务器会留一份备份。`))) return;
              try {
                await api.deleteRule(r.id);
                toast("已删除");
                await refresh();
              } catch (e) {
                toastError(e);
              }
            },
          },
          "删除"
        )
      )
    );
  }

  listHost.append(...rules.map(row));

  const saveBtn = h(
    "button.btn.solid",
    {
      onclick: async () => {
        const text = editor.value.trim();
        if (!text) return;
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          toastError(new Error("JSON 解析失败:" + e.message));
          return;
        }
        try {
          await api.saveRule(parsed);
          toast("已保存,立即生效");
          await refresh();
        } catch (e) {
          toastError(e);
        }
      },
    },
    "保存规则"
  );

  const importBtn = h(
    "button.btn",
    {
      onclick: async () => {
        const u = urlInput.value.trim();
        if (!u) return;
        try {
          await api.saveRule({ url: u });
          urlInput.value = "";
          toast("已导入");
          await refresh();
        } catch (e) {
          toastError(e);
        }
      },
    },
    "从链接导入"
  );

  return h(
    "div",
    h("div.page-head", h("h1", "规则"), h("span.sub", `${rules.length} 条`)),
    listHost,
    h(
      "div.panel",
      { style: { marginTop: "18px" } },
      h("h3", "新增 / 编辑规则"),
      editor,
      h("div.field", saveBtn),
      h("div.field", urlInput, importBtn),
      h(
        "div.note",
        "抓取与解析都在服务端进行,并且只会访问规则里 allowedHosts 列出的域名 —— 这是本服务器唯一的出站白名单。",
        h("br"),
        "改动即时生效(规则文件也会被热重载),旧版本会自动留备份。你对所添加规则指向的站点负责。"
      )
    )
  );
}
