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

- `equity.equityPct`：你的手牌对 `opponentCount` 个均匀随机手牌的胜+平率（蒙特卡洛，
  `stderrPct` 是采样误差）。可以把 `samples` 调大（上限 25000），反正没有出牌倒计时。
- `economics.callBreakevenEquityPct`（=跟注保本胜率）：**equityPct 明显低于它时不要跟注**，
  还要给实现留出余量；equityPct 远高于它才考虑加注获取价值。
- **`shoveWarning` 非空时（对手全下或需要投入超过 1/3 筹码）：这是服务端在警告你
  随机 equity 已经不可信**——上一局就是拿着随机 equity 高的错觉用 K6o 跟了 5440 全下
  输掉整场。按警告里的 15pp + premium 规则执行；拿不准就弃，锦标赛里活着比跟注值钱。
- `position.seatClass` / `playersBehind` / `actsLast`：位置。后面还有人没行动时，
  诈唬和薄价值下注要更保守；压轴行动（`actsLast`）可以放宽。
- `reads[]`：对手公开画像（VPIP / PFR / 激进度 / 弃牌率 / 摊牌胜率 + `hints` 标签）。
  对跟注站把薄价值下注拉满；对紧凶玩家的大注要多倍尊重；对高弃牌率玩家加大诈唬频率；
  样本不足 5 手时不要过度解读。
- `blinds.handsUntilBlindIncrease`：临近涨盲时，短码玩家要更果断地推或弃。

隐私红线（服务端已从架构上保证，请你也不要试图绕过）：equity 里的对手手牌是从
「52 张 − 你的底牌 − 公共牌」的公开未知牌池**假设采样**的——这和人类玩家的概率推理等价；
服务端永远不会把其他玩家的真实底牌或牌堆发给你，也不要尝试要求或推测更多。

## 第 4 步：汇报

打完后向用户汇报：总手数、你的名次与最终筹码、冠军是谁、关键手牌的决策理由；用
`GET /games/{id}/history?token=…` 复盘。最后把本局观战链接再发给用户一遍
（`http://127.0.0.1:8899/watch?game=<gameId>&token=<seatToken>`），方便用户回看或重新打开。

## 约束

- **禁止窥探其他对局**：不要调用 `GET /games`（游戏列表），不要读取/围观任何不是你自己创建的
  游戏的状态、牌局或历史。你只需要你自己那一局的 `gameId` 和 `seatToken`。冷启动后服务器里
  没有任何旧局，直接创建新局即可。
- 只允许在 `E:\Texas Player` 目录里写日志类文件；不要修改、移动或覆盖该目录的任何既有文件
  （exe、API.md、README.md、start.bat）。
- 不要并行开多局游戏。
- 如实汇报。输了就输了，不要粉饰。
