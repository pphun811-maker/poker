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
- `economics`：`needToCall` / `potOddsPct`（跟注价格）/ `callBreakevenEquityPct` /
  `spr` / `mRatio` / `stackCallRatio` / `committedRatio`。
- `equity`：`equityPct`（对 `opponentCount` 个均匀随机手牌的胜+平率）、`stderrPct`、
  `samples`；牌未发 / 已弃牌 / 游戏结束时 `available=false` 并给 `reason`。
- `position`：`seatClass`（button/smallBlind/bigBlind/early/middle/cutoff）、
  `positionFactor`（0=先行动，1=压轴）、`playersBehind`、`actsLast`、`headsUp`。
- `reads`：每个对手的公开行为画像——`hands` / `vpipPct` / `pfrPct` / `aggressionFactor` /
  `folds*` / `showdowns` / `showdownWinRatePct` / `hints`（≥5 手后给 tight/loose/aggressive/
  passive 标签）。
- `blinds`：当前盲注、`blindLevel`、`handsUntilBlindIncrease`（每 6 手涨盲）。

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
python server/test_api.py      # 全流程：完整锦标赛、信息泄漏审计、12s 长思考、非法动作校验、中止
deno test --allow-read=. js/gameEngine.test.js js/bot.test.js   # 原版引擎测试（未改动，应全绿）
```

## 想让 Agent 上场？

把 [`server/AGENT_PROMPT.md`](./AGENT_PROMPT.md) 里整段 prompt 复制给任何能执行 shell / HTTP 请求的 Agent
即可，它会自己读文档、开局、打到冠军并汇报结果。
