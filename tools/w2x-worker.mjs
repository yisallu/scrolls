// The waifu2x worker: runs on the desktop with the GPU, dials OUT to the server.
//
//   node tools/w2x-worker.mjs
//
// Env:
//   W2X_SERVER   default https://web.sysmeng.com
//   W2X_TOKEN    required — the server prints it to data/w2x-token on first boot
//   W2X_EXE      default D:\waifu2xchrome\vendor\waifu2x-ncnn-vulkan\waifu2x-ncnn-vulkan.exe
//   W2X_BATCH    how many queued pages share one process (default 4, max 8)
//   W2X_THREADS  load:proc:save passed to -j (default 2:2:2)
//   W2X_FORMAT   jpg | png | webp (default jpg)
//   W2X_TILE     -t tile size, 0 = auto
//
// Why it polls instead of listening: the reader can be an iPad on mobile data, so the
// upscaler has to be reachable from the public internet. Opening a port at home to do
// that means a port forward (or a tunnel) plus an endpoint that spawns GPU processes
// for anyone who finds it. Dialling out inverts that — nothing at home is reachable,
// the only credential is this token, and it works behind NAT and CGNAT unchanged.
//
// One GPU process at a time, but several pages per process. Loading the Vulkan net
// costs about as much as upscaling one page, so a fresh process per page spends half
// its time on startup. A directory run pays that once and pipelines the rest. A second
// process beside it does not go faster — on this 4070 it loses the device.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readLocalToken() {
  try {
    return fs.readFileSync(path.resolve(__dirname, "..", "data", "w2x-token"), "utf8").trim();
  } catch {
    return "";
  }
}

const SERVER = (process.env.W2X_SERVER || "https://web.sysmeng.com").replace(/\/+$/, "");
const TOKEN = (process.env.W2X_TOKEN || readLocalToken()).trim();
const EXE =
  process.env.W2X_EXE || "D:\\waifu2xchrome\\vendor\\waifu2x-ncnn-vulkan\\waifu2x-ncnn-vulkan.exe";
const VENDOR = path.dirname(EXE);
const TMP = path.join(os.tmpdir(), "scrolls-w2x");

const FORMAT = (process.env.W2X_FORMAT || "jpg").toLowerCase();
const TILE = process.env.W2X_TILE || "0";
// 4:4:4 looks faster on paper and then vkQueueSubmit fails with device-lost once the
// queue is deep. 2:2:2 saturates a 4070 on a directory of manga pages without that.
const THREADS = process.env.W2X_THREADS || "2:2:2";
const BATCH = Math.max(1, Math.min(8, Number(process.env.W2X_BATCH || 4)));
// A healthy batch of manga pages is a few seconds. Past this the GPU is wedged
// (device-lost under a long queue) and the process never exits, which is what
// took the worker offline while the server queue sat at the cap.
const RUN_TIMEOUT_MS = Math.max(10_000, Number(process.env.W2X_TIMEOUT_MS || 40_000));
// Extra polls are for jobs the status call already counted. If the count was stale
// the call would otherwise sit in the server's 25s long-poll and the page on screen
// would wait out the whole hold. 4s is past a slow round trip, short of that hold.
const EXTRA_POLL_MS = 4_000;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function sniffExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "jpg";
}

/** True once a decoder would accept the file, so a half-written output is never cached. */
export function imageComplete(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf.subarray(Math.max(0, buf.length - 24)).includes(Buffer.from("IEND"));
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.length >= 12) return buf.length >= buf.readUInt32LE(4) + 8;
  return false;
}

export function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF") return "image/webp";
  return "image/jpeg";
}

/**
 * One GPU invocation per entry. Jobs that share a model/noise/scale stay together
 * (the process can only be configured once) and the highest priority page is first,
 * which is the order the files are written — directory iteration follows it closely
 * enough that the page on screen is reported before the lookahead finishes.
 */
