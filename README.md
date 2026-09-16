# 声断 · 影库 (千卷 (scrolls))

把任意视频 / 图片站点变成一个可浏览的片库,再用一个**会自己断句的播放器**看它。

播放时实时分析音量:**有声则播,静音则停**。停下时画面干净冻结、没有任何叠加 UI,
点一下画面继续,如此循环 —— 精听、跟读(shadowing)用的正是这个节奏。

---

## 两个部分

**片库** —— 站点规则(一份 JSON)描述「列表页长什么样、详情页在哪、视频文件怎么找」。
服务端负责抓取和解析,浏览器只拿到干净的 JSON 和一个**同源**的播放地址。

**播放器 ShadowPlay** —— 断句、倒放循环跟读、逐帧推进,全部围绕「把一句话听清楚」这件事。

### 为什么必须有那个媒体代理

`<video>` 只要跨源且对方没给 CORS 头,Web Audio 就读不到波形,自动断句直接失效。
所以第三方媒体一律经 `/api/stream` 转发:同源、带 Range(能拖进度)、注入 Referer/UA
(绕开防盗链)、HLS 播放列表里的每个分片也改写成走代理。**整个产品能成立,就靠这一层。**

---

## 跑起来

```bash
npm install
npm start                    # http://127.0.0.1:8799
npm test                     # 33 个用例:选择器 DSL、分页、SSRF、断句状态机、逐帧网格…
npm run build:standalone     # 生成 dist/shadowplay.html(单文件、离线可用)
```

Node ≥ 20。依赖只有两个:`cheerio`(解析 HTML)和 `iconv-lite`(GBK 之类的编码)。

部署见 [`deploy/README-deploy.md`](deploy/README-deploy.md)。

---

## 目录

```
server/
  main.js            入口:装配 + 监听
  config.js          所有可调项(全部来自环境变量)
  api.js             JSON API 路由表
  lib/               router / static / fetcher / net(SSRF 闸门)/ cache / errors
  engine/            规则引擎:dsl → extract / jsonapi / provider → ops
  media/stream.js    同源媒体代理(Range、HLS 改写、并发闸门)
  store/             rules(热重载 + 原子写 + 备份)/ prefs / library
web/
  index.html         应用外壳
  src/               ES 模块,无构建步骤:router / state / api / views / ui
  src/player/        播放器:engine(状态机 + 倒放 + 逐帧)/ presets / scope / ui
  player.html        独立播放器页(本地文件、新标签页打开)
data/                规则、预设、片库 —— 只存在于服务器上,部署不覆盖
```

## 规则长什么样

```jsonc
{
  "id": "example", "name": "示例站", "baseUrl": "https://example.com",
  "allowedHosts": ["example.com", "cdn.example.com"],   // 唯一的出站白名单
  "proxyImages": true,                                   // 封面也走代理(防盗链)
  "headers": { "Referer": "https://example.com/", "Cookie": "…" },

  "discover": [{
    "name": "最新",
    "url": "/list?page={page}",
    "page": { "start": 1, "step": 1 },
    "list": { "item": ".card", "title": ".t", "url": "a@href", "cover": "img@src||img@data-src" }
  }],
  "search":  { "url": "/search?q={kw}&page={page}", "list": { /* 同上 */ } },
  "detail":  { "title": "h1", "cover": "#poster@src", "intro": ".desc",
               "episodes": { "item": ".ep", "title": "@text", "url": "@href" },
               "tags": { "item": ".tag a", "strip": "^#\\s*|\\s*\\(\\d+\\)$" } },
  "video":   { "match": [{ "from": "selector", "selector": "video source@src" },
                         { "from": "regex", "regex": "(https?:[^\"']+\\.m3u8[^\"']*)", "group": 1 }] }
}
```

**选择器 DSL**:`css@attr`,不写 `@` 取文本,`@html` 取内部 HTML,
`a@href || img@data-src` 依次尝试、取第一个非空。URL 自动转绝对路径。

**图片站**把 `type` 设为 `"image"`:列表可以来自 HTML,也可以直接读 JSON API
(`json: { items, next, fields }`,用 keyset 游标翻页)。多页画廊(漫画 / 本子)再加
`gallery: true` 和 `galleryRule`,一个格子就是一整本,点开进阅读器。

被 Cloudflare 拦在门外的站点用 `provider` 字段转给 `sidecar/`(Python + curl_cffi
伪装 TLS 指纹),只有 API 需要伪装,媒体文件仍由本机代理直接拉。

`video.match` 支持四种找法:`selector` / `regex` / `json` / `iframe`(会跟进 iframe 再找)。

---

## 播放器里那些不显然的地方

这些是踩过坑之后才知道非这样写不可的:

**倒放不能靠倒着 seek。** 在暂停的 `<video>` 上快速往回设 `currentTime`,画面根本不重绘 ——
整段倒放期间就是一张静止的帧,然后猛地一跳。唯一可行的做法是:正放时持续把帧抓进环形缓冲
(按**屏幕上的实际尺寸**抓,不然倒放会糊),倒放时把缓存帧反向画到覆盖层 canvas 上。
canvas 用对象池复用,稳态零分配,否则每帧新建 canvas 的 GC 会造成可感的卡顿。

**逐帧要把 seek 合并。** 滚轮滚得快时连续设 `currentTime` 会让元素停止重绘。所以步进先
累加到 `pendingSteps`,同一时刻只允许一个 seek 在飞,`seeked` 回来时再把期间攒下的一次性走完。

**退出倒放循环时,`play()` 必须无条件调用**,不能等 `seeked`(可能永远不触发),
还要有看门狗重试 —— 否则会出现「点了没反应、连点十几下才逃出来」。

**测 seek 相关的东西,服务器必须支持 Range。** 不支持时 `video.seekable.end` 是 0,
所有 `currentTime =` 都被钳成 0,看起来像播放器的 bug。本项目的静态服务和媒体代理都实现了 206。

---

## 与 v1 的差别

同样的产品,重做了实现:

- **服务端**:express 换成 ~130 行的路由(依赖 60+ 个包 → 2 个);抓取加了 TTL 缓存与
  **请求合并**(同一页并发命中只打上游一次);规则文件**热重载**(v1 必须重启或 POST 才生效);
  规则写盘改为原子写 + 自动备份;SSRF 防护从「先查 DNS 再连接」改成**连接时校验解析结果**,
  堵住 DNS rebinding。
- **前端**:哈希路由 → History API,播放器变成应用内的一个路由(返回键回到原来的列表,
  不再整页跳转);字符串拼 HTML → 轻量 hyperscript(不存在漏转义);图片墙的比例来自 API,
  滚动时不再重排。
- **新增**:继续观看(带进度,服务端存储,跨设备)、收藏、漫画/画廊的连续滚动阅读器、
  播放速度、画中画、PWA、规则可在线编辑。
- **播放器**:行为逐条保留(断句两种模式、预设、倒放循环、逐帧 + 帧间隔),拆成模块并补了单测;
  单文件版 `shadowplay.html` 现在是**构建产物**,不会再和网页版各修各的。
