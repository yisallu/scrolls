// ShadowPlay engine — 有声则播 · 静音则停.
//
// It watches the level of the audio that is actually playing and pauses the video the
// moment a sentence ends, so you can repeat it. Everything else here exists to make
// that loop feel physical: two ways of deciding what "silence" means, a rewind loop
// that ping-pongs inside the sentence you just heard, and a frame-by-frame jog.
//
// The three things that are NOT obvious, learned the hard way:
//
//  1. Reverse playback cannot be done by seeking backwards. Rapid backward seeks on a
//     paused <video> simply never repaint — the picture freezes for the whole leg and
//     then jumps. The only thing that works is to snapshot frames into a ring buffer
//     while playing forward and blit them back onto a canvas. (See RewindLoop.)
//  2. Single-frame seeks must be coalesced behind the `seeked` event, or a fast scroll
//     hammers currentTime and the element stops repainting. (See FrameJog.)
//  3. Escaping the rewind loop must call play() unconditionally — never gated on a
//     `seeked` event that may never fire — plus a watchdog, because a pause()→play()
//     race can swallow the play() and leave the video dead to clicks.

const SOUND_CONFIRM_MS = 80; // sound must persist this long to count as an utterance start
const PT_SILENCE_MS = 120;   // sustained silence needed to re-arm after a manual escape
const BASELINE_RELEASE_DB_S = 3; // adaptive peak-follower release rate

export const STATES = ["none", "idle", "armed", "playing", "held", "ended", "looping", "frame"];

