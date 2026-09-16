# 部署

```bash
bash deploy/deploy.sh kr            # 推代码、装依赖、生成 unit、重启
bash deploy/deploy.sh kr --dry-run  # 只看会做什么
```

主机名 → 端口 / 目录 / 服务名 的对应表写在 `deploy/deploy.sh` 顶部。**改端口只改那一处**,
unit 文件由 `shadowtv.service.tmpl` 生成 —— v1 的坑就是 unit 里写死了 8799,
对一台 8799 已被占用的机器执行部署会把站点悄悄改坏。

## 一次性:反向代理

`deploy/nginx-example.conf` 是模板。要点只有两条,都关于「这是个流媒体代理」:

- `proxy_buffering off;` —— 否则 nginx 会先把整段视频缓冲到磁盘再开始发。
- 超时给足(300s),上游 CDN 慢的时候不至于被掐断。

如果域名挂在 Cloudflare 后面,**:80 和 :443 都要配**。CF 是按主机名各自决定回源端口的:
同一台机器上别的站点走 :80 正常,新加的主机名却可能被 CF 用 :443 回源,落到默认 TLS 站点上,
表现为莫名其妙的 401 / 别的应用的响应。

## 与旧版共存 / 回滚

`deploy.sh kr` 默认装到 `/opt/shadowtv2`(服务名 `shadowtv2`,端口 8811),**不动**原来的
`/opt/shadowtv`。所以:

1. 部署后先直接验证:`curl http://127.0.0.1:8811/api/healthz`
2. 满意了再把 nginx 的 `proxy_pass` 从 `8810` 改到 `8811`,`nginx -t && systemctl reload nginx`
3. 出问题就把端口改回去 reload —— 旧版一直在跑,回滚是秒级的

首次部署时,如果新的 `data/rules` 是空的,脚本会把旧安装的 `data/`(规则 + 预设 + 片库)
整个复制过来。**规则和片库只存在于服务器上,永远不会被部署覆盖。**

## 环境变量

写进 systemd drop-in(`/etc/systemd/system/<服务名>.service.d/override.conf`),
这样重新部署不会把它们冲掉:

| 变量 | 作用 |
| --- | --- |
| `PORT` / `HOST` | 监听地址(unit 模板已按主机表生成) |
| `STREAM_PROXY` / `STREAM_PROXY_HOSTS` | 给被地域封锁的 CDN 走出口代理,按域名后缀限定。例:`http://127.0.0.1:3093` + `iwara.tv` |
| `TLS_SIDECAR` | Python 指纹伪装边车地址,默认 `http://127.0.0.1:8798` |
| `CACHE_LIST_TTL_MS` 等 | 抓取结果缓存时长,见 `server/config.js` |
| `ALLOW_LOCAL_HOSTS` | **只在本地开发用**,会关掉 SSRF 防护 |

## TLS 边车(仅 iwara 这类 Cloudflare 站点需要)

部署脚本**不碰**它:venv 装一次就够了,而且可能与旧版共用。

```bash
cd /opt/shadowtv2/sidecar
python3 -m venv venv && venv/bin/pip install curl_cffi
# 复用已有的 shadowtv-tls.service 即可(它监听 8798,新旧版本共享)
```

## 排查

```bash
journalctl -u shadowtv2 -f
curl -s http://127.0.0.1:8811/api/stats     # 缓存命中、内存、边车是否活着
curl -s http://127.0.0.1:8811/api/sites
```
