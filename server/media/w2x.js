// waifu2x upscaling, dispatched to a GPU that is not on this box.
//
// The server runs on 4 ARM cores with no GPU, where waifu2x is ~90 s/page. The GPU that
// can actually do this lives on the user's desktop, behind NAT, and the reader might be
// an iPad on mobile data. So the direction is inverted: the desktop dials OUT to this
// server and long-polls for work (tools/w2x-worker.mjs). Consequences worth keeping:
//
//   * nothing is exposed at home — no port forward, no tunnel, works behind CGNAT
//   * nothing new is exposed here either — same origin, same TLS, same nginx
//   * the reader is plain https://web.sysmeng.com, so an iPad has no mixed-content,
//     private-network or CORS problem to work around. It just asks for ?v=w2x.
//   * results land in the SAME disk cache as every other variant, so the second time
//     anyone opens that page the desktop does not need to be switched on at all.
//
// The alternative — frp-tunnelling the desktop's waifu2x port to this box — was
// rejected: the existing frps is reachable from the internet with a guessable token,
// and an open endpoint that spawns GPU processes on someone's home PC is not something
// to leave lying around.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import config from "../config.js";
import { httpErr } from "../lib/errors.js";
import { readAll } from "../lib/fetcher.js";
import { logger } from "../lib/log.js";
import { ensureDir } from "../store/json-file.js";

const log = logger("w2x");

const JOB_TIMEOUT_MS = 180_000; // a big page on a busy GPU
const POLL_HOLD_MS = 25_000; // long-poll hold; under every proxy's idle timeout
const WORKER_STALE_MS = 60_000;
const MAX_QUEUE = 24;

/** A token so only the user's own worker can pull jobs. Generated once, kept in data/. */
function loadToken() {
  const file = path.join(ensureDir(config.dataDir), "w2x-token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* first run */
  }
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  log.info(`generated worker token -> ${file}`);
  return t;
}

export class W2xBroker {
  constructor(opts = {}) {
    this.token = opts.token || loadToken();
    this.queue = []; // jobs waiting for a worker, highest priority first
    this.pending = new Map(); // jobId -> job currently with a worker
    this.waiters = []; // long-polling workers with no job yet
    // Priority that arrived before the bytes were queued (the page became visible
    // while its sample was still downloading). Consumed by the next submit of that key.
    this.prefer = new Map();
    this.lastSeen = 0;
    this.done = 0;
    this.failed = 0;
  }

  get online() {
    return Date.now() - this.lastSeen < WORKER_STALE_MS;
  }

  check(token) {
    // Fixed-length compare so a wrong token cannot be narrowed down by timing.
    const a = Buffer.from(String(token || ""));
    const b = Buffer.from(this.token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw httpErr(401, "worker token 不正确", "unauthorized");
    }
  }

