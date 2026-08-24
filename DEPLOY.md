# x.meaigo.eu.org 部署文档（Cloudflare Worker cf-chess · 新式 Assets）

## 站点信息
- 域名: https://x.meaigo.eu.org
- Worker 名: `cf-chess`（hao 账号 `b4f91f8d3615084dd564a435f401b718`）
- API Token: `cfut_<REDACTED-见本地cf-token.txt>`
- 绑定: ASSETS(new-style assets.directory=dist) + CHESS_ROOM DO + CHESS_DB(D1 cf-chess-db, id ecc99edf-7373-4565-a750-cbe71ff97b6b) + vars.AI_SERVER_URL=https://xq.xqz.kdns.fr
- 参考版本: 9211c03c-f751-496b-81b2-c9cbc6b5e271（全功能 E2E 通过版）

## 本目录即部署包
```
wrangler.jsonc   # 配置（⚠️ jsonc 优先级高于 toml；toml 带 BOM 会被静默忽略）
index.js         # Worker 入口（DO ChessRoom + assets fallback + /api/*）
dist/
  index.html     # 改造后前端（Pikafish深度AI按钮 + 云库优先人机对弈 + 权重继承）
  js/socket-client.js, pikafish-engine.js, pikafish-worker.js, pikafish.js(=76,457B _deploy胶水),
  js/pikafish.wasm.part0/1/2, pikafish.nnue.part0/1/2
```

## 部署步骤
```powershell
cd sites\x-meaigo
$env:CLOUDFLARE_API_TOKEN="cfut_<REDACTED-见本地cf-token.txt>"
npx wrangler deploy     # 成功标志: Total Upload ≈35.62 KiB 且列出全部绑定
```
⚠️ 教训：配置必须无 BOM；若出现 "No bindings found" 或上传只有 0.36KiB，检查 jsonc/toml。

## 部署后验证
1. `GET /` 含 `startPikafishGame`、`_wMerged`，cloudai=0
2. `HEAD /pikafish.nnue.part0` = 17,737,647B；`/js/pikafish.js`=76,457B
3. `/api/train/status`、`/api/online` 200；`/ws` 可升级
4. 浏览器：Pikafish 对局出现 `bestmove g3g4` 类日志；在线对战创建房间正常

## 回滚
仪表板 → cf-chess → Deployments → 回退；或重新 deploy 本目录（git 版本 xq-cloudflare-pikafish 有完整镜像）。
