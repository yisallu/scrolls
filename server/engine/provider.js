// Some sites sit behind Cloudflare bot protection that rejects Node's TLS fingerprint
// outright. For those, a rule sets "provider": "<name>" and the listing/resolve calls
// are answered by the Python sidecar (curl_cffi impersonating a real Chrome stack),
// which returns already-normalized JSON. The media files themselves are still streamed
// by our own proxy — only the API needs the disguise.

import config from "../config.js";
import { httpErr, upstreamUnavailable } from "../lib/errors.js";
import { absUrl } from "./dsl.js";
import { proxiedMediaUrl, isProxiedUrl } from "../media/url.js";

async function sidecarGet(path) {
  let resp;
  try {
    resp = await fetch(config.sidecarUrl + path, { signal: AbortSignal.timeout(25_000) });
  } catch (e) {
    throw httpErr(502, "provider sidecar 不可达: " + e.message, "sidecar_down");
  }
  const body = await resp.json().catch(() => ({}));
  // The sidecar says 503 for "the site is blocking us / geo-blocked". Re-map it to 424
  // at our edge: Cloudflare replaces origin 502/503 bodies with its own error page,
  // but passes 424 through, so the user gets our actual explanation.
  if (body && body.error) {
    throw resp.status === 503 ? upstreamUnavailable(body.error) : httpErr(502, "provider: " + body.error);
  }
  if (!resp.ok) {
    throw resp.status === 503 ? upstreamUnavailable("上游暂时不可用") : httpErr(502, "provider returned HTTP " + resp.status);
  }
  return body;
}

function decorate(rule, it) {
  if (it.cover) {
    const abs = absUrl(rule.baseUrl, it.cover);
    it.cover = rule.proxyImages !== false && !isProxiedUrl(abs) ? proxiedMediaUrl(rule.id, abs) : abs;
  }
  it.image = it.image || it.cover; // the real file is fetched on demand via resolveImage
  return it;
}

export async function providerList(rule, { params, page, kw } = {}) {
  const pageNum = page == null ? 0 : page; // provider APIs are 0-indexed
  const qp = new URLSearchParams({ ...(params || {}), page: String(pageNum) });
  if (kw) qp.set("query", kw);
  const data = await sidecarGet(`/${rule.provider}/list?${qp}`);
  const items = (data.items || []).map((it) => decorate(rule, it));
  return { items, page: pageNum, step: 1, hasNext: !!data.hasNext };
}

export async function providerResolve(rule, id) {
  const d = await sidecarGet(`/${rule.provider}/resolve?id=${encodeURIComponent(id)}`);
  if (!d.url) throw httpErr(422, "未找到可播放的文件", "unresolvable");
  const isDirect =
    rule.proxyMedia === false ||
    rule.provider === "tgdm" ||
    isProxiedUrl(d.url) ||
    d.url.startsWith("/") ||
    (process.env.PUBLIC_ORIGIN && d.url.startsWith(process.env.PUBLIC_ORIGIN));
  const url = isDirect ? d.url : proxiedMediaUrl(rule.id, d.url);
  return { url, raw: d.url, quality: d.quality || "", type: d.type || "" };
}

export async function providerHealthy() {
  try {
    const r = await fetch(config.sidecarUrl + "/healthz", { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}
