// The single outbound-network gate. Every byte this server fetches — page scrapes,
// JSON APIs, media segments — leaves through here, so there is exactly one place
// where "can we talk to this host?" is decided.
//
// Two layers of defence:
//   1. assertHostAllowed() — the URL's host must be http(s) and must be listed in the
//      rule's `allowedHosts`. A rule can therefore never be pointed at an arbitrary host.
//   2. safeLookup() — a DNS hook installed on every socket: whatever address the name
//      actually resolves to at CONNECT time must be public. Validating at connect time
//      (rather than pre-checking and hoping) is what closes the DNS-rebinding hole —
//      a name that answers "1.2.3.4" for the check and "127.0.0.1" for the connection
//      never gets a socket.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { URL } from "node:url";
import config from "../config.js";
import { httpErr } from "./errors.js";

export function ipIsPrivate(ip) {
  if (!ip) return true;
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true; // TEST-NET-1
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fe80")) return true; // link-local
    if (l.startsWith("fc") || l.startsWith("fd")) return true; // unique local
    return false;
  }
  return true; // unparseable → treat as unsafe
}

/** Host allowlist match. Entries may be "example.com" or "*.example.com"; both cover subdomains. */
export function hostMatches(host, allowed) {
  host = String(host).toLowerCase();
  return (allowed || []).some((entry) => {
    const h = String(entry).toLowerCase().replace(/^\*\./, "").replace(/^\.+/, "");
    return h && (host === h || host.endsWith("." + h));
  });
}

/** Parse + protocol check. Literal private IPs are rejected here; names are checked at connect time. */
export function assertPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(String(urlStr));
  } catch {
    throw httpErr(400, "bad url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw httpErr(400, "protocol not allowed");
  if (config.allowLocalHosts) return u; // dev only — see config.js
  if (net.isIP(u.hostname) && ipIsPrivate(u.hostname)) throw httpErr(403, "private address blocked");
  return u;
}

export function assertHostAllowed(rule, urlStr) {
  const u = assertPublicUrl(urlStr);
  const allowed = (rule && rule.allowedHosts) || [];
  if (!allowed.length) throw httpErr(403, "rule has no allowedHosts");
  if (!hostMatches(u.hostname, allowed)) throw httpErr(403, "host not in allowlist: " + u.hostname);
  return u;
}

// ---- the DNS hook -----------------------------------------------------------

/**
 * Drop-in replacement for dns.lookup that fails the connection if the name resolves
 * to anything private. Installed on every agent below, so it also covers redirects,
 * HLS segments and any host a rule sends us to.
 */
export function safeLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (config.allowLocalHosts) return callback(null, address, family);
    const addrs = Array.isArray(address) ? address : [{ address, family }];
    for (const a of addrs) {
      if (ipIsPrivate(a.address)) {
        return callback(Object.assign(new Error("host resolves to a private address: " + hostname), { code: "EBLOCKED" }));
      }
    }
    return callback(null, address, family);
  });
}

// ---- agents ------------------------------------------------------------------
// Keep-alive matters a lot here: an HLS stream is hundreds of small requests to the
// same host, and a scrape usually means several pages from one origin.

const agentOpts = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 64, timeout: 30_000, lookup: safeLookup };
export const httpAgent = new http.Agent(agentOpts);
export const httpsAgent = new https.Agent(agentOpts);

/**
 * An https.Agent that reaches the target through an HTTP CONNECT proxy. The proxy is
 * given the literal "host:port" (never a pre-resolved IP) so a domain-routing proxy
 * such as sing-box can match on the hostname and pick the right exit node.
 * Only https targets are tunnelled — every geo-blocked CDN we care about is TLS.
 */
export function makeConnectAgent(proxyUrl) {
  const p = new URL(proxyUrl);
  class ConnectAgent extends https.Agent {
    createConnection(options, cb) {
      const hostport = options.host + ":" + (options.port || 443);
      const con = http.request({
        host: p.hostname,
        port: Number(p.port) || 80,
        method: "CONNECT",
        path: hostport,
        headers: { Host: hostport },
        timeout: 20_000,
      });
      con.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          cb(httpErr(502, "media proxy CONNECT failed: " + res.statusCode));
          return;
        }
        const tlsSock = tls.connect({ socket, servername: options.servername || options.host }, () => cb(null, tlsSock));
        tlsSock.on("error", cb);
      });
      con.on("error", cb);
      con.end();
    }
  }
  // No keep-alive: tunnels are cheap to redo and long-lived ones upset some proxies.
  return new ConnectAgent({ keepAlive: false });
}

const proxyAgent = config.streamProxy ? makeConnectAgent(config.streamProxy) : null;

export function proxyMatches(host) {
  host = String(host).toLowerCase();
  return config.streamProxyHosts.some((h) => host === h || host.endsWith("." + h));
}

/** Pick the agent for a URL: the geo-proxy tunnel when the host is scoped to it, else keep-alive. */
export function agentFor(u) {
  if (u.protocol === "https:") {
    if (proxyAgent && proxyMatches(u.hostname)) return proxyAgent;
    return httpsAgent;
  }
  return httpAgent;
}

export const clientFor = (u) => (u.protocol === "https:" ? https : http);