export class PlayerEngine extends EventTarget {
  /**
   * @param {{video: HTMLVideoElement, stage: HTMLElement, canvas: HTMLCanvasElement}} els
   */
  constructor({ video, stage, canvas }) {
    super();
    this.video = video;
    this.stage = stage;
    this.canvas = canvas;
    this.ctx2d = canvas.getContext("2d");

    // ---- tunables (mirrored by the UI) ----
    this.mode = "silence";       // "silence" | "adaptive"
    this.threshold = -45;        // dBFS, absolute mode
    this.gapMs = 600;            // how long silence must last before pausing
    this.dropDb = 9;             // adaptive mode: dB below the recent voice level
    this.autoSeg = true;
    this.baseRate = 1;           // normal playback speed

    this.rewindOn = false;
    this.rewindRate = 0.5;

    this.frameOn = false;
    this.frameFps = 30;
    this.frameStep = 1;          // grid cells advanced per wheel notch / click
    this.frameInterval = 1;      // "only land on multiples of N frames"

    // ---- runtime ----
    this.state = "none";
    this.level = -120;
    this.baseline = -50;
    this.segStart = 0;
    this.lastSegStart = 0;

    this._soundStart = null;
    this._silenceStart = null;
    this._playThrough = false;   // glide past the utterance we just escaped from
    this._ptSilenceSeen = false;
    this._ptSilenceAt = null;
    this._lastNow = null;
    this._raf = null;

    this.audio = new AudioGraph(video);
    this.rewind = new RewindLoop(this);
    this.jog = new FrameJog(this);

    this._bindVideo();
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  // ---- events ------------------------------------------------------------------

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  set(prop, value) {
    this[prop] = value;
    if (prop === "mode" && (this.state === "playing" || this.state === "armed")) {
      // switching interpretation mid-sentence: restart the measurement cleanly
      this.segStart = this.video.currentTime;
      this.baseline = -50;
      this._soundStart = this._silenceStart = null;
      this.setState(this.armState());
    }
    if (prop === "baseRate" && this.state !== "looping" && this.state !== "frame") {
      this.video.playbackRate = value;
    }
    if (prop === "rewindRate" && this.state === "looping") this.video.playbackRate = value;
    if (prop === "rewindOn" && !value) {
      if (this.state === "looping") this.exitRewindLoop();
      this.rewind.clear();
    }
    if (prop === "frameOn") value ? this.enterFrameMode() : this.exitFrameMode(false);
    if (prop === "frameInterval") this.jog.snapToGrid();
    if (prop === "autoSeg" && (this.state === "playing" || this.state === "armed")) {
      this.setState(this.armState());
      this._soundStart = this._silenceStart = null;
    }
  }

  // ---- derived ------------------------------------------------------------------

  effectiveThreshold() {
    return this.mode === "adaptive" ? this.baseline - this.dropDb : this.threshold;
  }
  armState() {
    return this.autoSeg ? "armed" : "playing";
  }

  // ---- sources -------------------------------------------------------------------

  loadSource(url, { objectUrl = false } = {}) {
    this.rewind.teardown();
    this.rewind.showCanvas(false);
    this.rewind.clear();
    this.video.playbackRate = this.baseRate;
    this._playThrough = false;
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    if (objectUrl) this._objectUrl = url;
    this.video.src = url;
    this.video.load();
  }

  _bindVideo() {
    const v = this.video;
    v.addEventListener("loadedmetadata", () => {
      this.segStart = 0;
      this.lastSegStart = 0;
      this.setState("idle");
      this.emit("loaded");
      if (this.frameOn) this.enterFrameMode(); // re-engage a persisted jog session
    });
    v.addEventListener("error", () => {
      if (!v.src) return;
      this.setState("none");
      this.emit("error", v.error);
    });
    v.addEventListener("ended", () => {
      this.rewind.teardown();
      this.rewind.showCanvas(false);
      v.playbackRate = this.baseRate;
      this.setState("ended");
    });
    v.addEventListener("timeupdate", () => this.emit("time"));
    v.addEventListener("seeked", () => this.jog.onSeeked());
  }

  // ---- transport --------------------------------------------------------------------

  startOrResume() {
    if (this.state === "none") return;
    this.rewind.teardown();
    this.rewind.showCanvas(false);
    this.video.playbackRate = this.baseRate;
    this.audio.ensure();
    this.segStart = this.video.currentTime;
    this._soundStart = this._silenceStart = null;
    this.baseline = -50;
    this._playThrough = false;
    this.setState(this.armState());
    this.video.play().catch(() => {});
  }

  manualPause() {
    if (this.state !== "armed" && this.state !== "playing") return;
    this.video.pause();
    this.setState("held");
  }

  pauseForSilence() {
    this.lastSegStart = this.segStart;
    this.video.pause();
    this.setState("held");
    this.emit("segment-end");
  }

  toggle() {
    const s = this.state;
    if (s === "frame") this.exitFrameMode(true);
    else if (s === "looping") this.exitRewindLoop();
    else if (s === "armed" || s === "playing") this.manualPause();
    else if (s === "held" || s === "idle") this.startOrResume();
    else if (s === "ended") {
      this.video.currentTime = 0;
      this.startOrResume();
    }
  }

  /** Click on the picture: only ever "continue". It must never pause. */
  stageClick(e) {
    if (this.state === "frame") {
      this.jog.request((e && (e.shiftKey || e.altKey) ? -1 : 1) * this.frameStep);
      return;
    }
    if (this.state === "looping") this.exitRewindLoop();
    else if (this.state === "held" || this.state === "idle") this.startOrResume();
    else if (this.state === "ended") {
      this.video.currentTime = 0;
      this.startOrResume();
    }
  }

  replaySegment() {
    if (this.state === "none" || this.state === "frame") return;
    this.rewind.teardown();
    this.rewind.showCanvas(false);
    this.video.playbackRate = this.baseRate;
    const target = this.state === "held" || this.state === "ended" ? this.lastSegStart : this.segStart;
    this.audio.ensure();
    try {
      this.video.currentTime = target;
    } catch {
      /* not seekable yet */
    }
    this.segStart = target;
    this._soundStart = this._silenceStart = null;
    this.baseline = -50;
    this.setState(this.armState());
    this.video.play().catch(() => {});
  }

  seekBy(seconds) {
    if (!this.video.duration) return;
    if (this.state === "looping") this.exitRewindLoop();
    this.seekTo(Math.max(0, Math.min(this.video.duration, this.video.currentTime + seconds)));
  }

  seekTo(t) {
    const wasLooping = this.state === "looping";
    this._playThrough = false; // a deliberate reposition: normal stops resume
    if (wasLooping) {
      this.rewind.teardown();
      this.rewind.showCanvas(false);
      this.video.playbackRate = this.baseRate;
    }
    this.video.currentTime = t;
    this.segStart = t;
    this._soundStart = this._silenceStart = null;
    if (wasLooping) {
      this.setState(this.armState());
      this.video.play().catch(() => {});
    }
  }

  // ---- rewind loop (倒放循环跟读) -------------------------------------------------

  startRewindLoop() {
    this.lastSegStart = this.segStart;
    this.rewind.start(this.segStart, this.video.currentTime);
  }

  exitRewindLoop() {
    this.rewind.exit();
  }

  // ---- frame jog (帧播放) ------------------------------------------------------------

  enterFrameMode() {
    if (this.state === "none") return; // engaged on loadedmetadata instead
    this.rewind.teardown();
    this.rewind.showCanvas(false);
    this.video.playbackRate = this.baseRate;
    this.jog.reset();
    this.video.pause();
    this.setState("frame");
    this.jog.snapToGrid();
  }

  /** resume=true → play on from this frame; otherwise stay parked on it. */
  exitFrameMode(resume) {
    if (this.state !== "frame") return;
    this.jog.reset();
    this.frameOn = false;
    this.emit("frame-off");
    if (resume) this.startOrResume();
    else this.setState("held");
  }

  // ---- the loop ---------------------------------------------------------------------

  _tick(now) {
    this._raf = requestAnimationFrame(this._tick);
    this.rewind.capture(now);

    const db = this.audio.readLevel();
    this.level = db;

    // Adaptive baseline: instant attack, ~3 dB/s release, so it stays near the voice
    // level through a pause instead of chasing the level down into the silence.
    const rawDt = this._lastNow == null ? 0 : (now - this._lastNow) / 1000;
    const dt = Math.min(rawDt, 0.1);
    this._lastNow = now;

    // Hidden tabs stop firing rAF, so coming back can leave hour-old timestamps in
    // the detector — which would read as "silence has lasted forever" and pause
    // instantly, mid-sentence. Treat any gap over a second as a fresh start.
    if (rawDt > 1) {
      this._soundStart = this._silenceStart = null;
      this._ptSilenceAt = null;
      if (this.state === "playing") this.segStart = this.video.currentTime;
    }
    if (this.audio.ready) {
      this.baseline = db > this.baseline ? db : Math.max(db, this.baseline - BASELINE_RELEASE_DB_S * dt);
    }

    const eff = this.effectiveThreshold();
    this.emit("level", { now, db, eff, ready: this.audio.ready });

    if (!this.autoSeg) return;

    // After a manual escape: glide through the REST of the escaped utterance, then
    // re-arm at the next one. Gated on real playback because the escape's own seek
    // reads as a silence blip and would otherwise re-arm on the same sentence.
    if (this._playThrough && !this.video.seeking && !this.video.paused) {
      if (db < eff) {
        if (this._ptSilenceAt === null) this._ptSilenceAt = now;
        if (now - this._ptSilenceAt >= PT_SILENCE_MS) this._ptSilenceSeen = true;
      } else {
        this._ptSilenceAt = null;
        if (this._ptSilenceSeen) this._playThrough = false;
      }
    }

    if (this.state === "armed") {
      if (db >= eff) {
        if (this._soundStart === null) this._soundStart = now;
        if (now - this._soundStart >= SOUND_CONFIRM_MS) {
          this.setState("playing");
          this._silenceStart = null;
        }
      } else {
        this._soundStart = null;
      }
    } else if (this.state === "playing") {
      if (db < eff) {
        if (this._silenceStart === null) this._silenceStart = now;
        if (now - this._silenceStart >= this.gapMs && !this._playThrough) {
          this.rewindOn ? this.startRewindLoop() : this.pauseForSilence();
        }
      } else {
        this._silenceStart = null;
      }
    }
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this.rewind.teardown();
    this.rewind.clear();
    this.audio.close();
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
  }
}

// ---------------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------------

/**
 * source → analyser → gain → speakers.
 *
 * The analyser taps the FULL-volume signal, so turning the volume down does not make
 * the detector think the video went quiet. createMediaElementSource can only ever be
 * called once per element, so this object owns the element for the page's lifetime.
 */
export class AudioGraph {
  constructor(video) {
    this.video = video;
    this.ready = false;
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.buf = null;
    this.volume = 1;
  }

