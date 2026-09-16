// The player's logic, tested without a browser.
//
// The frame-jog grid maths and the segmentation state machine are the two places where
// an off-by-one is invisible until you are actually shadowing a sentence, so they get
// unit tests driven by a fake <video> and a scripted level meter.

import test from "node:test";
import assert from "node:assert/strict";

// --- minimal DOM shims, installed before importing the engine ---
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = { devicePixelRatio: 1 };
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ({ drawImage() {} }) }),
};

const { PlayerEngine, FrameJog } = await import("../web/src/player/engine.js");

class FakeVideo {
  constructor({ duration = 100 } = {}) {
    this.currentTime = 0;
    this.duration = duration;
    this.paused = true;
    this.seeking = false;
    this.playbackRate = 1;
    this.videoWidth = 0;
    this.volume = 1;
    this.listeners = {};
    this.pauseCount = 0;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn();
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.pauseCount++;
  }
}

const fakeCanvas = () => ({ width: 0, height: 0, style: {}, getContext: () => ({ drawImage() {} }) });

function makeEngine(opts = {}) {
  const video = new FakeVideo(opts);
  const engine = new PlayerEngine({ video, stage: { clientWidth: 800 }, canvas: fakeCanvas() });
  engine.audio.ready = true;
  engine.audio.ensure = () => {};
  return { engine, video };
}

/** Drive the detector: feed `db` for `ms` milliseconds of wall clock, 16 ms per tick. */
function feed(engine, db, ms, startAt = 0) {
  let t = startAt;
  const end = startAt + ms;
  while (t <= end) {
    engine.audio.readLevel = () => db;
    engine._tick(t);
    t += 16;
  }
  return t;
}

// ---------------------------------------------------------------------------------
// Frame jog
// ---------------------------------------------------------------------------------

function jogSetup({ fps = 30, interval = 1, step = 1, at = 0, duration = 100 } = {}) {
  const video = new FakeVideo({ duration });
  video.currentTime = at;
  const engine = { state: "frame", video, frameFps: fps, frameInterval: interval, frameStep: step };
  const jog = new FrameJog(engine);
  engine.jog = jog;
  return { jog, video, engine };
}

/** Apply one user action and let the coalesced seek land. */
function jogStep(ctx, cells) {
  ctx.jog.request(cells);
  ctx.jog.onSeeked();
  return +ctx.video.currentTime.toFixed(6);
}

test("frame jog, 逐帧 (interval 1): one notch is exactly one frame", () => {
  const ctx = jogSetup({ fps: 30 });
  assert.equal(jogStep(ctx, 1), +(1 / 30).toFixed(6));
  assert.equal(jogStep(ctx, 1), +(2 / 30).toFixed(6));
  assert.equal(jogStep(ctx, -1), +(1 / 30).toFixed(6));
});

test("frame jog, 步进速度 3: one notch is three frames", () => {
  const ctx = jogSetup({ fps: 30, step: 3 });
  assert.equal(jogStep(ctx, 3), +(3 / 30).toFixed(6));
});

test("frame jog, 帧间隔 24: lands only on multiples of 24", () => {
  const ctx = jogSetup({ fps: 30, interval: 24 });
  assert.equal(jogStep(ctx, 1), 24 / 30, "0 → frame 24");
  assert.equal(jogStep(ctx, 1), 48 / 30, "24 → 48");
  assert.equal(jogStep(ctx, 1), 72 / 30, "48 → 72");
  assert.equal(jogStep(ctx, -1), 48 / 30, "and back down the grid");
});

test("frame jog from mid-grid snaps to the next grid line, both directions", () => {
  const fwd = jogSetup({ fps: 30, interval: 24, at: 50 / 30 }); // frame 50, between 48 and 72
  assert.equal(jogStep(fwd, 1), 72 / 30);
  const back = jogSetup({ fps: 30, interval: 24, at: 50 / 30 });
  assert.equal(jogStep(back, -1), 48 / 30);
});

test("frame jog: snapToGrid aligns on entering the mode", () => {
  const ctx = jogSetup({ fps: 30, interval: 24, at: 50 / 30 });
  ctx.jog.snapToGrid();
  ctx.jog.onSeeked();
  assert.equal(+ctx.video.currentTime.toFixed(6), +(48 / 30).toFixed(6), "50 rounds to the nearest multiple, 48");
});

