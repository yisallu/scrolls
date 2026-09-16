# 规则样例

这里是 `data/rules/` 的**脱敏副本** —— 选择器、分类、翻页、过滤规则都是完整的，
只有需要登录的站点把 `headers.Cookie` 换成了 `***`。

`data/` 本身不进 git（见 `.gitignore`）：它装着真实的站点 Cookie，而且按设计只存在于
服务器上，`deploy.sh` 从不同步它。

用法：复制一份到 `data/rules/`，把 `***` 换成你自己账号的 Cookie，或者直接
`POST /api/rules` 上传。服务端的 `mergeSecrets` 会在保存时保留已有的真实值，
所以用 `***` 重新 POST 一条规则不会把线上的 Cookie 覆盖掉。