  ensure() {
    if (this.ready) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      console.warn("Web Audio unavailable — automatic segmentation is disabled");
      return;
    }
    this.ctx = new AC();
    this.src = this.ctx.createMediaElementSource(this.video);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.25;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.src.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.video.volume = 1; // loudness is the gain node's job from here on
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.ready = true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
    else this.video.volume = v; // before the graph exists
  }

  /** RMS of the current window, in dBFS. −120 when there is nothing to read. */
  readLevel() {
    if (!this.ready) return -120;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = (this.buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.buf.length);
    return 20 * Math.log10(Math.max(rms, 1e-7));
  }

  close() {
    try {
      this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ready = false;
  }
}

// ---------------------------------------------------------------------------------
// Rewind loop
// ---------------------------------------------------------------------------------

const CAP_FPS = 30;                       // snapshot rate while playing forward
const CAP_MAX_W = 1920;                   // ceiling so 4K fullscreen can't explode memory
const BUF_MS = 12000;                     // time window kept
const BUF_MAX_BYTES = 384 * 1024 * 1024;  // hard memory budget

/**
 * At a pause point, ping-pong inside the utterance just heard: rewind to its start,
 * play forward, repeat — both legs at the loop speed.
 *
 * Forward leg = real playback (you hear it). Reverse leg = cached frames blitted onto
 * an overlay canvas while the video stays paused, because <video> has no negative rate
 * and backward seeking does not repaint. Frames are captured at the ON-SCREEN size, so
 * the rewind looks exactly as sharp as the video (an early fixed-360px version was
 * visibly blurry), through a canvas pool so the steady state allocates nothing.
 */
export class RewindLoop {
  constructor(engine) {
    this.e = engine;
    this.buf = [];
    this.pool = [];
    this.bytes = 0;
    this.lastCapTs = -1e9;
    this.lastPainted = null;
    this.raf = null;
    this.lastTs = null;
    this.shown = false;
    this.from = 0;
    this.to = 0;
    this.pos = 0;
  }

