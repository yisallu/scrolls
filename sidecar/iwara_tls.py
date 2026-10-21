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
import os, json, time, re, asyncio, base64, hashlib, threading, html as htmllib, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from curl_cffi import requests as creq

API = "https://api.iwara.tv"
IMG = "https://i.iwara.tv/image/original"
SECRET = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN"  # iwara file-URL signing salt (public, used for X-Version); rotated 2026-08 — old one 5nFp9k… silently degrades to 360p
HDRS = {"Referer": "https://www.iwara.tv/", "Origin": "https://www.iwara.tv", "Accept": "application/json"}

# Optional outbound proxy. Set IWARA_PROXY when this host's IP is geo-blocked by
# iwara/Cloudflare (e.g. a Korea VPS gets HTTP 451) — point it at a local proxy
# that exits in an allowed region. Use a name-preserving scheme (socks5h:// or
# http://) so a domain-routing proxy can match "iwara.tv"; socks5:// resolves
# locally and defeats domain rules. Empty/unset = direct connection (default).
PROXY = os.environ.get("IWARA_PROXY") or None
_PROXIES = {"http": PROXY, "https": PROXY} if PROXY else None

# --- Optional login (unlocks >360p). Iwara gates all higher qualities behind
# auth. Credentials come from env only and are never logged.
#   IWARA_EMAIL + IWARA_PASSWORD  -> auto login + auto refresh (preferred)
#   IWARA_TOKEN                  -> seed JWT from browser localStorage (valid ~3 weeks)
# Flow (per yt-dlp): POST /user/login -> user token (~3w TTL);
# POST /user/token (Bearer user) -> media accessToken (~1h TTL);
# attach "Authorization: Bearer <media>" to video/fileUrl GETs.
_EMAIL = os.environ.get("IWARA_EMAIL") or None
_PASSWORD = os.environ.get("IWARA_PASSWORD") or None
_user_token = os.environ.get("IWARA_TOKEN") or None
_media_token = None
_auth_lock = __import__("threading").Lock()


def _jwt_exp(tok):
    try:
        p = tok.split(".")[1]
        p += "=" * (-len(p) % 4)
        return int(json.loads(base64.urlsafe_b64decode(p)).get("exp") or 0)
    except Exception:
        return 0


def _login():
    """Refresh user token via password login. Never logs the password."""
    global _user_token
    if not (_EMAIL and _PASSWORD):
        return
    r = creq.post(API + "/user/login", json={"email": _EMAIL, "password": _PASSWORD},
                  impersonate="chrome", headers=HDRS, proxies=_PROXIES, timeout=8)
    tok = (r.json() or {}).get("token") if r.status_code == 200 else None
    if tok:
        _user_token = tok
    else:
        print("iwara: login failed (HTTP %s)" % r.status_code, flush=True)


def _auth_headers():
    """Authorization header with a fresh media token, or {} when anonymous."""
    global _media_token
    if not (_EMAIL and _PASSWORD) and not _user_token:
        return {}
    with _auth_lock:
        now = time.time()
        if not _user_token or _jwt_exp(_user_token) <= now - 120:
            _login()
            if not _user_token:
                return {}
        if not _media_token or _jwt_exp(_media_token) <= now - 120:
            r = creq.post(API + "/user/token", data=b"", impersonate="chrome",
                          headers={**HDRS, "Authorization": f"Bearer {_user_token}"},
                          proxies=_PROXIES, timeout=8)
            tok = (r.json() or {}).get("accessToken") if r.status_code == 200 else None
            _media_token = tok
            if not tok:
                print("iwara: media token fetch failed (HTTP %s)" % r.status_code, flush=True)
                return {}
        return {"Authorization": f"Bearer {_media_token}"}


def _reset_auth():
    global _media_token
    with _auth_lock:
        _media_token = None


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
    det = get_json(f"{API}/video/{vid}", _auth_headers())
    fu = det.get("fileUrl")
    if not fu:
        return {"error": "no fileUrl (login may be required for this video)"}
    pu = urllib.parse.urlparse(fu)
    expires = urllib.parse.parse_qs(pu.query).get("expires", [""])[0]
    fid = pu.path.split("/")[-1]
    xver = hashlib.sha1(f"{fid}_{expires}_{SECRET}".encode()).hexdigest()
    try:
        src_list = get_json(fu, {"X-Version": xver, **_auth_headers()})
    except UpstreamUnavailable as e:
        # media token may have been revoked mid-flight; retry once with a fresh one
        _reset_auth()
        src_list = get_json(fu, {"X-Version": xver, **_auth_headers()})
    srcs = [s for s in src_list if s.get("src", {}).get("download") or s.get("src", {}).get("view")]
    if not srcs:
        return {"error": "no playable source"}
    best = sorted(srcs, key=_rank, reverse=True)[0]
    dl = best["src"].get("download") or best["src"].get("view")
    if dl.startswith("//"):
        dl = "https:" + dl
    return {"url": dl, "type": best.get("type", "video/mp4"), "quality": best.get("name")}


