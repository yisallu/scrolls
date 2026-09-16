// The player's chrome: builds the DOM, binds it to the engine, and keeps the two in
// sync. Deliberately UI-free *on the picture itself* — when the video pauses at the end
// of a sentence the frame just freezes, with no overlay covering it, and a click
// anywhere continues. That restraint is the whole feel of the thing.

import { h, clear, fmtTime } from "../dom.js";
import { PlayerEngine } from "./engine.js";
import { PresetStore, LocalPrefs, normValues } from "./presets.js";
import { Scope } from "./scope.js";

const ICON = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>',
  replay: '<path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>',
  vol: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>',
  mute: '<path d="M3 9v6h4l5 5V4L7 9H3zm13 0 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  fs: '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>',
  pip: '<path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>',
};

// SVG lives in its own namespace: document.createElement("svg") yields an unknown HTML
// element that renders nothing at all, so icons must be created with createElementNS.
function svg(path) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = path; // parsed in the SVG namespace because the parent is an SVG element
  return el;
}

const STATE_TEXT = {
  none: ["待载入", "待命"],
  idle: ["就绪 · 点击开始", "就绪"],
  armed: ["聆听中…", "聆听"],
  playing: ["播放中", "播放"],
  held: ["已暂停 · 点击继续", "暂停"],
  ended: ["已结束 · 点击重播", "结束"],
  looping: ["倒放循环 · 点击恢复", "循环"],
  frame: ["帧播放 · 滚轮/点击逐帧", "逐帧"],
};