  /**
   * Queue one image and resolve with the upscaled bytes.
   * `opts.priority` (0 lookahead, 1 next page, 2 the page on screen) decides who
   * the idle worker is handed first. Same priority stays in arrival order.
   */
  submit(buf, opts) {
    if (!this.online) throw httpErr(503, "waifu2x 工作机未连接", "worker_offline");
    if (this.queue.length >= MAX_QUEUE) throw httpErr(503, "waifu2x 队列已满", "worker_busy");
    const key = opts.key || "";
    const priority = Math.max(Number(opts.priority) || 0, this.prefer.get(key) || 0);
    this.prefer.delete(key);
    return new Promise((resolve, reject) => {
      const job = {
        id: crypto.randomUUID(),
        buf,
        key,
        priority,
        opts: { ...opts, priority },
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(job.id);
          this.queue = this.queue.filter((j) => j !== job);
          this.prefer.delete(key);
          reject(httpErr(504, "waifu2x 超时", "worker_timeout"));
        }, JOB_TIMEOUT_MS),
      };
      job.timer.unref?.();
      this.#enqueue(job);
    });
  }

  /**
   * The reader landed on a page that was only prefetched. Move it ahead of the
   * lookahead, or remember the priority if the GPU job does not exist yet.
   * @returns {boolean} whether this changed anything the worker has not taken.
   */
  boost(key, priority = 2) {
    priority = Math.max(0, Math.min(2, Number(priority) || 0));
    if (!key || priority <= 0) return false;
    const idx = this.queue.findIndex((j) => j.key === key);
    if (idx !== -1) {
      const job = this.queue[idx];
      if (priority <= job.priority) return false;
      this.queue.splice(idx, 1);
      job.priority = priority;
      job.opts = { ...job.opts, priority };
      this.#enqueue(job);
      return true;
    }
    for (const job of this.pending.values()) if (job.key === key) return false;
    const prev = this.prefer.get(key) || 0;
    if (priority <= prev) return false;
    this.prefer.set(key, priority);
    return true;
  }

  /** Insert by priority. Caller must not already have `job` in the queue. */
  #enqueue(job) {
    const idx = this.queue.findIndex((j) => j.priority < job.priority);
    if (idx === -1) this.queue.push(job);
    else this.queue.splice(idx, 0, job);
    this.#dispatch();
  }

  #dispatch() {
    while (this.queue.length && this.waiters.length) {
      const job = this.queue.shift();
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      // `send` reports whether the job actually went out. A worker that died while
      // holding its long-poll is still in this list until its socket close is noticed,
      // and handing it a job it can never receive used to strand that page for the full
      // job timeout. Put it back and try the next waiter instead.
      if (waiter.send(job)) this.pending.set(job.id, job);
      else this.queue.unshift(job);
    }
  }

  /**
   * Long-poll: hand the worker a job, or hold the connection until one shows up.
   * @returns {() => void} call when the connection goes away, so this waiter is dropped.
   */
  takeJob(send) {
    this.lastSeen = Date.now();
    const waiter = { send, timer: null };
    this.waiters.push(waiter);
    this.#dispatch();
    if (this.waiters.includes(waiter)) {
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        send(null); // 204: the worker will poll again
      }, POLL_HOLD_MS);
      waiter.timer.unref?.();
    }
    return () => {
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((w) => w !== waiter);
    };
  }

  complete(jobId, buf, contentType) {
    const job = this.pending.get(jobId);
    if (!job) return false; // timed out, or a duplicate result
    this.pending.delete(jobId);
    clearTimeout(job.timer);
    this.lastSeen = Date.now();
    this.done++;
    job.resolve({ buf, contentType });
    return true;
  }

  fail(jobId, message) {
    const job = this.pending.get(jobId);
    if (!job) return false;
    this.pending.delete(jobId);
    clearTimeout(job.timer);
    this.lastSeen = Date.now();
    this.failed++;
    job.reject(httpErr(502, `waifu2x 失败:${message}`, "worker_error"));
    return true;
  }

  stats() {
    return {
      online: this.online,
      queued: this.queue.length,
      running: this.pending.size,
      idleWorkers: this.waiters.length,
      done: this.done,
      failed: this.failed,
    };
  }
}

/** Routes the worker talks to. Mounted under the media router (big body budget). */
export function registerW2xRoutes(router, broker) {
  // The worker asks for work. Held open until a job arrives or POLL_HOLD_MS passes.
  router.get("/w2x/job", (ctx) => {
    broker.check(ctx.q("token"));
    const { res } = ctx;
    return new Promise((resolve) => {
      let settled = false;
      const send = (job) => {
        if (settled || res.writableEnded) return false; // caller requeues the job
        settled = true;
        if (!job) {
          res.writeHead(204, { "Cache-Control": "no-store" });
          res.end();
          resolve();
          return true;
        }
        const head = JSON.stringify({ id: job.id, ...job.opts });
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Job": Buffer.from(head).toString("base64"),
          "Content-Length": String(job.buf.length),
        });
        res.end(job.buf);
        resolve();
        return true;
      };
      const drop = broker.takeJob(send);
      res.on("close", () => {
        settled = true;
        drop(); // a dead poller must leave the waiter list, not collect jobs
        resolve();
      });
    });
  });

  // The worker returns the upscaled image (or reports a failure).
  router.post("/w2x/result", async (ctx) => {
    broker.check(ctx.q("token"));
    const id = ctx.q("id");
    const err = ctx.q("error");
    if (!id) throw httpErr(400, "缺少 id", "bad_request");
    if (err) return { ok: broker.fail(id, err) };
    const buf = await readAll(ctx.req, config.pageCache.maxImageBytes);
    if (!buf.length) throw httpErr(400, "结果是空的", "bad_request");
    return { ok: broker.complete(id, buf, ctx.q("type", "image/png")) };
  });

  router.get("/w2x/status", (ctx) => {
    broker.check(ctx.q("token"));
    return broker.stats();
  });
}

export default W2xBroker;