# ---------------------------------------------------------------- telegram ---
# t.me public channel previews are plain HTML (no login, no MTProto). The watch
# page must be fetched as ?embed=1&mode=tme to contain the <video> tag, and media
# tokens on cdn*.telesco.pe live only a few minutes — so resolve() mints a fresh
# URL on every call (the Node engine caches resolve results for just 2 min).

def _tg_get(url):
    r = creq.get(url, impersonate="chrome", timeout=10)  # t.me is reachable directly
    if r.status_code != 200:
        raise UpstreamUnavailable(f"Telegram 返回 HTTP {r.status_code}")
    return r.text


def _tg_parse(html, keep):
    """Parse a /s/ preview page into media-post items. `keep` receives new items."""
    for b in re.split(r'(?=<div class="tgme_widget_message_wrap)', html)[1:]:
        d = re.search(r'<a class="tgme_widget_message_date" href="https://t\.me/([^/"]+)/(\d+)"', b)
        if not d:
            continue
        ch, pid = d.group(1), d.group(2)
        vid = re.search(r'<video[^>]*\ssrc="([^"]+)"', b)
        cov = re.search(r"background-image:url\('([^']+)'\)", b)
        if not vid and not cov:
            continue  # text-only post
        txt = re.search(r'(?s)<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', b)
        title = htmllib.unescape(re.sub(r"<[^>]+>", " ", txt.group(1))).strip() if txt else ""
        title = re.sub(r"\s+", " ", title)[:80]
        keep[pid] = {
            "id": f"{ch}/{pid}",
            "title": title or f"{ch} #{pid}",
            "cover": (cov.group(1).replace("&amp;", "&") if cov else ""),
            "fileType": "video/mp4" if vid else "image/jpeg",
            "link": f"https://t.me/{ch}/{pid}",
        }


def telegram_list(q):
    ch = (q.get("query", [None])[0] or q.get("channel", [""])[0] or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9_]{3,64}", ch):
        return {"error": "请输入频道名（公开频道的用户名，不含 @）"}
    try:
        page = int(q.get("page", ["0"])[0])
    except ValueError:
        page = 0
    items, url = {}, f"https://t.me/s/{ch}"
    for _ in range(page + 1):
        html = _tg_get(url)
        _tg_parse(html, items)
        nxt = re.findall(r'href="(https://t\.me/s/[^"?]+\?before=\d+)"', html)
        if not nxt:
            break
        url = nxt[-1]  # "load more" link = oldest post of this batch
    if not items:
        return {"error": "频道不存在、私密，或没有带媒体的帖子"}
    # oldest → newest reads more naturally in the grid
    ordered = [items[k] for k in sorted(items, key=int, reverse=True)]
    return {"items": ordered[:60], "hasNext": bool(nxt)}


def telegram_resolve(q):
    vid = q.get("id", [""])[0]
    if not re.fullmatch(r"[A-Za-z0-9_]{3,64}/\d+", vid):
        return {"error": "bad id"}
    ch, pid = vid.split("/", 1)
    html = _tg_get(f"https://t.me/{ch}/{pid}?embed=1&mode=tme")
    m = re.search(r'<video[^>]*\ssrc="([^"]+\.mp4[^"]*)"', html)
    if not m:
        return {"error": "这条帖子没有可播放的视频（可能是图片或纯文本）"}
    u = htmllib.unescape(m.group(1))
    if u.startswith("//"):
        u = "https:" + u
    return {"url": u, "type": "video/mp4", "quality": "source"}


# ---------------------------------------------------------------- tgdm ----
# "Telegram 私聊媒体": browse & serve media from the account's own chat with a
# bot (e.g. a Grok generator). No public URLs exist for DM media, so the sidecar
# itself streams bytes over MTProto and serves them under /tgdm/* (exposed
# publicly through nginx on the ShadowTV origin; a shared key gates access).
# The Node media proxy must NOT point here (private-address SSRF guard), so the
# resolve() URLs it returns are own-origin https links that provider.js passes
# through unwrapped.

