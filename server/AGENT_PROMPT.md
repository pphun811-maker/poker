# 任务：通过本地接口和 Bot 打一场德州扑克锦标赛

你是一名优秀的德州扑克玩家。你的任务：通过本地 HTTP 接口和内置 Bot 打完一场完整锦标赛，
然后如实向用户汇报结果。所有相关文件都在 `E:\Texas Player` 目录下。

## 第 0 步：自己启动服务（不要等别人启动）

1. 先探测：`curl -s --max-time 3 http://127.0.0.1:8899/health`
2. 如果返回 `{"ok":true,...}`：服务已经在跑，**不要重复启动第二个实例**，直接进入第 1 步。
3. 如果连接失败：以分离/后台方式启动（不要阻塞你自己的 shell），bash 示例：
   `cd "/e/Texas Player" && ./agent-poker-api.exe --port=8899 > server.log 2>&1 &`
   （PowerShell 用 `Start-Process -WindowStyle Hidden`。）然后轮询 `/health`，最多等 15 秒。
4. 启动失败或 8899 被其他程序占用：停下向用户说明，不要自行换端口硬来。

## 第 1 步：读接口文档

阅读同目录下的 `API.md`。无论如何先记住这几条关键语义：

- `raise` 的 `amount` = **本次动作新增投入的筹码**（不是本街总额）：你的本街投入会变成
  `roundBet + amount`；合法范围 `[minRaise, maxRaiseAmount]`；`amount >= maxAmount` 会自动变全下。
- 出牌请求带 `turnRevision`（值为轮到你那份快照的 `revision`），防止重复提交。
- 轮到你时**没有任何倒计时**，你可以推理任意长时间再出牌。
- 盲注 10/20 起步，每 6 手涨盲；出牌响应里的 `normalized` 是引擎真正执行的动作。

## 第 2 步：开局

`POST http://127.0.0.1:8899/games`，body：
`{"agentName": "<你的名字>", "botCount": 5, "startingChips": 2000}`。
记下 `gameId` 和 `seatToken`（seatToken 之后每个请求都要带）。

**开完局立刻给用户打开观战席**——用系统默认浏览器打开本局观战页，让用户马上能看到画面：
`explorer.exe "http://127.0.0.1:8899/watch?game=<gameId>&token=<seatToken>"`
（在 bash 里执行即可；用 `cmd /c start "" "<url>"` 或 PowerShell `Start-Process "<url>"` 等价方式也行。
打开后不用等待页面，直接继续第 3 步打牌。）

## 第 3 步：主循环（打到冠军或你出局为止）

1. `GET /games/{id}/state?token=…&since=<revision>&wait=1` —— 长轮询，阻塞到有新事件；
   收到的消息按 `revision` 顺序逐条走，不会漏。
2. `messageType == "hand_result"`：把上一手结果记入笔记（赢家、摊牌亮了什么牌、各家动作），
   继续等。
3. `messageType` 是 `game_over` / `error` / `aborted`：游戏结束，跳出循环。**不要只看
   `status` 字段**——你出局后 Bot 的剩余手牌是同步瞬间打完的，`status` 可能在你还没走完
   旧消息时就已变成 `finished`。
4. `yourTurn == true`：**先调一次决策辅助接口**（见下方「决策辅助工具」），再结合 `state`
   ——你的底牌、公共牌、底池、`actions` 动作流水、各家筹码与下注、`actionState` 合法范围
   ——按真实锦标赛策略决策，然后 `POST /games/{id}/action` 出牌。
5. 回到第 1 步。

### 决策辅助工具：`GET /games/{id}/insights?token=…&samples=N`

**每个行动轮都必须先调它，没有例外**——包括看似可以凭直觉 check/弃牌的局面。上一手
查过的数字这一手已经失效：局面一变就要重新查。凭手感打牌是上一局输掉锦标赛的直接原因
（96 个行动轮只查了 9 次）。LLM 不擅长心算，让接口替你把数字算好：

- `headline`：本手最关键的几行摘要。先看它，再按需读下面的细节段。
- `preflop`（翻前才有）：`handClass` / `topPercent` / `spot` / `seatClass` /
  `ranges` / `suggestedAction`。翻前**不要用 `equityPct` 的随机胜率做决定**（A3o 对随机
  约 57%，对 UTG 开池范围可能只有 35%）；优先按 `suggestedAction` 和 `ranges` 查表，
  短码（`flags.pushFoldMode`）按 push/fold 处理。范围表是 6-max 通用近似，不是 GTO；
  边缘手结合 `reads` 和对手实际行动调整，`suggestedAction` 是参考线不是强制命令。
  **跟注优先级**：只要 `equity.vsRangePct` 比 `economics.callBreakevenEquityPct` 低
  （留 1pp 余量），即使 `suggestedAction` 说 call 也不要跟；查表线和范围数学冲突时，
  以 vsRangePct 和硬规则为准。
- `draws`（翻牌后才有）：`outs.clean` 是干净出路，`breakevenOuts` 是按当前底池赔率
  "至少需要多少出路"，`byRiverCompletionPct` 是**完成听牌的概率，不是对对手的胜率**。
  听牌跟注先用 `callProfitableByPotOdds` 做初筛，再结合隐含赔率。若
  `sharedBoardFlushSuit` 非空（板面四张同花、你手里没有该花色），这是全桌共享的板花，
  不要当自己的同花听牌；这类出路已经按 0 计入 `outs.clean`。