test("frame jog coalesces a burst into one landing seek", () => {
  const ctx = jogSetup({ fps: 30 });
  ctx.jog.request(1); // this one issues the seek and takes the lock
  ctx.jog.request(1); // these pile up…
  ctx.jog.request(1);
  assert.equal(ctx.video.currentTime, 1 / 30);
  ctx.jog.onSeeked(); // …and are applied together when it lands
  assert.equal(+ctx.video.currentTime.toFixed(6), +(3 / 30).toFixed(6), "three notches advance exactly three frames");
});

test("frame jog clamps at both ends of the timeline", () => {
  const end = jogSetup({ fps: 30, at: 99.99, duration: 100 });
  jogStep(end, 10);
  assert.ok(end.video.currentTime <= 100, "never seeks past the duration");
  const start = jogSetup({ fps: 30, at: 0 });
  jogStep(start, -5);
  assert.equal(start.video.currentTime, 0);
});

// ---------------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------------

test("silence mode: sound arms playback, a long enough gap pauses it", () => {
  const { engine, video } = makeEngine();
  engine.threshold = -45;
  engine.gapMs = 600;
  engine.setState("armed");
  video.paused = false;

  let t = feed(engine, -20, 60); // loud, but shorter than SOUND_CONFIRM_MS
  assert.equal(engine.state, "armed", "a 60 ms blip is not the start of a sentence");

  t = feed(engine, -20, 120, t);
  assert.equal(engine.state, "playing");

  t = feed(engine, -60, 400, t); // silence, but shorter than the gap
  assert.equal(engine.state, "playing");

  t = feed(engine, -60, 300, t);
  assert.equal(engine.state, "held", "silence past the gap pauses");
  assert.equal(video.paused, true);
});

test("gap length is respected: a longer 停顿判定时长 keeps playing through short pauses", () => {
  const { engine } = makeEngine();
  engine.gapMs = 1500;
  engine.setState("armed");
  engine.video.paused = false;
  let t = feed(engine, -20, 200);
  assert.equal(engine.state, "playing");
  t = feed(engine, -60, 900, t);
  assert.equal(engine.state, "playing", "900 ms of silence is under the 1.5 s threshold");
  feed(engine, -60, 700, t);
  assert.equal(engine.state, "held");
});

test("adaptive mode pauses on a relative dip, not an absolute level", () => {
  const { engine } = makeEngine();
  engine.mode = "adaptive";
  engine.dropDb = 9;
  engine.gapMs = 300;
  engine.setState("armed");
  engine.video.paused = false;

  // Voice at −20 dB over music at −34: never below the absolute default (−45),
  // so plain silence mode would never pause here.
  let t = feed(engine, -20, 200);
  assert.equal(engine.state, "playing");
  assert.ok(engine.effectiveThreshold() > -34, "threshold follows the voice level");
  t = feed(engine, -34, 400, t);
  assert.equal(engine.state, "held", "dropping to the music floor counts as a pause");
});

test("auto-segmentation off makes it an ordinary player", () => {
  const { engine, video } = makeEngine();
  engine.autoSeg = false;
  engine.setState("playing");
  video.paused = false;
  feed(engine, -70, 3000);
  assert.equal(engine.state, "playing");
  assert.equal(video.paused, false);
});

test("after escaping a loop, playback glides past the rest of that sentence", () => {
  const { engine, video } = makeEngine();
  engine.gapMs = 300;
  engine.setState("playing");
  video.paused = false;
  engine._playThrough = true; // what exitRewindLoop sets

  let t = feed(engine, -70, 1000); // long silence inside the escaped utterance
  assert.equal(engine.state, "playing", "playThrough suppresses this stop");

  t = feed(engine, -20, 200, t); // next utterance starts → re-arm
  assert.equal(engine._playThrough, false);

  feed(engine, -70, 500, t);
  assert.equal(engine.state, "held", "the following pause is honoured again");
});

test("a hidden tab (no rAF for minutes) does not pause instantly on return", () => {
  const { engine } = makeEngine();
  engine.gapMs = 600;
  engine.setState("playing");
  engine.video.paused = false;
  let t = feed(engine, -70, 200); // silence starts accumulating
  // …tab hidden for two minutes, then one tick arrives with a huge delta
  engine.audio.readLevel = () => -70;
  engine._tick(t + 120_000);
  assert.equal(engine.state, "playing", "stale timestamps are discarded, not honoured");
});