TGDM_KEY = os.environ.get("TGDM_KEY") or ""
TGDM_CHAT = int(os.environ.get("TGDM_CHAT") or "0")
TGDM_ORIGIN = (os.environ.get("TGDM_ORIGIN") or "").rstrip("/")
TGDM_PER_PAGE = 40


def _tgdm_chat_of(key):
    """Chat selector embedded in ids/paths: h=hermes bot, s=saved messages.
    'm' is the legacy pre-split prefix — treated as the hermes chat."""
    if key in ("h", "m"):
        return TGDM_CHAT
    if key == "s":
        return "me"
    raise UpstreamUnavailable("unknown chat")


_tgdm = None
_tgdm_lock = threading.Lock()
_tgdm_lists = {}  # chatKey -> {"ts": ..., "items": [...]}


def _tg_engine():
    """One shared TelegramClient on a dedicated asyncio thread."""
    global _tgdm
    with _tgdm_lock:
        if _tgdm:
            return _tgdm
        import asyncio
        from telethon import TelegramClient
        loop = asyncio.new_event_loop()
        threading.Thread(target=loop.run_forever, daemon=True, name="tgdm-loop").start()
        here = os.path.dirname(os.path.abspath(__file__))
        client = TelegramClient(os.path.join(here, "tg_dm.session"),
                                int(os.environ["TG_API_ID"]),
                                os.environ["TG_API_HASH"], loop=loop)
        asyncio.run_coroutine_threadsafe(client.connect(), loop).result(timeout=20)
        authed = asyncio.run_coroutine_threadsafe(client.is_user_authorized(), loop).result(timeout=10)
        if not authed:
            raise UpstreamUnavailable("Telegram session 失效，需要重新登录")
        _tgdm = {"client": client, "loop": loop}
        return _tgdm


def _tg(coro, timeout=60):
    t = _tg_engine()
    return asyncio.run_coroutine_threadsafe(coro, t["loop"]).result(timeout=timeout)


def _msg_attr(doc, cls):
    for a in (getattr(doc, "attributes", None) or []):
        if type(a).__name__ == cls:
            return a
    return None


def _tgdm_url(kind, cid, name):
    return f"{TGDM_ORIGIN}/tgdm/{kind}/{cid}{name}?k={TGDM_KEY}"


def _tgdm_items(chat, kw=""):
    """Media items of one chat (cached 60s per chat; kw search bypasses)."""
    key = "s" if chat == "me" else "h"
    now = time.time()
    cached = _tgdm_lists.get(key)
    if cached and now - cached["ts"] <= 60 and not kw:
        items = cached["items"]
    else:
        from telethon.tl.types import MessageMediaDocument, MessageMediaPhoto
        client = _tg_engine()["client"]
        items = []
        for m in _tg_call_iter(client.iter_messages(chat, limit=2000)):
            mid, cap = m.id, (m.message or "").strip()
            if m.media and isinstance(m.media, MessageMediaPhoto):
                items.append({
                    "id": f"{key}{mid}", "title": re.sub(r"\s+", " ", cap)[:80] or f"图片 #{mid}",
                    "cover": _tgdm_url("thumb", f"{key}{mid}", ".jpg"),
                    "image": _tgdm_url("file", f"{key}{mid}", ".jpg"),
                    "fileType": "image/jpeg",
                })
            elif m.media and isinstance(m.media, MessageMediaDocument):
                doc = m.media.document
                mime = getattr(doc, "mime_type", "") or ""
                if not mime.startswith("video/"):
                    continue
                v = _msg_attr(doc, "DocumentAttributeVideo")
                items.append({
                    "id": f"{key}{mid}", "title": re.sub(r"\s+", " ", cap)[:80] or f"视频 #{mid}",
                    "cover": _tgdm_url("thumb", f"{key}{mid}", ".jpg"),
                    "fileType": "video/mp4", "link": "",
                    "width": getattr(v, "w", 0) or 0, "height": getattr(v, "h", 0) or 0,
                    "duration": int(getattr(v, "duration", 0) or 0),
                })
        if not kw:
            _tgdm_lists[key] = {"ts": now, "items": items}
    if kw:
        k = kw.lower()
        items = [i for i in items if k in i["title"].lower()]
    return items