  clear() {
    for (const f of this.buf) {
      f.c.width = f.c.height = 0;
    }
    this.buf = [];
    this.pool = [];
    this.bytes = 0;
    this.lastPainted = null;
  }

  captureWidth() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.max(160, Math.min(CAP_MAX_W, Math.ceil((this.e.stage.clientWidth || 884) * dpr)));
  }

  capture(nowTs) {
    const { e } = this;
    const v = e.video;
    if (!e.rewindOn || v.paused || v.seeking || !v.videoWidth) return;
    if (e.state !== "armed" && e.state !== "playing") return; // only true forward playback
    if (nowTs - this.lastCapTs < 1000 / CAP_FPS) return;
    this.lastCapTs = nowTs;

    const scale = Math.min(1, this.captureWidth() / v.videoWidth);
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const c = this.pool.pop() || document.createElement("canvas");
    if (c.width !== w) c.width = w; // resizing reallocates; only do it on a real change
    if (c.height !== h) c.height = h;
    try {
      c.getContext("2d").drawImage(v, 0, 0, w, h);
    } catch {
      this.pool.push(c); // tainted canvas (non-CORS source) — nothing to cache
      return;
    }
    const bytes = w * h * 4;
    this.buf.push({ t: v.currentTime, c, bytes });
    this.bytes += bytes;

    // Keep the current utterance, the last BUF_MS, and stay inside the byte budget.
    const minT = Math.max(e.segStart - 0.15, v.currentTime - BUF_MS / 1000);
    while (this.buf.length > 2 && (this.buf[0].t < minT || this.bytes > BUF_MAX_BYTES)) {
      const old = this.buf.shift();
      this.bytes -= old.bytes;
      if (this.pool.length < 4) this.pool.push(old.c);
      else old.c.width = old.c.height = 0;
    }
  }

