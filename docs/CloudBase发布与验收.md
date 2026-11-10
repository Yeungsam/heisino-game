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
| `heisino-game` | `/api/search` | `npm run account:build` 生成共享房型、物资库和随机抽取运行时 | `npm run verify:search:production` |

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

## 2026-11-09 多人移动截止修复

- 提交 `96f5994` 的 `heisino-account` 于 17:07:20 部署至上海环境 `cloud1-d5ghcmrajdca722b5`，更新前备份了旧函数代码。`heisino_match_rooms` 权限经查询确认为 `ADMINONLY`。
- 公网大厅、鉴权和微信换码冒烟通过。两名隔离验收账号验证了 `POST /api/account/game` 的截止前成功、截止后返回 `409 MOVE_DEADLINE_EXCEEDED`、原请求 ID 重试成功、并发心跳和下一回合坐标。测试账号、房间和流水已清理并核对。
- 五轮本地回归均通过，每轮 162 项。客户端已生成微信开发预览，安卓与 iOS 双机验收待完成。

## 2026-11-09 多人移动轨迹回放

- 提交 `22b4426` 的 `heisino-account` 于 17:15:35 部署至上海环境 `cloud1-d5ghcmrajdca722b5`。部署前备份了旧函数，确认房间集合为 `ADMINONLY`，部署后下载核对了回放代码及共享常量。
- 账号和大厅公网冒烟通过。首次业务验收收到缺少回放字段的响应，核对云端代码后复测通过。两名隔离账号验证了共同播放窗口、轨迹与原地停留、回放期间拒绝搜索、结束后完整 50 秒和旧版混合房间。临时数据已清理并核对。
- 五轮本地回归每轮 165 项通过。微信开发预览已生成，多设备画面和低网速下的播放体验待真机验收。

## 2026-11-09 新回合提示与回合上限调整

- 提交 `099e454` 的 `heisino-account` 于 17:21:41 部署至上海环境 `cloud1-d5ghcmrajdca722b5`。部署前备份了旧函数，房间集合权限确认为 `ADMINONLY`。
- 账号与大厅公网冒烟通过。隔离账号验证了存活玩家进入第 13 回合并继续移动、活跃房间留在大厅，以及单人模式从第 10 回合起扣血至战败。临时账号、房间与流水已清理并核对。
- 五轮回归每轮 168 项通过。微信开发预览已生成，提示动画与触控体验待真机验收。

## 2026-11-10 房型物资库

- 从提交 `894e877` 构建两个独立部署包并更新上海环境 `cloud1-d5ghcmrajdca722b5`。`heisino-account` 于 17:04:23 更新，`heisino-game` 于 17:04:28 更新，两个函数均为 `Active`。旧版本代码已分别备份。
- 账号和房间集合 ACL 为 `ADMINONLY`。独立搜索集合 ACL 为 `PRIVATE`，线上验证服务端创建的对局没有玩家所有者。隔离账号、房间、流水和搜索对局均已清理并复查。
- `/api/account` 的鉴权、大厅和微信换码冒烟通过。公网单人验证首次生成 4 件基础物资、曝光、拾取、重复请求、恢复和回房剩余物资。公网多人并发移动验证普通房间 4 件、出生点 0 件，以及只生成实际访问的房间。
- `/api/search` 公网验证 25 个房间、普通房间 4 件、中央金库 10 件、出生及撤离点 0 件、约 2 秒曝光、拾取、离开和重进剩 3 件。未访问房间仅保留区域数量计划。
- 五轮全量回归每轮 175 项通过。真机检查搜索画面、区域点击和体验版接入情况。

## 2026-11-10 随机掉落数量

- 提交 `93d7ebf` 部署至上海环境 `cloud1-d5ghcmrajdca722b5`。`heisino-account` 于 17:17:08 更新，`heisino-game` 于 17:17:13 更新，两个函数均为 `Active`，旧版已分别备份。
- 五轮全量回归每轮 177/177 通过。账号和房间集合 ACL 为 `ADMINONLY`。独立搜索集合为 `PRIVATE`，核对了服务端创建记录无玩家所有者。
- 账号鉴权、大厅和微信换码冒烟通过。公网隔离单人对局验证普通房间 2 件、拾取后重进剩 1 件；多人并发移动验证普通房间 3 件和出生点 0 件。独立搜索验证普通房间 3 件和 0 件、金库 7 件，拾取后重进剩 2 件。验收记录已清理并复查。