export function planRuns(jobs) {
  const ranked = [...jobs].sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
  const groups = new Map();
  for (const job of ranked) {
    const k = [job.model || "", job.noise ?? "", job.scale ?? "", job.tileSize || ""].join("|");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(job);
  }
  return [...groups.values()].sort(
    (a, b) => (Number(b[0].priority) || 0) - (Number(a[0].priority) || 0)
  );
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } catch {
    /* already gone */
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, args, { cwd: VENDOR, windowsHide: true });
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child.pid);
      reject(new Error(`waifu2x 超过 ${RUN_TIMEOUT_MS / 1000}s 无响应,已结束卡住的显卡进程`));
    }, RUN_TIMEOUT_MS);
    child.stderr.on("data", (c) => {
      if (err.length < 2000) err += c;
    });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() => (code === 0 ? resolve() : reject(new Error(err.trim().slice(0, 300) || `exit ${code}`))))
    );
  });
}

function outFormat() {
  return FORMAT === "png" || FORMAT === "webp" ? FORMAT : "jpg";
}

async function readOutput(output) {
  try {
    return await fsp.readFile(output);
  } catch (e) {
    // An input with an alpha channel is written as "<asked>.png" — JPEG cannot keep it.
    if (e.code !== "ENOENT") throw e;
    return await fsp.readFile(`${output}.png`);
  }
}

async function upscale(buf, job) {
  await fsp.mkdir(TMP, { recursive: true });
  const ext = outFormat();
  const base = path.join(TMP, crypto.randomBytes(6).toString("hex"));
  const input = `${base}.in`;
  const output = `${base}.${ext}`;
  await fsp.writeFile(input, buf);
  try {
    const args = [
      "-i", input,
      "-o", output,
      "-f", ext,
      "-n", String(job.noise ?? 1),
      "-s", String(job.scale ?? 2),
      "-m", path.join(VENDOR, job.model || "models-cunet"),
      "-t", String(job.tileSize || TILE),
      "-j", THREADS,
    ];
    await run(args);
    return await readOutput(output);
  } finally {
    await fsp.rm(input, { force: true });
    await fsp.rm(output, { force: true });
    await fsp.rm(`${output}.png`, { force: true });
  }
}

async function report(id, body, error, mime) {
  const type = error ? "text/plain" : mime || "image/jpeg";
  const q = new URLSearchParams({ token: TOKEN, id, type });
  if (error) q.set("error", String(error).slice(0, 300));
  await fetch(`${SERVER}/api/w2x/result?${q}`, {
    method: "POST",
    headers: { "content-type": type },
    body: error ? "" : body,
  }).catch((e) => log("  ! could not report result:", e.message));
}

/** Publish output files that have stopped growing and end like a real image. */
async function publishReady(outDir, jobs, { final = false } = {}) {
  const names = await fsp.readdir(outDir).catch(() => []);
  for (const name of names) {
    const job = jobs.find((j) => !j._done && name.includes(j.id));
    if (!job) continue;
    let buf;
    try {
      buf = await fsp.readFile(path.join(outDir, name));
    } catch {
      continue; // still open for write
    }
    if (!imageComplete(buf)) continue;
    if (!final && job._seen !== buf.length) {
      job._seen = buf.length;
      continue;
    }
    job._done = true;
    await report(job.id, buf, null, mimeOf(buf));
  }
}

async function upscaleMany(jobs) {
  const dir = await fsp.mkdtemp(path.join(TMP, "b-"));
  const inDir = path.join(dir, "in");
  const outDir = path.join(dir, "out");
  await fsp.mkdir(inDir);
  await fsp.mkdir(outDir);
  const ext = outFormat();
  // Prefix keeps both creation order and lexical order equal to priority order.
  for (let n = 0; n < jobs.length; n++) {
    const job = jobs[n];
    const name = `${String(n).padStart(2, "0")}-${job.id}.${sniffExt(job.buf)}`;
    await fsp.writeFile(path.join(inDir, name), job.buf);
  }
  const sample = jobs[0];
  let chain = Promise.resolve();
  const publish = (final) => {
    chain = chain.then(() => publishReady(outDir, jobs, { final })).catch((e) => log("  publish:", e.message));
    return chain;
  };
  const timer = setInterval(() => publish(false), 80);
  let failed = null;
  try {
    await run([
      "-i", inDir,
      "-o", outDir,
      "-f", ext,
      "-n", String(sample.noise ?? 1),
      "-s", String(sample.scale ?? 2),
      "-m", path.join(VENDOR, sample.model || "models-cunet"),
      "-t", String(sample.tileSize || TILE),
      "-j", THREADS,
    ]);
  } catch (e) {
    failed = e;
  } finally {
    clearInterval(timer);
    await publish(true);
    await fsp.rm(dir, { recursive: true, force: true });
  }
  const pending = jobs.filter((j) => !j._done);
  if (!pending.length) return;
  // The directory run died (or skipped a file). One-by-one still uses the warm GPU
  // and saves the pages that did not land; a device-lost just fails them individually.
  if (failed) log(`  batch exit (${failed.message.slice(0, 120)}); ${pending.length} left, retrying singly`);
  for (const job of pending) {
    try {
      const out = await upscale(job.buf, job);
      job._done = true;
      await report(job.id, out, null, mimeOf(out));
    } catch (e) {
      job._done = true;
      await report(job.id, null, e.message);
    }
  }
}

