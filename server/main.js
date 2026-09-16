// ShadowTV server entry point: wire the stores, the engine, the routers, listen.
//
// Request order matters and is deliberate:
//   1. /api/stream  — its own, much larger rate-limit budget (one HLS stream is
//                     hundreds of requests; sharing the JSON budget would throttle it)
//   2. /api/*       — the JSON API
//   3. static       — the web app, with SPA fallback for client-routed paths

import http from "node:http";
import config from "./config.js";
import { logger } from "./lib/log.js";
import { Router, makeContext, sendError, rateLimit, sendJson } from "./lib/router.js";
import { createStaticHandler } from "./lib/static.js";
import { createApiRouter } from "./api.js";
import { createStreamHandler } from "./media/stream.js";
import { createPageHandler, createPageLoader } from "./media/page.js";
import { W2xBroker, registerW2xRoutes } from "./media/w2x.js";
import { PageCache } from "./media/pagecache.js";
import { Engine } from "./engine/ops.js";
import { RuleStore } from "./store/rules.js";
import { PrefsStore } from "./store/prefs.js";
import { LibraryStore } from "./store/library.js";

const log = logger("scrolls");
const startedAt = Date.now();

const rules = new RuleStore();
const engine = new Engine();
const prefs = new PrefsStore();
const library = new LibraryStore();

// A rule file changed on disk (hot reload) → its cached listings are stale.
rules.onChange(() => engine.invalidate());

const pageCache = new PageCache();
const pageLoader = createPageLoader(engine, pageCache);
const w2x = new W2xBroker();

const streamRouter = new Router({ prefix: "/api" })
  .use(rateLimit({ ...config.rateLimit.media, name: "media" }))
  .get("/stream", createStreamHandler(rules))
  .get("/page", createPageHandler(rules, engine, pageCache, pageLoader, w2x));
registerW2xRoutes(streamRouter, w2x);

const apiRouter = createApiRouter({ rules, engine, prefs, library, pageCache, w2x, startedAt });
const serveStatic = createStaticHandler(config.webDir, { spaFallback: "index.html" });

const server = http.createServer(async (req, res) => {
  // A client that hangs up mid-download makes the socket emit 'error'. Unhandled, that
  // is fatal to the process — and with a media proxy it happens every time someone
  // scrubs a video. Swallow it here; real failures are reported by the handlers.
  res.on("error", () => {});
  req.on("error", () => {});
  const ctx = makeContext(req, res);
  try {
    if (await streamRouter.handle(ctx)) return;
    if (await apiRouter.handle(ctx)) return;
    if (await serveStatic(ctx)) return;
    if (ctx.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "no such endpoint", code: "not_found" });
    sendJson(res, 404, { error: "not found", code: "not_found" });
  } catch (err) {
    sendError(res, err);
  }
});

// Media responses are long-lived streams; the defaults would cut them off.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") log.error(`port ${config.port} is already in use — is another copy running? (set PORT= to change)`);
  else log.error("server error:", e.message);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port}`);
  log.info(`web:  ${config.webDir}`);
  log.info(`data: ${config.dataDir}  (${rules.all().length} rules)`);
  if (config.allowLocalHosts) log.warn("ALLOW_LOCAL_HOSTS=1 — SSRF guard disabled. Development only!");
});

async function shutdown(signal) {
  log.info(`${signal} — flushing state and closing`);
  server.close();
  try {
    await Promise.all([prefs.flush(), library.flush()]);
  } catch (e) {
    log.error("flush failed:", e.message);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandled rejection:", (e && e.stack) || e));