def _tg_call_iter(aiter):
    """Pull an async iterator to a list from a sync context."""
    import asyncio
    t = _tg_engine()
    async def collect():
        out = []
        async for x in aiter:
            out.append(x)
        return out
    return asyncio.run_coroutine_threadsafe(collect(), t["loop"]).result(timeout=120)


def tgdm_list(q):
    if not TGDM_CHAT:
        return {"error": "TGDM_CHAT 未配置"}
    try:
        page = int(q.get("page", ["0"])[0])
    except ValueError:
        page = 0
    chat = _tgdm_chat_of((q.get("chat", ["h"])[0] or "h").lower())
    kind = (q.get("kind", [""])[0] or "").lower()  # "" | video | photo
    kw = (q.get("query", [None])[0] or "").strip()
    items = _tgdm_items(chat, kw)
    if kind == "video":
        items = [i for i in items if str(i["fileType"]).startswith("video")]
    elif kind == "photo":
        items = [i for i in items if str(i["fileType"]).startswith("image")]
    chunk = items[page * TGDM_PER_PAGE:(page + 1) * TGDM_PER_PAGE]
    return {"items": chunk, "page": page, "hasNext": len(items) > (page + 1) * TGDM_PER_PAGE}


def _tgdm_parse_id(raw):
    """'h22605'/'s123'/'m22605'(legacy) -> (chat, mid)."""
    raw = (raw or "").strip()
    if raw.isdigit():  # legacy bare id = hermes chat
        raw = "h" + raw
    m = re.fullmatch(r"([a-z])(\d+)", raw.lower())
    if not m:
        return None, 0
    return _tgdm_chat_of(m.group(1)), int(m.group(2))


def tgdm_resolve(q):
    chat, mid = _tgdm_parse_id(q.get("id", [""])[0])
    if not mid:
        return {"error": "bad id"}
    client = _tg_engine()["client"]
    m = _tg(client.get_messages(chat, ids=mid))
    if not m or not m.media:
        return {"error": "消息不存在"}
    from telethon.tl.types import MessageMediaPhoto
    if isinstance(m.media, MessageMediaPhoto):
        return {"url": _tgdm_url("file", f"s{mid}" if chat == "me" else f"h{mid}", ".jpg"), "type": "image/jpeg", "quality": "source"}
    doc = getattr(m.media, "document", None)
    mime = getattr(doc, "mime_type", "") or ""
    if not mime.startswith("video/"):
        return {"error": "这条消息不是视频"}
    v = _msg_attr(doc, "DocumentAttributeVideo")
    q_label = f"{getattr(v, 'h', 0)}p" if getattr(v, "h", 0) else "source"
    return {"url": _tgdm_url("file", f"s{mid}" if chat == "me" else f"h{mid}", ".mp4"), "type": "video/mp4", "quality": q_label}


CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tgcache")
os.makedirs(CACHE_DIR, exist_ok=True)
_DISK_MAX = 4 * 1024 * 1024 * 1024  # 4 GiB of cached Telegram media
_file_locks = {}
_prep = {}  # "file_s1234" -> human-readable prepare status
_prep_sem = threading.Semaphore(3)  # cap concurrent downloads/transcodes


def _purge_orphans():
    """Drop *.part / *.out leftovers from a previous (restarted) run."""
    try:
        for name in os.listdir(CACHE_DIR):
            if name.endswith((".part", ".out")):
                try:
                    os.unlink(os.path.join(CACHE_DIR, name))
                except OSError:
                    pass
    except OSError:
        pass


_purge_orphans()


def _prep_set(ck, s):
    with _tgdm_lock:
        _prep[ck] = s


def _prep_get(ck):
    with _tgdm_lock:
        return _prep.get(ck)


def _prep_del(ck):
    with _tgdm_lock:
        _prep.pop(ck, None)


def _cid_lock(cid):
    with _tgdm_lock:
        return _file_locks.setdefault(cid, threading.Lock())


def _disk_gc():
    try:
        files = []
        total = 0
        for name in os.listdir(CACHE_DIR):
            p = os.path.join(CACHE_DIR, name)
            if not os.path.isfile(p):
                continue
            st = os.stat(p)
            files.append((st.st_mtime, st.st_size, p))
            total += st.st_size
        if total <= _DISK_MAX:
            return
        files.sort()  # oldest first
        for _, sz, p in files:
            if total <= _DISK_MAX:
                break
            try:
                os.unlink(p)
                total -= sz
            except OSError:
                pass
    except OSError:
        pass