async function readJob(res) {
  if (res.status === 204) return null;
  if (res.status === 401) throw new Error("token rejected by the server");
  if (!res.ok) throw new Error(`job poll failed: ${res.status}`);
  const head = res.headers.get("x-job");
  if (!head) throw new Error("job header missing");
  const job = JSON.parse(Buffer.from(head, "base64").toString("utf8"));
  job.priority = Number(job.priority) || 0;
  job.buf = Buffer.from(await res.arrayBuffer());
  return job;
}

async function pollJob({ headersTimeoutMs = 0 } = {}) {
  const ac = new AbortController();
  const timer = headersTimeoutMs > 0 ? setTimeout(() => ac.abort(), headersTimeoutMs) : null;
  try {
    const res = await fetch(`${SERVER}/api/w2x/job?token=${encodeURIComponent(TOKEN)}`, {
      signal: timer ? ac.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    return await readJob(res);
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e.name === "AbortError") return null;
    throw e;
  }
}

async function queuedCount() {
  const res = await fetch(`${SERVER}/api/w2x/status?token=${encodeURIComponent(TOKEN)}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return 0;
  const body = await res.json();
  return Math.max(0, Number(body.queued) || 0);
}

/** The long-polled job, plus anything already sitting in the server queue. */
async function gather() {
  const first = await pollJob();
  if (!first) return [];
  const jobs = [first];
  if (BATCH <= 1) return jobs;
  let extra = 0;
  try {
    extra = Math.min(BATCH - 1, await queuedCount());
  } catch (e) {
    log("status:", e.message);
  }
  if (extra <= 0) return jobs;
  const rest = await Promise.all(
    Array.from({ length: extra }, () =>
      pollJob({ headersTimeoutMs: EXTRA_POLL_MS }).catch((e) => {
        log("extra poll:", e.message);
        return null;
      })
    )
  );
  for (const job of rest) if (job) jobs.push(job);
  return jobs;
}

async function processRun(jobs) {
  const t0 = Date.now();
  const head = jobs[0];
  log(
    `run ${jobs.length} ${jobs.map((j) => j.id.slice(0, 8)).join(",")} ${head.model} n${head.noise} s${head.scale} p${head.priority || 0}`
  );
  if (jobs.length === 1) {
    const out = await upscale(head.buf, head);
    head._done = true;
    await report(head.id, out, null, mimeOf(out));
  } else {
    await upscaleMany(jobs);
  }
  const kb = jobs.length;
  log(`  done ${kb} in ${Date.now() - t0}ms`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
}

async function main() {
  if (!TOKEN) {
    console.error("W2X_TOKEN is not set. On the server: cat /opt/scrolls/data/w2x-token");
    process.exit(2);
  }
  if (!fs.existsSync(EXE)) {
    console.error(`waifu2x not found at ${EXE} (set W2X_EXE)`);
    process.exit(2);
  }
  fs.mkdirSync(TMP, { recursive: true });
  log(`worker up — ${SERVER} (batch: ${BATCH}, threads: ${THREADS}, format: ${FORMAT})`);
  log(`engine: ${EXE}`);
  let quiet = 0;
  for (;;) {
    try {
      const jobs = await gather();
      if (!jobs.length) {
        if (quiet++ % 20 === 0) log("waiting for work…");
        continue;
      }
      quiet = 0;
      for (const run of planRuns(jobs)) {
        try {
          await processRun(run);
        } catch (e) {
          log(`  FAILED: ${e.message}`);
          for (const job of run) if (!job._done) await report(job.id, null, e.message);
        }
      }
    } catch (e) {
      log(`loop error: ${e.message} — retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (isDirectRun()) main();
