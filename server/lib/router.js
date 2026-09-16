// A ~130-line router over node:http. The app has about twenty routes and one
// streaming endpoint; a framework would add a hundred transitive dependencies to
// something this small, and the media proxy needs the raw res anyway.
//
// Handlers get a ctx and either return a value (sent as JSON) or write to ctx.res
// themselves (the media proxy does that). Thrown HttpErrors become JSON errors.

import { URL } from "node:url";
import { HttpError } from "./errors.js";
import { logger } from "./log.js";

const log = logger("http");

function compile(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  return {
    parts,
    match(pathParts) {
      const params = {};
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === "*") {
          params.rest = pathParts.slice(i).join("/");
          return params;
        }
        if (i >= pathParts.length) return null;
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(pathParts[i]);
        else if (p !== pathParts[i]) return null;
      }
      return pathParts.length === parts.length ? params : null;
    },
  };
}

export class Router {
  constructor({ prefix = "" } = {}) {
    this.prefix = prefix;
    this.routes = [];
    this.hooks = [];
  }

  /** Runs before every route in this router (rate limits, no-store headers, …). */
  use(fn) {
    this.hooks.push(fn);
    return this;
  }

  add(method, pattern, handler) {
    this.routes.push({ method, route: compile(pattern), handler });
    return this;
  }

  get(p, h) { return this.add("GET", p, h); }
  post(p, h) { return this.add("POST", p, h); }
  put(p, h) { return this.add("PUT", p, h); }
  delete(p, h) { return this.add("DELETE", p, h); }

  /** @returns {boolean} true when this router owned (and answered) the request. */
  async handle(ctx) {
    if (this.prefix && !ctx.pathname.startsWith(this.prefix)) return false;
    const rel = this.prefix ? ctx.pathname.slice(this.prefix.length) : ctx.pathname;
    const pathParts = rel.split("/").filter(Boolean);

    let allowed = null;
    for (const r of this.routes) {
      const params = r.route.match(pathParts);
      if (!params) continue;
      if (r.method !== ctx.method && !(r.method === "GET" && ctx.method === "HEAD")) {
        (allowed ||= new Set()).add(r.method);
        continue;
      }
      ctx.params = params;
      for (const hook of this.hooks) await hook(ctx);
      if (ctx.res.writableEnded) return true;
      const out = await r.handler(ctx);
      if (!ctx.res.writableEnded && out !== undefined) sendJson(ctx.res, 200, out);
      else if (!ctx.res.writableEnded) ctx.res.end();
      return true;
    }
    if (allowed) {
      ctx.res.setHeader("Allow", [...allowed].join(", "));
      throw new HttpError(405, "method not allowed");
    }
    return false;
  }
}

export function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length });
  res.end(res.req && res.req.method === "HEAD" ? undefined : buf);
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const body = { error: err.message || "internal error", code: (err && err.code) || "error" };
  if (status >= 500) log.error(status, err.message);
  if (res.headersSent) {
    try { res.destroy(); } catch {}
    return;
  }
  sendJson(res, status, body);
}

/** Client IP, trusting the reverse proxy in front of us (nginx sets X-Forwarded-For). */
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? String(fwd).split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
}

export async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new HttpError(413, "body too large");
    chunks.push(c);
  }
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Fixed-window per-IP limiter. Buckets self-expire; the sweep keeps memory flat. */
export function rateLimit({ windowMs, max, name = "api" }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }, Math.max(windowMs, 30_000));
  timer.unref();

  return (ctx) => {
    const now = Date.now();
    let b = buckets.get(ctx.ip);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(ctx.ip, b);
    }
    if (++b.count > max) {
      ctx.res.setHeader("Retry-After", Math.ceil((b.reset - now) / 1000));
      throw new HttpError(429, `rate limited (${name})`, "rate_limited");
    }
  };
}

/** Build the per-request context handed to every handler. */
export function makeContext(req, res) {
  const url = new URL(req.url, "http://localhost");
  return {
    req,
    res,
    method: req.method || "GET",
    url,
    pathname: decodeURIComponent(url.pathname),
    query: url.searchParams,
    params: {},
    ip: clientIp(req),
    body: null,
    q(name, fallback = "") {
      const v = url.searchParams.get(name);
      return v == null || v === "" ? fallback : v;
    },
    int(name, fallback) {
      const v = url.searchParams.get(name);
      if (v == null || v === "") return fallback;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : fallback;
    },
  };
}
