// The queue order is what keeps the page on screen from waiting behind lookahead,
// and the worker's run plan is what keeps one model load from being paid per page.

import test from "node:test";
import assert from "node:assert/strict";

import { W2xBroker } from "../server/media/w2x.js";
import { imageComplete, planRuns } from "../tools/w2x-worker.mjs";

function broker() {
  const b = new W2xBroker({ token: "test-token" });
  b.lastSeen = Date.now();
  return b;
}

function take(b) {
  let job = null;
  b.takeJob((j) => {
    job = j;
    return true;
  });
  return job;
}

function finish(b, job, value = "ok") {
  b.complete(job.id, Buffer.from(value), "image/jpeg");
}

test("a later high-priority page is handed to the worker before earlier lookahead", async () => {
  const b = broker();
  const low = b.submit(Buffer.from("a"), { key: "low", priority: 0, model: "m", noise: -1, scale: 2 });
  const hot = b.submit(Buffer.from("b"), { key: "hot", priority: 2, model: "m", noise: -1, scale: 2 });
  const first = take(b);
  assert.equal(first.key, "hot");
  assert.equal(first.opts.priority, 2);
  finish(b, first);
  await hot;
  const second = take(b);
  assert.equal(second.key, "low");
  finish(b, second);
  await low;
});

test("boost pulls a queued prefetch ahead, and a boost that arrives early sticks", async () => {
  const b = broker();
  const ahead = b.submit(Buffer.from("a"), { key: "ahead", priority: 0, model: "m", noise: -1, scale: 2 });
  const soon = b.submit(Buffer.from("c"), { key: "soon", priority: 0, model: "m", noise: -1, scale: 2 });
  assert.equal(b.boost("soon", 2), true);
  const first = take(b);
  assert.equal(first.key, "soon");
  assert.equal(first.priority, 2);
  finish(b, first);
  await soon;

  assert.equal(b.boost("later", 2), true);
  const later = b.submit(Buffer.from("d"), { key: "later", priority: 0, model: "m", noise: -1, scale: 2 });
  const job = take(b);
  assert.equal(job.key, "later");
  assert.equal(job.priority, 2);
  finish(b, job);
  await later;

  const rest = take(b);
  assert.equal(rest.key, "ahead");
  finish(b, rest);
  await ahead;
});

test("planRuns keeps one settings group together and leads with the visible page", () => {
  const runs = planRuns([
    { id: "look", priority: 0, model: "cunet", noise: -1, scale: 2 },
    { id: "hot", priority: 2, model: "cunet", noise: -1, scale: 2 },
    { id: "other", priority: 0, model: "photo", noise: -1, scale: 2 },
  ]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].map((j) => j.id), ["hot", "look"]);
  assert.deepEqual(runs[1].map((j) => j.id), ["other"]);
});

test("imageComplete rejects a jpeg that has not been finished", () => {
  assert.equal(imageComplete(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])), true);
  assert.equal(imageComplete(Buffer.from([0xff, 0xd8, 0x00, 0x11])), false);
  assert.equal(imageComplete(Buffer.alloc(0)), false);
});
