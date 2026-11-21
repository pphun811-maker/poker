# Agent Poker API（智能体德州扑克接口）

把原版的纯引擎（`js/gameEngine.js` + `js/bot.js`）原封不动地跑在无头 Worker 里，通过 HTTP 接口 让 AI Agent 坐下和内置
Bot 打完整锦标赛。**为 Agent 而生，不是为浏览器而生：**

- **没有回合倒计时** — 轮到 Agent 时，引擎在 Worker 里同步挂起（`Atomics.wait`），Agent 想多久都行，
  十分钟、一小时都可以，游戏规则层面没有任何超时。
- **看不到别人的牌** — Worker 里的白名单过滤器（sanitizer）只输出公开信息；其他 Bot 的手牌、
  牌堆、弃牌堆**永远不会**离开 Worker 进程边界。唯一的例外：摊牌时亮牌（扑克规则本来就要亮）。
- **不需要点浏览器** — 一个 `GET` 长轮询拿局面，一个 `POST` 出动作，标准 JSON。

原版引擎与 Bot 策略代码**零修改**（只新增了 `server/` 目录和 `deno.json` 里的一行 task）。 修改版基于
[Tehes/poker](https://github.com/Tehes/poker)，仅用于个人/教育用途。

---

## 启动

**推荐：围栏模式（编译成独立 exe，Bot 策略源码不落地）**

```sh
deno task agent-api:build          # 编译到 E:\Texas Player\agent-poker-api.exe（一次）
cd "E:\Texas Player" && agent-poker-api.exe --port=8899
```

编译产物内嵌服务端、引擎和 Bot 策略，`E:\Texas Player` 部署目录下**没有任何可读的 JS 源码**， HTTP 层也永远不会输出
`/js/*`（404）。给 Agent 打牌请用这个模式，防止它去翻 `js/bot.js` 研究 Bot 策略。`E:\Texas Player` 部署目录不依赖源码仓库运行。

**开发模式（读源码，仅开发用）：**

```sh
deno task agent-api                # 默认 127.0.0.1:8899
deno run --allow-net --allow-read=. server/main.js --port=8899 --host=127.0.0.1
```

依赖：[Deno](https://deno.com) 2.x（Windows/Linux/macOS 均可）。

---

## 接口一览

### `POST /games` — 创建游戏（坐到 0 号位）

```sh
curl -X POST http://127.0.0.1:8899/games \
  -H "Content-Type: application/json" \
  -d '{"agentName": "MyAgent", "botCount": 5, "startingChips": 2000}'
```

```json
{
  "gameId": "…uuid…",
  "seatToken": "…uuid…（保密，之后每个请求都要带）",
  "seatIndex": 0,
  "config": { "agentName": "MyAgent", "botCount": 5, "startingChips": 2000 },
  "revision": 0,
  "state": { "players": [...], "smallBlind": 10, "bigBlind": 20, ... }
}
```

- `botCount`：1–8 个 Bot（默认 5）。`startingChips`：100–1000000（默认 2000）。
- 盲注固定从 10/20 开始，每 6 手按引擎自带公式涨盲（原版规则，不可配置）。
- 锦标赛制：一人输光即淘汰，打到只剩一人（含 Agent 自己）为止。

### `GET /games/{id}/state?token=…` — 查询当前局面

- `since=<revision>`：只想要比这新的消息。
- `wait=1`：**长轮询**。阻塞直到出现比 `since` 新的事件（轮到你 / 一手牌结束 / 游戏结束），
  返回**按顺序的下一条**消息（不是最新快照），所以逐条轮询不会漏消息。
- `waitTimeout=毫秒`（默认 600000，最大 3600000）：超时返回 `waitTimedOut: true` + 当前最新局面， 不会丢状态。

响应结构：

```json
{
  "gameId": "…", "status": "running|finished|aborted|error",
  "revision": 12,
  "messageType": "turn|hand_result|game_over",
  "yourTurn": true,
  "awaitingAction": false,
  "state": { ... }
}
```

**`state` 字段（Agent 可见的全部信息）：**

| 字段                                             | 说明                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handId` `phase`                                 | 第几手、preflop/flop/turn/river/showdown                                                                                                                 |
| `communityCards`                                 | 公共牌 `["TH","9D",...]`                                                                                                                                 |
| `pot` `currentBet` `lastRaise` `raisesThisRound` | 底池（本手已投入总额）、当前需跟注额、最小加注增量、本轮加注次数                                                                                         |
| `smallBlind` `bigBlind` `blindLevel`             | 当前盲注等级                                                                                                                                             |
| `players[]`                                      | 每人：`seatIndex name chips roundBet(本街已投入) totalBet(本手已投入) folded allIn dealer smallBlind bigBlind isBot`；**只有你自己的对象带 `holeCards`** |
| `actions[]`                                      | 本手目前的动作流水（含你的）：`{phase, seatIndex, name, request, resolved}`                                                                              |
| `yourTurn` `actionState`                         | 轮到你时附带的合法动作范围，见下表                                                                                                                       |

`actionState`（轮到你时才有）：

| 字段                        | 说明                                                                |
| --------------------------- | ------------------------------------------------------------------- |
| `needToCall`                | 跟注还需要投入的筹码（0 = 可以 check）                              |
| `canCheck`                  | 能否免费过牌                                                        |
| `minRaise` `maxRaiseAmount` | 合法加注区间（**加注量按"本次新增投入"计**，不是本街总额）          |
| `minAmount` `maxAmount`     | `minAmount`=needToCall；`maxAmount`=你的全部筹码（≥ 它就是 all-in） |

`messageType == "hand_result"` 时 `state` 还带：`hadShowdown`、`totalPot`、`potResults`（每个池谁赢多少、
什么牌）、`winners`、`payouts`、`bustedPlayers`（本手打光的玩家）、**摊牌时所有亮牌者的
`holeCards`**（这是公开信息）、以及本手**权威**动作流水（`resolved` 为引擎最终结算的 action/amount）。 `game_over` 带
`champion`。

> 注意终端条件：**以消息为准，不要只看 `status`**。Agent 出局后剩余 Bot 的手牌是同步瞬间 打完的，`status`
> 可能在你还没走完旧消息时就已经是 `finished`。正确做法是按顺序走完消息流， 收到 `game_over` / `error` / `aborted`
> 这三种终端消息之一才退出；这样也不会漏掉任何 `hand_result`。响应里的 `yourTurn` 恒等于所送达消息自己的
> `state.yourTurn`，Bot 的 turn 消息跳过即可。

### `POST /games/{id}/action` — 出牌

```sh
curl -X POST http://127.0.0.1:8899/games/{id}/action \
  -H "Content-Type: application/json" \
  -d '{"token": "…seatToken…", "action": "raise", "amount": 60, "turnRevision": 12}'
```

| 字段           | 说明                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`        | 必填，创建游戏时发的 seatToken                                                                                                                                                                                                                |
| `action`       | `fold` `check` `call` `raise` `allin`                                                                                                                                                                                                         |
| `amount`       | 仅 `raise` 需要：**本次动作新增投入的筹码**（你的本街投入会变成 `roundBet + amount`）。低于 `minRaise` 自动抬到最小加注；超过 `maxRaiseAmount` 自动压回；`≥ maxAmount`（全部筹码）自动变成 all-in。响应里的 `normalized` 是引擎真正收到的动作 |
| `turnRevision` | 可选但强烈推荐：填你决策用的那份 turn 快照的 `revision`。如果这个回合已经被处理过（重复提交）或已经推进到下一手，返回 409，防止手抖双下注                                                                                                     |

错误码：`400` 非法动作（如对注 check、raise 缺 amount）· `401` token 错 · `404` 游戏不存在 · `409` 不在你回合 / 重复提交
/ 游戏已结束。

**check 相关的宽松规则**：没得跟时发 `call` 会自动转成 `check`；但有注时发 `check` 会被 400 拒绝
（宁可报错也不替你花钱跟注）。

### `GET /games/{id}/history?token=…` — 所有已结束手牌的完整记录

公开信息 + 摊牌亮牌 + 每手的权威动作流水。适合 Agent 复盘/学习。

### `GET /games/{id}/insights?token=…&samples=N` — 决策辅助数字（LLM Agent 工具）

把 LLM 不擅长的心算一次性算好返回。**隐私契约**：equity 的对手手牌是从
「52 张 − 你的底牌 − 公共牌」的公开未知牌池里**假设采样**的（人类玩家也能做的概率推理），
从不读取引擎牌堆、弃牌堆或对手真实底牌；reads 只由公开动作流水 + 摊牌亮牌构成。
响应里没有任何对手底牌、牌堆、弃牌堆字段。

- `samples`：蒙特卡洛采样数，默认 1000，范围 [200, 25000]；`stderrPct` 是采样误差。
- `headline`：3-5 行关键摘要（翻前查表结论、随机/范围胜率、底池赔率、听牌出路、全下数学）。
- `economics`：`needToCall` / `potOddsPct`（跟注价格）/ `callBreakevenEquityPct` /
  `spr` / `mRatio` / `stackCallRatio` / `committedRatio`。
- `preflop`（仅翻前）：`handClass`（如 `A3s`）、`topPercent`（Chen 排名下的起手百分位）、
  `spot`（unopened / facingLimp / facingRaise / facing3Bet / facingAllIn）、
  `ranges`（按位置的开池/跟注/3bet/4bet/push 阈值）、`flags`（是否在范围内）、
  `suggestedAction` 和一行 `rationale`。短码自动进入 push/fold 模式。面对加注/3bet
  时，如果 `vsRangePct` 低于 `callBreakevenEquityPct`（1pp 容差），建议会直接改判
  `fold`，不会只按静态查表线建议 call。
- `equity`：`equityPct`（对 `opponentCount` 个均匀随机手牌的胜+平率）、`stderrPct`、
  `samples`、`vsRangePct`（按公开动作 + VPIP/PFR 调整后的范围胜率）、`rangeSamples`、
  `rangeOpponents`（每个对手被假设的范围宽度）；牌未发 / 已弃牌 / 游戏结束时
  `available=false` 并给 `reason`。
- `draws`（仅翻牌后）：`flushDraw` / `straightDraw`、`outs.clean`（去重后的干净出路）、
  `breakevenOuts`（按底池赔率需要多少出路）、`nextCardCompletionPct` /
  `byRiverCompletionPct`（完成听牌的概率，**不是对对手的胜率**）、
  `callProfitableByPotOdds`。板面四同花且你手里无该花色时，`sharedBoardFlushSuit` 非空，
  共享板花按 0 条干净出路计。听牌判断别再用 4×outs 心算。
- `sizing`：`legal`（canCheck/needToCall/minRaise/maxRaiseAmount/maxAmount）、
  `roundBet`、`potAfterCall`、`options[]`（min、1/3、1/2、2/3、满池、`cover shortest`
  的 `amount` 与 `raiseToTotal`）。`amount` 是**新增投入**，`raiseToTotal` 是本街总额；
  `cover shortest` 是把最短码对手一把罩住的加注量，避免用 `allin` 超下自己整墩。
- `shoveWarning`：对手全下或需要投入超过 1/3 筹码时非空——提醒"随机 equity 会高估
  对真实全下范围的胜率"，附 `rangeEquityPct`（按对手 VPIP/PFR 动态调整）与
  +5pp 的跟注门槛规则；其余情况为 `null`。
- `position`：`seatClass`（button/smallBlind/bigBlind/early/middle/cutoff）、
  `positionFactor`（0=先行动，1=压轴）、`playersBehind`、`actsLast`、`headsUp`。
- `reads`：每个对手的公开行为画像——`hands` / `vpipPct` / `pfrPct` / `aggressionFactor` /
  `folds*` / `showdowns` / `showdownWinRatePct` / `hints`（≥5 手后给 tight/loose/aggressive/
  passive 标签）。
- `blinds`：当前盲注、`blindLevel`、`handsUntilBlindIncrease`（每 6 手涨盲）。

隐私契约不变：`preflop` 只从你的底牌算出百分位；`draws` 只数公开牌 + 你的底牌；
`vsRangePct` / `rangeOpponents` 仍是公开未知牌池的假设采样，不读引擎牌堆、弃牌堆或对手底牌。

### `GET /games/{id}/report?token=…` — 服务端复盘审计

打完一局后用它检查自己有没有按工具打牌。返回：

- `decisions.total` / `withInsights` / `coveragePct`：每个出牌决策是否在其回合快照之后
  调过 insights（服务端记录，不依赖客户端自报）。
- `violations[]` / `flagCounts`：与工具数字矛盾的跟注——
  `call_below_breakeven_equity`（`vsRangePct` 低于保本胜率）和
  `call_below_shove_range_rule`（全下范围胜率不足保本 +5）。
- `insightsCalls`：本局 insights 调用次数。
- `hands[]`：每手盈亏、底池、赢家、是否摊牌、筹码变化。
- `decisionLog`：最近 200 次决策的紧凑流水（动作、洞察数值、是否覆盖）。
- `placement` / `finalChips` / `netChips`：名次与筹码结果。

这是复盘工具，不是自动驾驶：它只把"你有没有违反自己查到的数字"标出来，是否偏离由你解释。

### `GET /watch` — 人类观战页面（原作 UI）

浏览器打开 `http://127.0.0.1:8899/watch`：没有参数时会列出所有游戏（带一键观战链接）； 带 `?game=<id>&token=<token>`
直接直播对应牌局。页面直接复用原作的 `css/style.css`、`cards/*.svg` 牌面、`icons/`（筹码堆、庄家/盲注徽章）和原版的座位
DOM 结构——观战画面就是原作游戏的样子。画面包含：每家的筹码/下注/弃牌置灰/全下状态、 你方 Agent 的底牌（Bot
的牌背面朝上，摊牌时自动亮出）、公共牌与底池、实时动作记录 （右侧栏）、行动者黄色脉冲高亮、赢家横幅和冠军结算。Bot
的每个动作也会作为消息推进流， 观战页面会按顺序"回放"它们。

配套的静态资源路由只开放 `/css/*`、`/cards/*`、`/icons/*` 三个白名单目录 （带路径穿越防护）；`/js/*` 永远 404。

### 其他

- `DELETE /games/{id}` — 中止并回收游戏（Agent 半路想跑就调它）。
- `GET /games` — 列出所有游戏（含 seatToken，仅限本机自用图方便）。
- `GET /health` — 健康检查。
- CORS 全开（本机服务，方便浏览器脚本调用）。

---

## Agent 主循环（参考 `server/exampleAgent.py`）

```python
client = AgentPokerClient("http://127.0.0.1:8899")
game = client.create_game(agent_name="MyAgent", bots=5, chips=2000)
gid, tok = game["gameId"], game["seatToken"]
since = 0
while True:
    r = client.state(gid, tok, since=since, wait=True)     # 阻塞直到有新事件
    since = r["revision"]
    if r.get("messageType") == "hand_result":
        ...  # 记录上一手结果（含摊牌亮牌），继续等
        continue
    if r.get("messageType") in ("game_over", "error", "aborted"):
        ...  # 游戏结束，champion 在 r["champion"]。注意：要以终端消息为准，
        ...  # status 可能在旧消息尚未走完时已变为 finished（Bot 剩余手牌是同步瞬完成的）
        break
    if not r.get("yourTurn"):
        continue   # Bot 的动作也会推进消息流（turn 消息），跳过即可，供观战/复盘
    s = r["state"]; a = s["actionState"]
    decision = my_strategy(s)                           # 想多久都行
    client.act(gid, tok, decision.action, decision.amount,
               turn_revision=r["revision"])
```

跑一个自带简单策略的演示局（`--think-seconds` 模拟长时间思考）：

```sh
python server/exampleAgent.py --base-url http://127.0.0.1:8899 --bots 3 --chips 500 --think-seconds 5
```

---

## 架构（为什么 Agent 偷看不了别人的牌）

```
HTTP 请求 ──▶ server/main.js ──postMessage(白名单快照)──▶ [agentWorker.js]
                  │                                          │  原版 gameEngine.js + bot.js
                  │  seatToken 校验、动作合法性校验、            │  （零修改，同步引擎循环）
                  │  长轮询调度                                │
                  │                                          ▼
                  └──SharedArrayBuffer──决策写回──▶ Agent 座位同步挂起（无计时器）
```

- 每局游戏 = 一个 Deno Worker。引擎整个循环是同步的，轮到 Agent 时 Worker 线程 `Atomics.wait` 挂起 ——
  **引擎停下等待，没有任何倒计时逻辑**（原版浏览器里的计时器都在 app.js UI 层，这里根本不存在）。
- Worker → 主线程只发白名单投影：逐字段挑出来的公开信息 + 你自己的手牌。牌堆、弃牌堆、 Bot
  手牌根本不会被构造出来，更不会被发出去。摊牌亮牌是唯一例外（扑克规则）。
- `server/test_api.py` 的泄漏审计会递归扫描每一个 HTTP 响应，断言除你之外任何座位都不带 `holeCards`、全响应无
  `deck`/`cardGraveyard` 字段。

## 测试

```sh
python -I server/test_api.py    # 全流程：完整锦标赛、信息泄漏审计、12s 长思考、非法动作校验、
                                # insights 新字段、/report 审计、中止
deno test server/insights.test.js  # 确定性单元测试：翻前表、听牌出路、尺寸器、动态范围
deno test --allow-read=. js/       # 原版引擎 + bot equity 测试（70 绿）
```

## 想让 Agent 上场？

把 [`server/AGENT_PROMPT.md`](./AGENT_PROMPT.md) 里整段 prompt 复制给任何能执行 shell / HTTP 请求的 Agent
即可，它会自己读文档、开局、打到冠军并汇报结果。

---

## 联机中转服务（`server/sync.js`）

浏览器版「人类联机」只需要一个很薄的中转服务，和上面的 Agent API **互相独立**：游戏引擎仍然跑在房主浏览器里，中转只负责保存最新公开牌桌、给每个真人座位下发自己的私有视角、把远端操作递回房主。

### 本地启动

```sh
deno task sync                 # http://127.0.0.1:8787
python -m http.server 8000     # 另开一个终端
# 浏览器打开 http://127.0.0.1:8000/?sync=http://127.0.0.1:8787
```

页面和联机服务都用 HTTP；GitHub Pages 的 HTTPS 页面不能直连 HTTP 中转（混合内容会被浏览器拦截）。

### 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/state` | 房主提交 `{ tableId, hostToken, humanSeats, view }`，写入/更新整桌状态 |
| `GET` | `/state?tableId&seatIndex&token&sinceVersion` | 某个座位拉取自己的投影；版本没变返回 `204` |
| `POST` | `/action` | 远端座位提交 `{ tableId, seatIndex, token, turnToken, action, amount }` |
| `GET` | `/action?tableId&turnToken&hostToken` | 房主拉取该回合的远端操作；没有返回 `204` |
| `DELETE` | `/state?tableId&hostToken` | 房主提前结束并清理牌桌 |
| `GET` | `/health` | 健康检查，返回 `storage: "kv"` 或 `"memory"` |

安全边界：

- `humanSeats` 必须带随机 `token`，`GET /state` 只返回该座位自己的 `seat`；换 `seatIndex` 拿不到别人的牌。
- 只允许真人座位的 `seatView` 上传；Bot 座位的牌不会进中转。
- `hostToken` 保护 `POST /state` 和 `GET /action`，嘉宾无法覆盖牌桌或偷看操作队列。
- CORS 默认只放行 `https://pphun811-maker.github.io` 和 localhost；可用 `ALLOWED_ORIGINS` 覆盖。

### 部署（任选一家）

中转只有一个无依赖的 Deno 文件；仓库根目录的 `Dockerfile` 可以直接跑在任何 Docker 平台，
`render.yaml` 是 Render 的一键蓝图。

**Render（推荐：免费、免信用卡、国内网络可打开）**

1. 把仓库推到 GitHub。
2. [Render Dashboard](https://dashboard.render.com/) → New → Blueprint → 连接仓库；Render 会读取
   `render.yaml`，用 `Dockerfile` 构建并启动服务。
3. 复制服务地址，例如 `https://poker-sync-xxxx.onrender.com`。
4. 填到 `js/syncConfig.js` 的 `DEFAULT_SYNC_BASE_URL`，或房主首次打开页面时用
   `?sync=https://poker-sync-xxxx.onrender.com`。

Render 免费服务约 15 分钟无流量后休眠，冷启动约 1 分钟；存储是进程内内存，休眠/重启后从空开始。
开打前先访问 `<地址>/health` 唤醒，再开新局。

**Zeabur / Koyeb / Fly.io / 自己的 VPS**

同一份 `Dockerfile`，暴露 `8000` 端口，设置 `SYNC_STORAGE=memory` 和
`ALLOWED_ORIGINS=https://pphun811-maker.github.io` 即可。Zeabur 有亚太区免费额度，Koyeb/Fly 有
小额免费/低价实例。

**Deno Deploy（仅限已有账号）**

Deno 团队已加入 Cloudflare，Deno Deploy 将于 2027 年 4 月左右下线，不再推荐新项目使用。已有账号的
话：连接仓库、Entrypoint 填 `server/sync.js`、在 Databases 里新建并绑定 **Deno KV**（多实例部署必须
有 KV，否则只能单实例）。

**本机 + 隧道（不想注册任何云服务）**

运行 `deno task sync`，然后 `cloudflared tunnel --url http://127.0.0.1:8787`，把打印的 HTTPS 地址
填进 `?sync=`。房主电脑必须一直开着，但没有冷启动和额度限制；如果 `trycloudflare.com` 对朋友不可达，
可换 cpolar、NATAPP、花生壳或自己的 VPS。

免费额度足够朋友局使用；超长牌局或多桌同时运行可能触及请求 / KV 读写额度。牌桌 8 小时过期，待处理操作 15 分钟过期。
