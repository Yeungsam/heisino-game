# CloudBase 发布与验收

服务端代码、接口、网关、数据库配置，或云函数读取的共享规则与卡牌数据发生变更时执行。由开发者完成部署和公网验证，再交付依赖这些变更的客户端。

1. 确认客户端 `client/js/config.js` 的实际请求域名，核对 CloudBase 环境、对应网关、当前函数版本和待发布 Git 提交。当前客户端连接上海环境 `cloud1-d5ghcmrajdca722b5`。
2. 更新全局回归用例并运行 `npm run test:regression -- --rounds 5`。发布前确认数据库集合、必要索引、仅服务端访问权限及旧存档兼容。保留回退所需的上一个函数版本或代码包。
3. 登录 CloudBase CLI 后部署该次变更影响的函数。已有函数优先用代码更新保留云端凭证和配置。新增接口或函数需要核对 HTTP 网关映射，更新所需配置后再测试实际公网 URL。
4. 执行对应的线上冒烟命令，并直接验证新增或变更接口的 HTTP 方法、路径、预期状态及业务响应。需要身份的流程用专用验收账号验证，使用真机测试新版客户端的关键路径。
5. 在发布记录写明 Git 提交、环境、函数、部署结果、接口验收和待验收项。任何失败均记录具体错误并排查，确认通过后再交付依赖该变更的客户端。

| 云函数 | 公网路径 | 发布前准备 | 线上冒烟 |
|---|---|---|---|
| `heisino-account` | `/api/account` | `npm run account:build` 生成完整运行时 | `npm run verify:account:production` |
| `heisino-cards` | `/api/cards` | 核对生成的卡牌目录与卡面 | `npm run verify:cards:production` |
| `heisino-game` | `/api/search` | 核对独立搜索规则与卡牌映射 | `npm run verify:search:production` |

在仓库根目录执行下面的代码更新命令，按本次影响范围选用。账号和搜索函数使用锁定的云端依赖。卡牌函数直接用 Node 内置模块运行。

```bash
tcb login
npm run account:build
tcb fn code update heisino-account -e cloud1-d5ghcmrajdca722b5 --deployMode zip
tcb fn code update heisino-cards -e cloud1-d5ghcmrajdca722b5 --deployMode zip
tcb fn code update heisino-game -e cloud1-d5ghcmrajdca722b5 --deployMode zip
```

[CloudBase 代码更新说明](https://docs.cloudbase.net/cli-v1/functions/code-update)

大厅验收至少检查 `OPTIONS /api/account/lobby` 返回 204，未登录 `POST /api/account/lobby` 返回 401 `UNAUTHENTICATED`，以及已登录可获取列表和建房。单人验收走真实 `SINGLE` 开局、恢复和结算。检查房间集合 `heisino_match_rooms` 为仅服务端可访问。账号冒烟使用无效微信登录码验证微信换码链路，真实登录、建房、单人开局和数据库事务需单独验收。

环境变量保存在 CloudBase，发布和验收记录只写变量名与检查结果。

## 2026-11-09 多人大厅与单人模式服务端发布

- 从 `codex/multiplayer-single-player` 的 `1b25c5d` 发布到上海环境 `cloud1-d5ghcmrajdca722b5`。代码更新前已下载三个函数的旧版本备份。
- `heisino-cards` 于 10:56:10 更新，公网返回 53 张卡，四类卡面均可访问，守卫圆盾复用原圆盾卡面。
- `heisino-account` 于 10:56:15 更新。`heisino_match_rooms` 已创建并通过云端 ACL 查询确认 `ADMINONLY`。大厅 `POST` 从 404 恢复到未登录预期的 401 `UNAUTHENTICATED`，`OPTIONS` 返回 204，微信换码冒烟通过。已登录的微信开发者工具可以进入大厅并显示正常的空房间列表。
- `heisino-game` 于 10:56:32 更新。独立搜索对局的建局、进入房间、物资曝光、拾取和离开通过线上冒烟。
- 本次发布前的五轮本地回归均通过，每轮 158 项。多人建房开局、单人完整对局及结算仍待真机验收。
