# 象棋弈台 部署文档（Cloudflare Worker cf-chess2 · 新式 Assets）

> 原版主仓库（会员版克隆见 xq-cloudflare-member）。

## 站点信息
- 线上地址: https://xq.chaf.eu.org
- Worker 名: `cf-chess2`（账号 `b675680cf61b31dd9e84c11f089e2ed4`）
- API Token: `cfut_...`（取本地 `Token.txt` 第一个 token；文件内还有 GitHub PAT `ghp_...`）
- 网络: 出站走代理 `http://127.0.0.1:10809`（部署与 git 推送都需设置）
- 绑定（wrangler.jsonc）:
  - `ASSETS`（新式 assets，directory=dist，`run_worker_first` 覆盖 / /index.html /admin）
  - `CHESS_ROOM` DO（房间对局，SQLite 类）
  - `MATCH_QUEUE` DO（匹配队列 + **在线人数唯一账本**：连接注册表/设备去重/心跳保活/70 秒僵尸清理）
  - `CHESS_DB`（D1 `cf-chess2-db`，id `f392b3d4-3786-4c90-a9ea-a22d985002d6`：对局历史每设备 10 局）
  - vars: `AI_SERVER_URL=https://xq.xqz.kdns.fr`

## 本目录即部署包
```
wrangler.jsonc   # 配置（⚠️ jsonc 优先级高于 toml；toml 带 BOM 会被静默忽略）
index.js         # Worker 入口（DO ChessRoom/MatchQueue + 大厅ws + /api/* + assets fallback）
dist/
  index.html     # 前端（名称: 象棋弈台；复盘；人机对弈；刷新自恢复：AI局/复盘面板/在线房间）
  js/socket-client.js, pikafish-engine.js, pikafish-worker.js, pikafish.js,
  js/pikafish.wasm.part0/1/2, pikafish.nnue.part0/1/2
```

## 部署步骤
```powershell
cd xq-cloudflare-member
$env:CLOUDFLARE_API_TOKEN="cfut_...（Token.txt 第一个）"
$env:HTTPS_PROXY="http://127.0.0.1:10809"; $env:HTTP_PROXY="http://127.0.0.1:10809"
npx wrangler@latest deploy
# 成功标志: 输出 "Current Version ID: xxxx"
```
⚠️ 教训：配置必须无 BOM；若出现 "No bindings found" 检查 jsonc/toml。
⚠️ Worker 全局作用域禁止 setInterval/fetch（部署时 API 校验 10021 拒绝）——心跳类逻辑要挂在连接事件里节流执行。

## 部署后验证
1. `GET /` 标题为 `象棋弈台`，含 `startPikafishGame`；HTML 响应头 `Cache-Control: no-store`
2. `/api/online` 返回 DO 权威在线数（与页面显示一致）；`/api/match/debug` 可看在线注册表明细
3. `/api/train/status` 200；`/ws` 可升级；创建房间正常
4. 刷新自检：人机对弈刷新恢复棋盘+棋谱；复盘打开后刷新面板恢复（未分析完会自动续跑）

## Git 仓库
- 原版: https://github.com/jwfst5088/xq-x-meaigo （远程名 upstream）
- 会员版: https://github.com/jwfst5088/xq-cloudflare-member （远程名 origin，本仓库）

## 回滚
仪表板 → cf-chess2 → Deployments → 回退；或重新 deploy 本目录（两个 GitHub 仓库均有完整镜像）。
