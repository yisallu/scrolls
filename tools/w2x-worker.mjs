// The waifu2x worker: runs on the desktop with the GPU, dials OUT to the server.
//
//   node tools/w2x-worker.mjs
//
// Env:
//   W2X_SERVER   default https://web.sysmeng.com
//   W2X_TOKEN    required — the server prints it to data/w2x-token on first boot
//   W2X_EXE      default D:\waifu2xchrome\vendor\waifu2x-ncnn-vulkan\waifu2x-ncnn-vulkan.exe
//
// Why it polls instead of listening: the reader can be an iPad on mobile data, so the
// upscaler has to be reachable from the public internet. Opening a port at home to do
// that means a port forward (or a tunnel) plus an endpoint that spawns GPU processes
// for anyone who finds it. Dialling out inverts that — nothing at home is reachable,
// the only credential is this token, and it works behind NAT and CGNAT unchanged.
//
// It is deliberately a dumb loop: one job at a time (the GPU is serial anyway), and any
// error just goes back to polling. The server owns the queue, the timeouts and the
// cache, so a worker that dies mid-job costs one page, not a stuck reader.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const SERVER = (process.env.W2X_SERVER || "https://web.sysmeng.com").replace(/\/+$/, "");
const TOKEN = process.env.W2X_TOKEN || "";
const EXE =
  process.env.W2X_EXE || "D:\\waifu2xchrome\\vendor\\waifu2x-ncnn-vulkan\\waifu2x-ncnn-vulkan.exe";
const VENDOR = path.dirname(EXE);
const TMP = path.join(os.tmpdir(), "scrolls-w2x");

if (!TOKEN) {
  console.error("W2X_TOKEN is not set. On the server: cat /opt/scrolls/data/w2x-token");
  process.exit(2);
}
if (!fs.existsSync(EXE)) {
  console.error(`waifu2x not found at ${EXE} (set W2X_EXE)`);
  process.exit(2);
}
fs.mkdirSync(TMP, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, args, { cwd: VENDOR, windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().slice(0, 300) || `exit ${code}`))));
  });
}

async function upscale(buf, job) {
  // Per job, not once at startup: %TEMP% gets swept (by Windows, by cleanup tools),
  // and a worker that created its directory only at boot then failed every single job
  // afterwards with a confusing ENOENT on the file it was about to write.
  await fsp.mkdir(TMP, { recursive: true });
  const base = path.join(TMP, crypto.randomBytes(6).toString("hex"));
  const input = `${base}.in`;
  const output = `${base}.png`;
  await fsp.writeFile(input, buf);
  try {
    await run([
      "-i", input,
      "-o", output,
      "-n", String(job.noise ?? 1),
      "-s", String(job.scale ?? 2),
      "-m", path.join(VENDOR, job.model || "models-cunet"),
      "-t", "400",
    ]);
    return await fsp.readFile(output);
  } finally {
    await fsp.rm(input, { force: true });
    await fsp.rm(output, { force: true });
  }
}

async function poll() {
  const res = await fetch(`${SERVER}/api/w2x/job?token=${encodeURIComponent(TOKEN)}`);
  if (res.status === 204) return null; // long-poll expired; go round again
  if (res.status === 401) throw new Error("token rejected by the server");
  if (!res.ok) throw new Error(`job poll failed: ${res.status}`);
  const head = res.headers.get("x-job");
  if (!head) throw new Error("job header missing");
  const job = JSON.parse(Buffer.from(head, "base64").toString("utf8"));
  job.buf = Buffer.from(await res.arrayBuffer());
  return job;
}

async function report(id, body, error) {
  const q = new URLSearchParams({ token: TOKEN, id });
  if (error) q.set("error", String(error).slice(0, 300));
  await fetch(`${SERVER}/api/w2x/result?${q}`, {
    method: "POST",
    headers: { "content-type": error ? "text/plain" : "image/png" },
    body: error ? "" : body,
  }).catch((e) => log("  ! could not report result:", e.message));
}

log(`worker up — ${SERVER}`);
log(`engine: ${EXE}`);

let quiet = 0;
for (;;) {
  try {
    const job = await poll();
    if (!job) {
      if (quiet++ % 20 === 0) log("waiting for work…");
      continue;
    }
    quiet = 0;
    const t0 = Date.now();
    log(`job ${job.id.slice(0, 8)} ${(job.buf.length / 1024) | 0}KB ${job.model} n${job.noise} s${job.scale}`);
    try {
      const out = await upscale(job.buf, job);
      await report(job.id, out);
      log(`  done in ${Date.now() - t0}ms -> ${(out.length / 1024 / 1024).toFixed(2)}MB`);
    } catch (e) {
      log(`  FAILED: ${e.message}`);
      await report(job.id, null, e.message);
    }
  } catch (e) {
    log(`poll error: ${e.message} — retrying in 5s`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