- `equity.equityPct`：你的手牌对 `opponentCount` 个均匀随机手牌的胜+平率（蒙特卡洛，
  `stderrPct` 是采样误差）。可以把 `samples` 调大（上限 25000），反正没有出牌倒计时。
- `equity.vsRangePct`：按对手公开动作 + VPIP/PFR 调整后的范围胜率。**面对下注/加注时优先
  看它**；`equityPct` 只作"对任意两张牌"的基线，直接拿来跟注会高估。
- `equity.yourHand`：引擎评估的你当前成牌名（翻牌后非空）——**以它为准，不要自己读牌**。
  上上局把 4-5-6-7 四连牌误读成顺子多送 1000，而 insights 的数字早就说明那不是顺子。
- `economics.callBreakevenEquityPct`（=跟注保本胜率）：`vsRangePct` 明显低于它时不要跟注，
  还要给实现留出余量；`vsRangePct` 远高于它才考虑加注获取价值。
- **`shoveWarning` 非空时（对手全下或需要投入超过 1/3 筹码）：随机 equity 已不可信——
  第一局就是拿着随机 equity 的错觉用 K6o 跟了 5440 全下输掉整场。改用真实数学：
  `shove.rangeEquityPct`（按对手 VPIP/PFR 和筹码深度动态调整的全下范围）≥
  `callBreakevenEquityPct` + 5 才考虑跟注，否则弃牌**（死 zone（mRatio < 3）按 push/fold
  处理除外）。`shove.rangeOpponents` 会告诉你每个对手被假设的多宽范围，紧手给窄、疯子给宽。
- `sizing`：`options` 里每个尺寸的 `amount` 是**本次新增投入**，`raiseToTotal` 是本街总额。
  想打 1/2 池、2/3 池、满池就直接选对应 `label` 的 `amount`，不要自己换算；`legal` 里是
  最小加注和上限。要"刚好罩住短码对手"时用 `cover shortest` 选项（`amount` 已按对手总筹码
  算好），**不要用 `allin` 去罩比自己短的对手**——`allin` 永远是你的全部筹码。
- `position.seatClass` / `playersBehind` / `actsLast`：位置。后面还有人没行动时，
  诈唬和薄价值下注要更保守；压轴行动（`actsLast`）可以放宽。
- `reads[]`：对手公开画像（VPIP / PFR / 激进度 / 弃牌率 / 摊牌胜率 + `hints` 标签）。
  对跟注站把薄价值下注拉满；对紧凶玩家的大注要多倍尊重；对高弃牌率玩家加大诈唬频率；
  样本不足 5 手时不要过度解读。
- `blinds.handsUntilBlindIncrease`：临近涨盲时，短码玩家要更果断地推或弃。

### 每轮决策顺序（照做，别跳步）

1. 调 `insights`，先读 `headline`。
2. 翻前：按 `preflop.suggestedAction` + `ranges` 定动作；翻后：先看 `draws` 和
   `equity.vsRangePct`，再看 `economics.callBreakevenEquityPct`。
3. 面对全下/大额跟注：只信 `shove.rangeEquityPct ≥ callBreakevenEquityPct + 5`。
4. 要加注/下注：从 `sizing.options` 选尺寸，确认 `amount` 是新增投入。
5. 出牌，然后继续长轮询。连续两手之间也要重新查，数字会随牌面/底池变化。

隐私红线（服务端已从架构上保证，请你也不要试图绕过）：equity 里的对手手牌是从
「52 张 − 你的底牌 − 公共牌」的公开未知牌池**假设采样**的——这和人类玩家的概率推理等价；
服务端永远不会把其他玩家的真实底牌或牌堆发给你，也不要尝试要求或推测更多。

## 第 4 步：汇报

打完后向用户汇报：总手数、你的名次与最终筹码、冠军是谁、关键手牌的决策理由。复盘时先用
`GET /games/{id}/report?token=…`：

- `decisions.coveragePct`：每次出牌前是否真的调了 insights（低于 100% 说明有轮次凭手感）。
- `violations[]` / `flagCounts`：与工具数字矛盾的跟注（`call_below_breakeven_equity`、
  `call_below_shove_range_rule`）。逐条解释：是读错了牌、忽略了赔率，还是有意偏离。
- `hands[]`：每手盈亏和筹码变化，用来看波动来源。

再用 `GET /games/{id}/history?token=…` 看完整动作流水。最后把本局观战链接再发给用户一遍
（`http://127.0.0.1:8899/watch?game=<gameId>&token=<seatToken>`），方便用户回看或重新打开。

## 约束

- **禁止窥探其他对局**：不要调用 `GET /games`（游戏列表），不要读取/围观任何不是你自己创建的
  游戏的状态、牌局或历史。你只需要你自己那一局的 `gameId` 和 `seatToken`。冷启动后服务器里
  没有任何旧局，直接创建新局即可。
- 只允许在 `E:\Texas Player` 目录里写日志类文件；不要修改、移动或覆盖该目录的任何既有文件
  （exe、API.md、README.md、start.bat）。
- 不要并行开多局游戏。
- 如实汇报。输了就输了，不要粉饰。