const STATE_VAR = {
  playing: "--phosphor",
  armed: "--armed",
  held: "--hold",
  looping: "--loop",
  frame: "--frame",
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function slider(opts) {
  const el = h("input", { type: "range", class: "slider", ...opts });
  const paint = () => {
    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    el.style.setProperty("--p", ((Number(el.value) - min) / (max - min)) * 100 + "%");
  };
  el.addEventListener("input", paint);
  requestAnimationFrame(paint);
  el.repaint = paint;
  return el;
}

function control({ name, valueEl, input, hint, hidden }) {
  return h(
    "div.ctl",
    { hidden },
    h("div.ctl-row", h("span.ctl-name", name), valueEl),
    input,
    hint ? h("div.ctl-hint", hint) : null
  );
}

function toggleRow({ name, hint, input }) {
  return h(
    "div.toggle-row",
    h("div.t-txt", h("div.t-name", name), h("div.ctl-hint", hint)),
    h("label.switch", input, h("span.track"), h("span.knob"))
  );
}

/**
 * @param {object} opts
 * @param {(info:{position:number,duration:number,ended:boolean}) => void} [opts.onProgress]
 * @param {boolean} [opts.standalone] show the local-file picker instead of a library title
 */
export function createPlayer(opts = {}) {
  const prefs = new LocalPrefs("shadowplay.playback.v2", {
    // Everything the listener does is off until asked for: this is a video player
    // first. Segmentation used to be on by default, so opening any clip meant it
    // started pausing itself at every silence.
    autoSeg: false,
    rewindOn: false,
    rewindSpeed: 0.5,
    frameOn: false,
    frameFps: 30,
    frameStep: 1,
    frameInterval: 1,
    speed: 1,
    volume: 100,
  });
  const presets = new PresetStore();

  // ---- structure ---------------------------------------------------------------
  const video = h("video", { id: "video", playsinline: true, preload: "auto", crossorigin: "anonymous" });
  const loopCanvas = h("canvas.loop-canvas");
  const emptyBox = h("div.p-empty");
  const stage = h("div.p-stage", video, loopCanvas, emptyBox);

  /**
   * Size the stage to the video. Without this every clip sat in a 16:9 box, so
   * anything portrait or 4:3 was letterboxed inside a frame that was the wrong shape
   * to begin with. Reset on each new source, or the previous clip's shape sticks.
   */
  function fitStage() {
    const w = video.videoWidth;
    const h2 = video.videoHeight;
    if (w > 0 && h2 > 0) stage.style.setProperty("--ar", String(w / h2));
    else stage.style.removeProperty("--ar");
  }
  video.addEventListener("loadedmetadata", fitStage);
  video.addEventListener("emptied", () => stage.style.removeProperty("--ar"));

  const statusText = h("span", "待载入");
  const status = h("div.p-status", { dataset: { state: "none" } }, h("span.led"), statusText);

  const playBtn = h("button.iconbtn.primary", { title: "播放 / 暂停 (空格)", disabled: true }, svg(ICON.play));
  const replayBtn = h("button.iconbtn", { title: "重听本句 (R)", disabled: true }, svg(ICON.replay));
  const seek = slider({ class: "slider seek", min: 0, max: 1000, value: 0, disabled: true, "aria-label": "进度" });
  const curEl = h("span", "0:00");
  const durEl = h("span", "0:00");
  const speedSel = h(
    "select.speed",
    { title: "播放速度", "aria-label": "播放速度" },
    ...[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2].map((v) => h("option", { value: String(v) }, v === 1 ? "1×" : v + "×"))
  );
  const muteBtn = h("button.iconbtn", { title: "静音(只影响外放,不影响识别)" }, svg(ICON.vol));
  const vol = slider({ class: "slider vol", min: 0, max: 100, value: prefs.get("volume"), "aria-label": "音量" });
  const pipBtn = h("button.iconbtn", { title: "画中画" }, svg(ICON.pip));
  const fsBtn = h("button.iconbtn", { title: "全屏" }, svg(ICON.fs));

  const transport = h(
    "div.p-transport",
    playBtn,
    replayBtn,
    h("div.seekwrap", seek, h("span.time", curEl, " / ", durEl)),
    speedSel,
    h("div.volgroup", muteBtn, vol),
    document.pictureInPictureEnabled ? pipBtn : null,
    fsBtn
  );

  const tagsRow = h("div.p-tags", { hidden: true });

  // ---- listener panel -----------------------------------------------------------
  const rdLevel = h("span.v.live", "−∞ dB");
  const rdThr = h("span.v", "−45 dB");
  const rdState = h("span.v", "待命");
  const scopeCanvas = h("canvas.scope");
  const scope = new Scope(scopeCanvas);

  const presetSel = h("select.preset-sel", { "aria-label": "选择预设" });
  const modTag = h("span.modtag", { hidden: true }, "● 已修改");
  const updateBtn = h("button.pbtn", { title: "把当前数值存回这个预设", disabled: true }, "更新");
  const newBtn = h("button.pbtn", { title: "把当前数值另存为新预设" }, "另存为");
  const renameBtn = h("button.pbtn", { title: "重命名当前预设" }, "改名");
  const deleteBtn = h("button.pbtn.danger", { title: "删除当前预设" }, "删除");
  const editInput = h("input", { type: "text", maxlength: 20, placeholder: "预设名称" });
  const editMsg = h("span.emsg", { hidden: true });
  const editOk = h("button.pbtn.solid", "保存");
  const editCancel = h("button.pbtn", "取消");
  const presetMain = h(
    "div.preset-main",
    h("div.pleft", h("span.plabel", "预设"), presetSel, modTag),
    h("div.pbtns", updateBtn, newBtn, renameBtn, deleteBtn)
  );
  const presetEdit = h("div.preset-edit", { hidden: true }, editMsg, editInput, editOk, editCancel);

  const modeSilence = h("button.modebtn.active", { dataset: { mode: "silence" }, title: "声音低于固定阈值即暂停" }, "按静音");
  const modeAdaptive = h("button.modebtn", { dataset: { mode: "adaptive" }, title: "人声相对回落即暂停,自动适应背景音" }, "自适应人声");

  const thrVal = h("span.ctl-val", "−45 dB");
  const thrInput = slider({ min: -70, max: -20, step: 1, value: -45 });
  const ctlThr = control({
    name: "静音阈值",
    valueEl: thrVal,
    input: thrInput,
    hint: h("span", "低于这条", h("b.pink", "粉线"), "即判为静音。环境有底噪就往上调一点。"),
  });

  const dropVal = h("span.ctl-val", "9 dB");
  const dropInput = slider({ min: 3, max: 24, step: 1, value: 9 });
  const ctlDrop = control({
    name: "回落幅度",
    valueEl: dropVal,
    input: dropInput,
    hidden: true,
    hint: h("span", "声音比", h("b.pink", "最近人声电平"), "回落超过这么多分贝就算停顿。人声与背景音越接近,这里调得越小。"),
  });

  const gapVal = h("span.ctl-val", "0.60 s");
  const gapInput = slider({ min: 100, max: 2000, step: 50, value: 600 });
  const ctlGap = control({ name: "停顿判定时长", valueEl: gapVal, input: gapInput, hint: "静音持续超过这个时间才暂停。调长可避免词间停顿被误断。" });

  const autoSeg = h("input", { type: "checkbox", checked: prefs.get("autoSeg") });
  const rewindCb = h("input", { type: "checkbox", checked: prefs.get("rewindOn") });
  const rewindSpeed = slider({ min: 0.25, max: 1.5, step: 0.05, value: prefs.get("rewindSpeed") });
  const rewindSpeedVal = h("span.ctl-val", "0.50×");
  const ctlRewindSpeed = control({
    name: "循环速度",
    valueEl: rewindSpeedVal,
    input: rewindSpeed,
    hidden: !prefs.get("rewindOn"),
    hint: "倒放与正放循环时的速度。点击画面恢复正常播放后会还原。",
  });

  const frameCb = h("input", { type: "checkbox", checked: prefs.get("frameOn") });
  const frameIntervalInput = h("input.numin", { type: "number", min: 1, step: 1, value: prefs.get("frameInterval") });
  const frameIntervalVal = h("span.ctl-val", "逐帧");
  const ctlFrameInterval = control({
    name: "帧间隔",
    valueEl: frameIntervalVal,
    input: frameIntervalInput,
    hidden: !prefs.get("frameOn"),
    hint: "每隔多少帧取一帧:填 1 = 逐帧;填 24 = 只在第 24 / 48 / 72… 帧停留。",
  });
  const frameStepInput = slider({ min: 1, max: 10, step: 1, value: prefs.get("frameStep") });
  const frameStepVal = h("span.ctl-val", "1 帧/步");
  const ctlFrameStep = control({
    name: "步进速度",
    valueEl: frameStepVal,
    input: frameStepInput,
    hidden: !prefs.get("frameOn"),
    hint: "每滚动一格 / 每点击一次前进几格(帧间隔为 1 时即帧数)。",
  });
  const frameFpsInput = slider({ min: 1, max: 60, step: 1, value: prefs.get("frameFps") });
  const frameFpsVal = h("span.ctl-val", "30 fps");
  const ctlFrameFps = control({
    name: "帧率",
    valueEl: frameFpsVal,
    input: frameFpsInput,
    hidden: !prefs.get("frameOn"),
    hint: "视频每秒帧数,决定单帧时长(常见 24 / 25 / 30 / 60)。",
  });

  const listener = h(
    "section.p-listener",
    { hidden: true },
    h(
      "div.l-head",
      h("div.l-label", h("b", "聆听器"), h("span", "Listener")),
      h(
        "div.readouts",
        h("div.readout", h("span.k", "电平"), rdLevel),
        h("div.readout", h("span.k", "阈值"), rdThr),
        h("div.readout", h("span.k", "状态"), rdState)
      )
    ),
    h("div.scopewrap", scopeCanvas),
    h(
      "div.l-controls",
      h("div.presets", presetMain, presetEdit),
      h("div.modes", { role: "tablist" }, modeSilence, modeAdaptive),
      ctlThr,
      ctlDrop,
      ctlGap,
      toggleRow({ name: "自动断句", hint: "关掉就是普通播放器,不再按声音暂停。", input: autoSeg }),
      toggleRow({ name: "倒放循环跟读", hint: "到达暂停点后在本句内倒放→正放来回循环,点击画面立刻恢复。", input: rewindCb }),
      ctlRewindSpeed,
      toggleRow({ name: "帧播放", hint: "滚轮或点击画面逐帧推进;滚得越快画面走得越快。按 ▶ 或空格退出。", input: frameCb }),
      ctlFrameInterval,
      ctlFrameStep,
      ctlFrameFps
    )
  );

  const panelToggle = h(
    "button.panel-toggle",
    { type: "button", "aria-expanded": "false" },
    h("span.caret", "▾"),
    h("span", "聆听器设置")
  );

  const root = h("div.player", status, stage, transport, tagsRow, h("div.panelbar", panelToggle), listener);

  // ---- engine ------------------------------------------------------------------
  const engine = new PlayerEngine({ video, stage, canvas: loopCanvas });
  // Push the UI's state in rather than relying on the two defaults happening to agree:
  // the engine segments by default (that is its job), the player does not.
  engine.set("autoSeg", autoSeg.checked);
  engine.rewindOn = prefs.get("rewindOn");
  engine.rewindRate = prefs.get("rewindSpeed");
  engine.frameOn = prefs.get("frameOn");
  engine.frameFps = prefs.get("frameFps");
  engine.frameStep = prefs.get("frameStep");
  engine.frameInterval = prefs.get("frameInterval");
  engine.baseRate = prefs.get("speed");
  speedSel.value = String(prefs.get("speed"));
  engine.audio.setVolume(prefs.get("volume") / 100);

  // ---- binding: presets → sliders → engine ---------------------------------------

  function applyValues() {
    const c = presets.current;
    engine.mode = c.mode;
    engine.threshold = c.threshold;
    engine.gapMs = c.gap;
    engine.dropDb = c.drop;
    thrInput.value = c.threshold;
    gapInput.value = c.gap;
    dropInput.value = c.drop;
    thrInput.repaint();
    gapInput.repaint();
    dropInput.repaint();
    paintValues();
    paintMode();
  }

  function paintValues() {
    thrVal.textContent = `−${Math.abs(Math.round(engine.threshold))} dB`;
    gapVal.textContent = (engine.gapMs / 1000).toFixed(2) + " s";
    dropVal.textContent = Math.round(engine.dropDb) + " dB";
    rewindSpeedVal.textContent = engine.rewindRate.toFixed(2) + "×";
    frameStepVal.textContent = engine.frameStep + " 帧/步";
    frameFpsVal.textContent = Math.round(engine.frameFps) + " fps";
    frameIntervalVal.textContent = engine.frameInterval <= 1 ? "逐帧" : `每 ${engine.frameInterval} 帧`;
  }

  function paintMode() {
    modeSilence.classList.toggle("active", engine.mode === "silence");
    modeAdaptive.classList.toggle("active", engine.mode === "adaptive");
    ctlThr.hidden = engine.mode !== "silence";
    ctlDrop.hidden = engine.mode !== "adaptive";
  }

  function paintPresets() {
    clear(presetSel);
    if (!presets.activeId) presetSel.appendChild(h("option", { value: "__custom__" }, "自定义"));
    for (const p of presets.presets) presetSel.appendChild(h("option", { value: p.id }, p.name));
    presetSel.value = presets.activeId || "__custom__";
    const mod = presets.isModified();
    modTag.hidden = !mod;
    updateBtn.disabled = !mod;
    renameBtn.disabled = !presets.active;
    deleteBtn.disabled = !presets.active;
  }

  presets.addEventListener("change", () => {
    applyValues();
    paintPresets();
  });
  applyValues();
  paintPresets();
  presets.sync();

  const pushCurrent = () =>
    presets.setCurrent({ mode: engine.mode, threshold: engine.threshold, gap: engine.gapMs, drop: engine.dropDb });

  thrInput.addEventListener("input", () => {
    engine.threshold = parseFloat(thrInput.value);
    paintValues();
    pushCurrent();
  });
  gapInput.addEventListener("input", () => {
    engine.gapMs = parseFloat(gapInput.value);
    paintValues();
    pushCurrent();
  });
  dropInput.addEventListener("input", () => {
    engine.dropDb = parseFloat(dropInput.value);
    paintValues();
    pushCurrent();
  });
  for (const btn of [modeSilence, modeAdaptive]) {
    btn.addEventListener("click", () => {
      engine.set("mode", btn.dataset.mode);
      paintMode();
      pushCurrent();
    });
  }
  autoSeg.addEventListener("change", () => {
    prefs.set("autoSeg", autoSeg.checked);
    engine.set("autoSeg", autoSeg.checked);
  });

  presetSel.addEventListener("change", () => {
    if (presetSel.value !== "__custom__") presets.select(presetSel.value);
  });
  updateBtn.addEventListener("click", () => presets.updateActive());

  // Inline editor instead of prompt()/confirm(), which some browsers block outright.
  let editMode = null;
  function enterEdit(mode) {
    editMode = mode;
    presetMain.hidden = true;
    presetEdit.hidden = false;
    editOk.classList.toggle("danger", mode === "delete");
    if (mode === "delete") {
      editInput.hidden = true;
      editMsg.hidden = false;
      editMsg.textContent = `删除预设「${presets.active ? presets.active.name : ""}」?`;
      editOk.textContent = "删除";
      editOk.focus();
    } else {
      editInput.hidden = false;
      editMsg.hidden = true;
      editOk.textContent = "保存";
      editInput.value = mode === "rename" ? presets.active?.name || "" : "";
      editInput.placeholder = mode === "rename" ? "新名称" : "给这组设置起个名字";
      requestAnimationFrame(() => {
        editInput.focus();
        editInput.select();
      });
    }
  }
  function exitEdit() {
    editMode = null;
    presetEdit.hidden = true;
    presetMain.hidden = false;
  }
  function confirmEdit() {
    const value = editInput.value.trim();
    if (editMode === "new") presets.create(value);
    else if (editMode === "rename") presets.rename(value);
    else if (editMode === "delete") presets.removeActive();
    exitEdit();
  }
  newBtn.addEventListener("click", () => enterEdit("new"));
  renameBtn.addEventListener("click", () => presets.active && enterEdit("rename"));
  deleteBtn.addEventListener("click", () => presets.active && enterEdit("delete"));
  editOk.addEventListener("click", confirmEdit);
  editCancel.addEventListener("click", exitEdit);
  editInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEdit();
    }
  });

  // ---- rewind / frame prefs --------------------------------------------------------

  rewindCb.addEventListener("change", () => {
    engine.set("rewindOn", rewindCb.checked);
    ctlRewindSpeed.hidden = !rewindCb.checked;
    prefs.set("rewindOn", rewindCb.checked);
  });
  rewindSpeed.addEventListener("input", () => {
    engine.set("rewindRate", parseFloat(rewindSpeed.value));
    paintValues();
    prefs.set("rewindSpeed", engine.rewindRate);
  });
  frameCb.addEventListener("change", () => {
    engine.set("frameOn", frameCb.checked);
    ctlFrameInterval.hidden = ctlFrameStep.hidden = ctlFrameFps.hidden = !frameCb.checked;
    prefs.set("frameOn", frameCb.checked);
  });
  engine.addEventListener("frame-off", () => {
    frameCb.checked = false;
    ctlFrameInterval.hidden = ctlFrameStep.hidden = ctlFrameFps.hidden = true;
    prefs.set("frameOn", false);
  });
  frameStepInput.addEventListener("input", () => {
    engine.frameStep = parseInt(frameStepInput.value, 10) || 1;
    paintValues();
    prefs.set("frameStep", engine.frameStep);
  });
  frameFpsInput.addEventListener("input", () => {
    engine.frameFps = parseInt(frameFpsInput.value, 10) || 30;
    paintValues();
    prefs.set("frameFps", engine.frameFps);
  });
  frameIntervalInput.addEventListener("input", () => {
    engine.frameInterval = Math.max(1, parseInt(frameIntervalInput.value, 10) || 1);
    engine.jog.pending = 0;
    engine.jog.snapToGrid();
    paintValues();
    prefs.set("frameInterval", engine.frameInterval);
  });
  frameIntervalInput.addEventListener("change", () => {
    frameIntervalInput.value = String(engine.frameInterval);
    paintValues();
  });

  // ---- transport wiring --------------------------------------------------------------

  playBtn.addEventListener("click", () => engine.toggle());
  replayBtn.addEventListener("click", () => engine.replaySegment());
  stage.addEventListener("click", (e) => {
    if (e.target.closest(".p-empty")) return; // let the empty-state buttons work
    engine.stageClick(e);
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      if (engine.state !== "frame") return;
      e.preventDefault();
      engine.jog.request((e.deltaY > 0 ? 1 : -1) * engine.frameStep);
    },
    { passive: false }
  );

  let seeking = false;
  seek.addEventListener("input", () => {
    seeking = true;
    if (video.duration) curEl.textContent = fmtTime((seek.value / 1000) * video.duration);
  });
  seek.addEventListener("change", () => {
    if (video.duration) engine.seekTo((seek.value / 1000) * video.duration);
    seeking = false;
  });

  speedSel.addEventListener("change", () => {
    engine.set("baseRate", parseFloat(speedSel.value) || 1);
    prefs.set("speed", engine.baseRate);
  });

  function applyVolume() {
    const v = vol.value / 100;
    engine.audio.setVolume(v);
    clear(muteBtn).appendChild(svg(v === 0 ? ICON.mute : ICON.vol));
    prefs.set("volume", Number(vol.value));
  }
  vol.addEventListener("input", applyVolume);
  let lastVol = Number(vol.value) || 100;
  muteBtn.addEventListener("click", () => {
    if (Number(vol.value) > 0) {
      lastVol = Number(vol.value);
      vol.value = 0;
    } else {
      vol.value = lastVol || 100;
    }
    vol.repaint();
    applyVolume();
  });

  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
  });
  pipBtn.addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* denied or unsupported */
    }
  });

  // ---- panel ------------------------------------------------------------------------
  // Collapsed on every load: the player should open to a clean picture, not a console.
  let panelOpen = false;
  function applyPanel() {
    listener.hidden = !panelOpen;
    panelToggle.setAttribute("aria-expanded", String(panelOpen));
    panelToggle.classList.toggle("open", panelOpen);
    panelToggle.lastChild.textContent = panelOpen ? "收起聆听器" : "聆听器设置";
    if (panelOpen) scope.resize(); // it measured 0 while display:none
  }
  panelToggle.addEventListener("click", () => {
    panelOpen = !panelOpen;
    applyPanel();
  });
  applyPanel();

  // ---- engine → UI --------------------------------------------------------------------

  engine.addEventListener("state", () => {
    const s = engine.state;
    const [text, short] = STATE_TEXT[s] || STATE_TEXT.none;
    statusText.textContent = text;
    status.dataset.state = s;
    rdState.textContent = short;
    clear(playBtn).appendChild(svg(s === "armed" || s === "playing" ? ICON.pause : ICON.play));
    stage.classList.toggle("clickable", ["idle", "held", "ended", "looping", "frame"].includes(s));
  });

  engine.addEventListener("loaded", () => {
    emptyBox.hidden = true;
    for (const el of [playBtn, replayBtn, seek, muteBtn]) el.disabled = false;
    durEl.textContent = fmtTime(video.duration);
  });

  engine.addEventListener("time", () => {
    curEl.textContent = fmtTime(video.currentTime);
    if (!seeking && video.duration) {
      seek.value = (video.currentTime / video.duration) * 1000;
      seek.repaint();
    }
  });

  engine.addEventListener("level", (e) => {
    const { now, db, eff, ready } = e.detail;
    rdLevel.textContent = !ready || db <= -80 ? "−∞ dB" : `−${Math.abs(Math.round(db))} dB`;
    rdLevel.style.color = ready && db >= eff ? css("--phosphor") : css("--text-dim");
    rdThr.textContent =
      engine.mode === "adaptive" ? (ready ? `−${Math.abs(Math.round(eff))} dB` : "自适应") : `−${Math.abs(engine.threshold)} dB`;
    if (!panelOpen) return; // no point drawing a hidden canvas
    if (ready) scope.push(now, db);
    scope.draw(now, Math.max(db, -80), {
      threshold: eff,
      accent: css(STATE_VAR[engine.state] || "--text-faint"),
      thresholdColor: css("--danger"),
      mono: css("--mono") || "monospace",
    });
  });

  // ---- keyboard ------------------------------------------------------------------------

  function onKey(e) {
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
      if (t.type === "text" || t.type === "number" || t.type === "search" || t.tagName === "TEXTAREA") return;
    }
    if (engine.state === "frame" && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
      e.preventDefault();
      engine.jog.request((e.code === "ArrowRight" ? 1 : -1) * engine.frameStep);
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      engine.toggle();
    } else if (e.code === "ArrowLeft") engine.seekBy(-5);
    else if (e.code === "ArrowRight") engine.seekBy(5);
    else if (e.key === "r" || e.key === "R") engine.replaySegment();
    else if (e.key === "f" || e.key === "F") fsBtn.click();
  }
  window.addEventListener("keydown", onKey);

  const onResize = () => panelOpen && scope.resize();
  window.addEventListener("resize", onResize);

  // ---- progress reporting ---------------------------------------------------------------

  let progressTimer = null;
  if (opts.onProgress) {
    progressTimer = setInterval(() => {
      if (!video.duration || video.paused) return;
      opts.onProgress({ position: video.currentTime, duration: video.duration, ended: false });
    }, 8000);
    video.addEventListener("pause", () => {
      if (video.duration) opts.onProgress({ position: video.currentTime, duration: video.duration, ended: false });
    });
    video.addEventListener("ended", () => opts.onProgress({ position: 0, duration: video.duration, ended: true }));
  }

  // ---- public surface ---------------------------------------------------------------------

  function setEmpty(node) {
    clear(emptyBox).appendChild(node);
    emptyBox.hidden = false;
  }

  function setTags(tags, siteId) {
    clear(tagsRow);
    const list = Array.isArray(tags) ? tags.filter(Boolean) : [];
    tagsRow.hidden = !list.length;
    for (const t of list) {
      tagsRow.appendChild(
        siteId
          ? h("a.t", { href: `/search?site=${encodeURIComponent(siteId)}&kw=${encodeURIComponent(t)}` }, t)
          : h("span.t", t)
      );
    }
  }

  let hls = null;
  function loadMedia({ src, type, startAt = 0 }) {
    hls?.destroy();
    hls = null;
    emptyBox.hidden = true;
    const isHls = type === "hls" || /\.m3u8(\?|$)/i.test(src);
    if (isHls && window.Hls?.isSupported()) {
      hls = new window.Hls({ enableWorker: true });
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (data?.fatal) console.warn("HLS fatal:", data.type, data.details);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      engine.loadSource(src);
    }
    if (startAt > 0) {
      const seekOnce = () => {
        try {
          video.currentTime = startAt;
          engine.segStart = startAt;
        } catch {
          /* not seekable */
        }
        video.removeEventListener("loadedmetadata", seekOnce);
      };
      video.addEventListener("loadedmetadata", seekOnce);
    }
  }

  function destroy() {
    clearInterval(progressTimer);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    hls?.destroy();
    engine.destroy();
  }

  const player = { el: root, engine, video, stage, loadMedia, setEmpty, setTags, destroy, presets };
  root.__player = player; // reachable from devtools for debugging a live session
  return player;
}

export { normValues };