  paintAt(pos) {
    if (!this.buf.length) return;
    let best = this.buf[0];
    let bestD = Math.abs(best.t - pos);
    for (let i = 1; i < this.buf.length; i++) {
      const d = Math.abs(this.buf[i].t - pos);
      if (d < bestD) {
        bestD = d;
        best = this.buf[i];
      }
    }
    if (best === this.lastPainted) return; // already on screen — skip the blit
    this.lastPainted = best;
    const cv = this.e.canvas;
    if (cv.width !== best.c.width) cv.width = best.c.width;
    if (cv.height !== best.c.height) cv.height = best.c.height;
    this.e.ctx2d.drawImage(best.c, 0, 0);
  }

  showCanvas(show) {
    if (show === this.shown) return;
    this.shown = show;
    this.e.canvas.style.display = show ? "block" : "none";
  }

  teardown() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.lastTs = null;
  }

  ready() {
    return this.buf.length >= 2 && this.buf.some((f) => f.t <= this.to + 0.05);
  }

  start(from, to) {
    this.from = from;
    this.to = to;
    // Too short, or nothing captured to rewind through → behave like a normal pause.
    if (!(to - from > 0.2) || !this.ready()) {
      this.e.pauseForSilence();
      return;
    }
    this.e.setState("looping");
    this.reversePhase();
  }

  /** Reverse leg: the video stays paused; walk pos down and blit cached frames. */
  reversePhase() {
    this.teardown();
    const { e } = this;
    e.video.pause();
    this.pos = this.to;
    this.lastPainted = null;
    this.showCanvas(true);
    this.paintAt(this.pos);
    let preSeeked = false;

    const step = (ts) => {
      if (e.state !== "looping") return;
      if (this.lastTs == null) this.lastTs = ts;
      const dt = Math.min((ts - this.lastTs) / 1000, 0.1);
      this.lastTs = ts;
      this.pos -= e.rewindRate * dt;

      // Pre-seek the hidden video shortly before the turnaround so the seek finishes
      // behind the still-running canvas animation — no freeze at the bottom of the loop.
      if (!preSeeked && this.pos <= this.from + 0.35) {
        preSeeked = true;
        try {
          e.video.currentTime = this.from;
        } catch {
          /* ignore */
        }
      }
      if (this.pos <= this.from) {
        this.paintAt(this.from);
        if (!preSeeked) {
          try {
            e.video.currentTime = this.from;
          } catch {
            /* ignore */
          }
        }
        this.forwardPhase();
        return;
      }
      this.paintAt(this.pos);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /** Forward leg: real playback at the loop speed; reveal once it is actually moving. */
  forwardPhase() {
    this.teardown();
    const { e } = this;
    e.video.playbackRate = e.rewindRate;
    e.video.play().catch(() => {});
    // The seek to `from` is async, so currentTime may still read ≈ `to` for a frame or
    // two. Only arm the upper-bound check after the playhead has been SEEN below it,
    // otherwise a stale reading bounces straight back and the forward leg is skipped.
    let armedTop = false;
    const watch = () => {
      if (e.state !== "looping") return;
      const ct = e.video.currentTime;
      if (!armedTop && ct < this.to - 0.05) armedTop = true;
      if (this.shown && armedTop && !e.video.seeking && ct > this.from + 0.02) this.showCanvas(false);
      if (armedTop && ct >= this.to) {
        e.video.pause();
        try {
          e.video.currentTime = this.to;
        } catch {
          /* ignore */
        }
        this.reversePhase();
        return;
      }
      this.raf = requestAnimationFrame(watch);
    };
    this.raf = requestAnimationFrame(watch);
  }

  /**
   * Leave the loop and resume normal forward play — from the frame ON SCREEN, so there
   * is no jump. play() is issued unconditionally and re-issued by a watchdog: gating it
   * on a `seeked` event that never fires is what used to leave the video dead to clicks.
   */
  exit() {
    const { e } = this;
    if (e.state !== "looping") return;
    const onCanvas = this.shown;
    const resumeAt = onCanvas ? this.pos : e.video.currentTime;
    this.teardown();
    e.video.playbackRate = e.baseRate;
    e.segStart = resumeAt;
    e._soundStart = e._silenceStart = null;
    e.baseline = -50;
    e._playThrough = true;
    e._ptSilenceSeen = false;
    e._ptSilenceAt = null;
    e.setState(e.armState());

    if (onCanvas && Math.abs(e.video.currentTime - resumeAt) > 0.03) {
      this.paintAt(resumeAt); // hold the resume frame on the canvas over the seek
      try {
        e.video.currentTime = resumeAt;
      } catch {
        /* ignore */
      }
    }
    e.video.play().catch(() => {});

    let tries = 0;
    const ensurePlay = () => {
      if (e.state !== "armed" && e.state !== "playing") return;
      if (!e.video.paused) return;
      if (++tries > 40) return;
      e.video.play().catch(() => {});
      setTimeout(ensurePlay, 35);
    };
    setTimeout(ensurePlay, 35);

    if (!onCanvas) return; // forward leg: the video is already visible
    let frames = 0;
    const reveal = () => {
      if (!this.shown || e.state === "looping") return;
      if ((!e.video.seeking && e.video.currentTime > resumeAt + 0.02) || ++frames > 24) {
        this.showCanvas(false);
        return;
      }
      requestAnimationFrame(reveal);
    };
    requestAnimationFrame(reveal);
  }
}

// ---------------------------------------------------------------------------------
// Frame jog
// ---------------------------------------------------------------------------------

/**
 * Manual scrubbing: the video stays paused and the playhead advances one step at a
 * time, driven by the wheel or by clicking — so playback speed simply follows how fast
 * you scroll.
 *
 * 帧间隔 (interval) N means "only ever land on frames that are multiples of N", which is
 * why the accumulator counts GRID CELLS rather than frames: one step = N frames when
 * N > 1, and exactly the old per-frame behaviour when N = 1.
 */
export class FrameJog {
  constructor(engine) {
    this.e = engine;
    this.pending = 0;
    this.busy = false;
  }

  reset() {
    this.pending = 0;
    this.busy = false;
  }

  /** @param {number} cells signed grid cells to enqueue (call sites pass ±步进速度) */
  request(cells) {
    const { e } = this;
    if (e.state !== "frame" || !e.video.duration) return;
    this.pending += cells;
    this.flush();
  }

  flush() {
    const { e } = this;
    if (e.state !== "frame" || this.busy || !this.pending || !e.video.duration) return;
    const fps = Math.max(1, e.frameFps);
    const N = Math.max(1, Math.floor(e.frameInterval));
    const m = this.pending;
    this.pending = 0;

    let t;
    if (N <= 1) {
      t = e.video.currentTime + m / fps; // identical to plain per-frame stepping
    } else {
      // Snap onto the N-frame grid: forward → the next grid line ahead, then +cells;
      // backward mirrors it.
      const dir = m > 0 ? 1 : -1;
      const gridPos = (e.video.currentTime * fps) / N;
      const idx = dir > 0 ? Math.floor(gridPos + 1e-6) : Math.ceil(gridPos - 1e-6);
      t = ((idx + m) * N) / fps;
    }
    this.seek(t);
  }

  /** Align onto the nearest grid multiple (on entering the mode, or when N changes). */
  snapToGrid() {
    const { e } = this;
    if (e.state !== "frame" || this.busy || !e.video.duration) return;
    const N = Math.max(1, Math.floor(e.frameInterval));
    if (N <= 1) return;
    const fps = Math.max(1, e.frameFps);
    this.seek((Math.round((e.video.currentTime * fps) / N) * N) / fps);
  }

  seek(t) {
    const { e } = this;
    t = Math.max(0, Math.min(e.video.duration - 1e-3, t));
    if (Math.abs(t - e.video.currentTime) < 1e-4) return;
    this.busy = true;
    try {
      e.video.currentTime = t;
    } catch {
      this.busy = false;
    }
  }

  /** One outstanding seek at a time: bursts merge into a single jump that lands. */
  onSeeked() {
    if (!this.busy) return;
    this.busy = false;
    if (this.e.state === "frame") this.flush();
  }
}
