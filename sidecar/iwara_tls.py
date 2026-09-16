#!/usr/bin/env python3
"""TLS-impersonation sidecar for ShadowTV.

Some sites (iwara) sit behind Cloudflare bot protection that rejects Node's
fetch (TLS/JA3 fingerprint). curl_cffi impersonates a real Chrome TLS stack and
gets through. This service exposes normalized JSON the Node engine consumes:

  GET /iwara/list?sort=&rating=&query=&page=&limit=
  GET /iwara/resolve?id=<videoId>

Only the iwara *API* needs this; the media files (acheron/files*.iwara.tv) are an
open CDN streamed by the Node media proxy directly.
"""
import os, json, hashlib, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from curl_cffi import requests as creq

API = "https://api.iwara.tv"
IMG = "https://i.iwara.tv/image/original"
SECRET = "5nFp9kmbNnHdAFhaqMvt"  # iwara file-URL signing salt (public, used for X-Version)
HDRS = {"Referer": "https://www.iwara.tv/", "Origin": "https://www.iwara.tv", "Accept": "application/json"}

# Optional outbound proxy. Set IWARA_PROXY when this host's IP is geo-blocked by
# iwara/Cloudflare (e.g. a Korea VPS gets HTTP 451) — point it at a local proxy
# that exits in an allowed region. Use a name-preserving scheme (socks5h:// or
# http://) so a domain-routing proxy can match "iwara.tv"; socks5:// resolves
# locally and defeats domain rules. Empty/unset = direct connection (default).
PROXY = os.environ.get("IWARA_PROXY") or None
_PROXIES = {"http": PROXY, "https": PROXY} if PROXY else None


def get(url, extra=None):
    return creq.get(url, impersonate="chrome", headers={**HDRS, **(extra or {})},
                    proxies=_PROXIES, timeout=8)


class UpstreamUnavailable(Exception):
    status = 503


def get_json(url, extra=None):
    """Fetch JSON without leaking parser errors when Cloudflare serves HTML."""
    try:
        r = get(url, extra)
    except Exception as e:
        message = str(e).lower()
        if "timed out" in message or "timeout" in message:
            raise UpstreamUnavailable("Iwara upstream request timed out")
        raise
    content_type = (r.headers.get("content-type") or "").lower()
    if r.status_code != 200:
        if r.status_code == 451:
            raise UpstreamUnavailable("Iwara is unavailable from the current region (HTTP 451)")
        if r.status_code in (403, 503) and "text/html" in content_type:
            raise UpstreamUnavailable("Iwara is presenting a Cloudflare challenge")
        if r.status_code in (520, 521, 522, 523, 524):
            raise UpstreamUnavailable(f"Iwara origin is unavailable (HTTP {r.status_code})")
        raise UpstreamUnavailable(f"Iwara upstream returned HTTP {r.status_code}")
    if "json" not in content_type:
        raise UpstreamUnavailable("Iwara returned a non-JSON response")
    try:
        return r.json()
    except Exception:
        raise UpstreamUnavailable("Iwara returned invalid JSON")


def map_item(v):
    f = v.get("file") or {}
    fid = f.get("id")
    ti = v.get("thumbnail") or 0
    cover = f"{IMG}/{fid}/thumbnail-{ti:02d}.jpg" if fid else ""
    tags = [t.get("id") for t in (v.get("tags") or []) if isinstance(t, dict) and t.get("id")]
    return {
        "id": v.get("id"),
        "title": v.get("title") or "",
        "cover": cover,
        "fileType": "video/mp4",
        "width": f.get("width") or 0,
        "height": f.get("height") or 0,
        "duration": f.get("duration") or 0,
        "tags": tags,
        "link": f"https://www.iwara.tv/video/{v.get('id')}",
    }


def iwara_list(q):
    params = {
        "rating": q.get("rating", ["all"])[0],
        "sort": q.get("sort", ["date"])[0],
        "page": q.get("page", ["0"])[0],
        "limit": q.get("limit", ["32"])[0],
    }
    if q.get("query", [""])[0]:
        params["query"] = q["query"][0]
    j = get_json(API + "/videos?" + urllib.parse.urlencode(params))
    res = j.get("results") or []
    return {"items": [map_item(v) for v in res], "page": int(params["page"]), "hasNext": len(res) >= int(params["limit"])}


def _rank(s):
    n = (s.get("name") or "").lower()
    if n == "source":
        return 100000
    if n == "preview":
        return -1
    try:
        return int(n)  # 1080 / 720 / 540 / 360
    except ValueError:
        return 0


def iwara_resolve(q):
    vid = q.get("id", [""])[0]
    if not vid:
        return {"error": "missing id"}
    det = get_json(f"{API}/video/{vid}")
    fu = det.get("fileUrl")
    if not fu:
        return {"error": "no fileUrl (login may be required for this video)"}
    pu = urllib.parse.urlparse(fu)
    expires = urllib.parse.parse_qs(pu.query).get("expires", [""])[0]
    fid = pu.path.split("/")[-1]
    xver = hashlib.sha1(f"{fid}_{expires}_{SECRET}".encode()).hexdigest()
    srcs = [s for s in get_json(fu, {"X-Version": xver}) if s.get("src", {}).get("download")]
    if not srcs:
        return {"error": "no playable source"}
    best = sorted(srcs, key=_rank, reverse=True)[0]
    dl = best["src"]["download"]
    if dl.startswith("//"):
        dl = "https:" + dl
    return {"url": dl, "type": best.get("type", "video/mp4"), "quality": best.get("name")}


ROUTES = {"/iwara/list": iwara_list, "/iwara/resolve": iwara_resolve}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/healthz":
            return self._send(200, {"ok": True})
        fn = ROUTES.get(u.path)
        if not fn:
            return self._send(404, {"error": "not found"})
        try:
            self._send(200, fn(urllib.parse.parse_qs(u.query)))
        except Exception as e:
            self._send(getattr(e, "status", 502), {"error": str(e)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8798"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