def _probe_video_codec(path):
    """'h264' / 'hevc' / … (empty when ffprobe can't read it)."""
    import subprocess
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", path],
            capture_output=True, timeout=30,
        )
        return r.stdout.decode().strip()
    except Exception:
        return ""


def _transcode_h264(src, dst):
    """Re-encode to H.264/AAC mp4 (faststart) — browsers can't decode HEVC.
    Writes to dst+'.out' and atomically renames, so a partial encode is never
    mistaken for a ready file."""
    import subprocess
    out = dst + ".out"
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", src,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
             "-movflags", "+faststart", "-f", "mp4", out],
            capture_output=True, timeout=3600,
        )
        if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0:
            os.replace(out, dst)
            return True
        try:
            os.unlink(out)
        except OSError:
            pass
        return False
    except Exception:
        try:
            os.unlink(out)
        except OSError:
            pass
        return False


def _faststart(src, dst):
    """Rewrite an MP4 so the moov atom is at the front (browser-playable).
    Writes to dst+'.out' and renames atomically."""
    import subprocess
    out = dst + ".out"
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-c", "copy", "-movflags", "+faststart",
             "-f", "mp4", out],
            capture_output=True, timeout=180,
        )
        if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0:
            os.replace(out, dst)
            return True
        try:
            os.unlink(out)
        except OSError:
            pass
        return False
    except Exception:
        try:
            os.unlink(out)
        except OSError:
            pass
        return False


def tgdm_media_file(kind, cid):
    """Ensure the media is on disk (faststarted for video) and return (path, ctype, size)."""
    chat, mid = _tgdm_parse_id(cid)
    if not mid:
        raise UpstreamUnavailable("bad id")
    is_thumb = kind == "thumb"
    path = os.path.join(CACHE_DIR, f"{'thumb' if is_thumb else 'file'}_{cid}")
    lock = _cid_lock(cid + kind)
    with lock:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            ctype = "image/jpeg" if is_thumb or path.endswith(".jpg") else "video/mp4"
            # photos land as file_<cid> too; sniff jpeg magic
            with open(path, "rb") as f:
                magic = f.read(3)
            if magic == b"\xff\xd8\xff":
                ctype = "image/jpeg"
            elif not is_thumb:
                ctype = "video/mp4"
            return path, ctype, os.path.getsize(path)
    # not cached: prepare (bounded so mass clicks don't thrash bandwidth/CPU)
    with _prep_sem, lock:
        client = _tg_engine()["client"]
        m = _tg(client.get_messages(chat, ids=mid), timeout=30)
        if not m or not m.media:
            raise UpstreamUnavailable("消息不存在")
        doc0 = getattr(m.media, "document", None)
        print(f"tgdm prep {kind}:{cid} mid={mid} chat={chat} doc.size={getattr(doc0, 'size', None)} mime={getattr(doc0, 'mime_type', None)}", flush=True)
        tmp = path + ".part"
        try:
            if is_thumb:
                data = _tg(client.download_media(m, thumb=-1, file=bytes), timeout=60) or b""
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, path)
                _disk_gc()
                return path, "image/jpeg", os.path.getsize(path)
            # full media: download to tmp, then faststart videos
            ck = f"file_{cid}"
            expect = getattr(getattr(m.media, "document", None), "size", 0) or 0
            def _prog(recv, total):
                _prep_set(ck, f"下载 {recv * 100 // max(total, 1)}%")
            _tg(client.download_media(m, file=tmp, progress_callback=_prog), timeout=1800)
            if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
                raise UpstreamUnavailable("下载失败")
            got = os.path.getsize(tmp)
            print(f"tgdm dl {cid}: got={got} expect={expect}", flush=True)
            if expect and got != expect:
                # truncated transfer (restart, killed thread…) — never cache garbage
                raise UpstreamUnavailable(f"下载不完整 {got}/{expect}")
            with open(tmp, "rb") as f:
                magic = f.read(12)
            is_jpeg = magic[:3] == b"\xff\xd8\xff"
            is_mp4 = b"ftyp" in magic or magic[4:8] == b"ftyp"
            if not is_jpeg and is_mp4:
                codec = _probe_video_codec(tmp)
                print(f"tgdm codec {cid}: {codec!r} is_jpeg={is_jpeg} is_mp4={is_mp4}", flush=True)
                if codec and codec != "h264":
                    # HEVC etc. — browsers decode H.264 only; re-encode once.
                    _prep_set(ck, "转码 H.264 中")
                    if _transcode_h264(tmp, path):
                        try:
                            os.unlink(tmp)
                        except OSError:
                            pass
                        _disk_gc()
                        return path, "video/mp4", os.path.getsize(path)
                    raise UpstreamUnavailable("转码失败")
                _prep_set(ck, "处理中")
                if _faststart(tmp, path):
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
                    _disk_gc()
                    return path, "video/mp4", os.path.getsize(path)
                raise UpstreamUnavailable("视频处理失败")
            os.replace(tmp, path)
            _disk_gc()
            ctype = "image/jpeg" if is_jpeg else "video/mp4"
            return path, ctype, os.path.getsize(path)
        finally:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass


ROUTES = {"/iwara/list": iwara_list, "/iwara/resolve": iwara_resolve,
          "/telegram/list": telegram_list, "/telegram/resolve": telegram_resolve,
          "/tgdm/list": tgdm_list, "/tgdm/resolve": tgdm_resolve}


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

    def _send_file(self, path, ctype, head_only=False):
        total = os.path.getsize(path)
        rng_header = (self.headers.get("Range") or "").strip()
        a, b, code = 0, total - 1, 200
        if rng_header:
            rm = re.match(r"bytes=(\d*)-(\d*)$", rng_header)
            if rm:
                a = int(rm.group(1) or 0)
                b = int(rm.group(2) or total - 1)
                b = min(b, total - 1)
                if a >= total or a > b:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    return
                code = 206
        length = b - a + 1
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        if code == 206:
            self.send_header("Content-Range", f"bytes {a}-{b}/{total}")
        self.end_headers()
        if head_only:
            return
        try:
            with open(path, "rb") as f:
                f.seek(a)
                left = length
                while left > 0:
                    chunk = f.read(min(1024 * 256, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except BrokenPipeError:
            pass

    def _tgdm_serve(self, u, head_only=False):
        """Serve /tgdm/{thumb,file}/{id}.{ext}?k=… with Range + HEAD support."""
        if not TGDM_KEY or not TGDM_CHAT:
            return self._send(503, {"error": "tgdm disabled"})
        qs = urllib.parse.parse_qs(u.query)
        if (qs.get("k", [""])[0] or "") != TGDM_KEY:
            return self._send(403, {"error": "forbidden"})
        m = re.fullmatch(r"/tgdm/(thumb|file)/([a-z]\d+)\.[a-z0-9]+", u.path)
        if not m:
            return self._send(404, {"error": "not found"})
        kind, cid = m.group(1), m.group(2)
        # fast path: already cached
        cpath = os.path.join(CACHE_DIR, f"{'thumb' if kind == 'thumb' else 'file'}_{cid}")
        if os.path.exists(cpath) and os.path.getsize(cpath) > 0:
            try:
                return self._tgdm_serve_cached(cpath, kind, head_only=head_only)
            except Exception as e:
                return self._send(getattr(e, "status", 502), {"error": str(e)})
        # not cached yet: kick off (or join) the background prepare and tell
        # the caller to retry — the SPA polls HEAD and reads X-Prep for status.
        ck = f"{kind}_{cid}"
        if not _cid_lock(ck).locked():
            def work():
                try:
                    tgdm_media_file(kind, cid)
                except Exception:
                    pass
                finally:
                    _prep_del(ck)
            threading.Thread(target=work, daemon=True).start()
        self.send_response(503)
        self.send_header("Retry-After", "3")
        self.send_header("X-Prep", urllib.parse.quote(_prep_get(ck) or "准备中"))
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _tgdm_serve_cached(self, path, kind, head_only=False):
        """Serve from the on-disk cache; sniff type by magic bytes."""
        with open(path, "rb") as f:
            magic = f.read(12)
        if magic[:3] == b"\xff\xd8\xff":
            ctype = "image/jpeg"
        elif kind == "thumb":
            ctype = "image/jpeg"
        else:
            ctype = "video/mp4"
        self._send_file(path, ctype, head_only=head_only)

    def do_HEAD(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith(("/tgdm/thumb/", "/tgdm/file/")):
            return self._tgdm_serve(u, head_only=True)
        self.send_response(405)
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/healthz":
            return self._send(200, {"ok": True})
        if u.path.startswith(("/tgdm/thumb/", "/tgdm/file/")):
            return self._tgdm_serve(u)
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
