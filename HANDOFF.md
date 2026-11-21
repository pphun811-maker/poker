# 项目交接（给之后维护本项目的 agent）

> 2026-11-16 由 ZCode 会话写入。当前项目状态：原版 Tehe's Poker 单机网页游戏 + `server/` 无头 agent API + 人类席位。本文是**增量交接**——原项目的架构说明在 `AGENTS.md` 和 `README.md`，引擎规则在 `js/gameEngine.js` 的模块头注释，本文只讲"后来发生了什么"和"怎么继续"。

## 一、红线（改代码前先背下来）

1. **bot 决策只能用公开信息**：绝不读 `gameState.deck`、弃牌堆、对手真实底牌。`server/agentWorker.js` 的白名单 sanitizer 保证状态投影无泄牌；`scopeStateForToken` 保证人类局按 token 裁剪底牌。任何改动都要保住这条，测试里 `audit_no_card_leaks` 是守门员。
2. **insights 的 equity 只用公开数学**：`js/botEquity.js` 从「52 张 − 自己底牌 − 公共牌」采样假设手牌。**不要**改用引擎的真实牌堆采样——`gameState.deck` 排除了对手的实际手牌，用它等于间接泄牌（用户明确红线：连"采样对手手牌"这种表述都容易误导，实现上必须是纯公开信息推导）。
3. **牌面格式是大写花色**（`"KC"`、`"2S"`，见 `INITIAL_DECK`）。混入小写会让采样池出现"幽灵重复牌"（pokersolver 视为不同牌），历史教训见 `js/botEquity.test.js` 的校准测试。
4. **身份永远来自 seatIndex，绝不从数组顺序猜**。引擎每手轮转 players 数组顺序，且 agent 出局后会被移出数组——`server/insights.js` 里那个 `(state.players ?? [])[0]` 回退曾把任意座位当成 agent（commit d08c977 修掉）。
5. **agent 实战红线**见 `server/AGENT_PROMPT.md`：每轮必调 insights、面对全下用 `shove.rangeEquityPct ≥ callBreakevenEquityPct + 5` 判断（随机 equity 会高估对真实全下范围的胜率——第一局 K6o 跟 5440 全下输掉锦标赛的教训）。
6. **`js/cheatPanel.js` 是原版游戏的本地外挂面板，只能被 `index.html` 加载**（2026-11-17 用户要求的偷看牌/改自己手牌调试工具）。它直接读写真实牌张，绝不允许被 `server/`、remote 席位或任何 agent 可达路径引入；红线 1 的 sanitizer 体系与此无关，别把两者混到一起。

## 二、今日里程碑（全部有提交与验证记录）

| 提交 | 内容 | 验证 |
|---|---|---|
| （2026-11-21，未提交） | **开局前摇人 + 大厅**：`index.html` 新增「摇人」按钮（开始区 + footer 常驻），打开 `#invite-overlay`；每个真人座位显示 QR、私有链接、复制/打开按钮。未开局时点摇人先生成 `tableId`/hostToken/座位 token，并 POST 一份 `phase:"lobby"` 视图到 relay；嘉宾链接带 `pending=1`，未开局时显示「等待房主开局…」并按 3s 轮询，房主点开始后自动切到真牌局。`sendTableState` 会等待 lobby POST，避免慢请求把开局状态覆盖回大厅；同时加了 in-flight/dirty 队列防止并发状态乱序。materials: `js/i18n.js` 的 `invite.*`、`css/style.css` 的 `.invite-*`、`remoteTable.js`/`singleView.js` 的 pending 处理 | 本地 relay + 无头 Chrome 双端 E2E：开局前点摇人得到 2 张卡、2 个 QR；嘉宾先看到大厅两名玩家且无亮牌；房主开始后嘉宾看到自己的 TS/TC；跨座位 403；局中 footer 摇人链接不带 pending；测试桌 DELETE 204。另用 IAB 截图验收摇人面板布局 | 
| （2026-11-21，未提交） | **人类版联机**：新增 `server/sync.js` 单文件中转（Deno Deploy / 本地均可，Deno KV + 内存回退），复用原 `/state`、`/action` 协议。客户端新增 `js/syncConfig.js`（`?sync=` → localStorage → `DEFAULT_SYNC_BASE_URL`），并给每个真人座位生成随机 token、房主生成 hostToken；`sendTableState` 只上传真人 `seatView`，服务端按 token 投影，换 `seatIndex` 拿不到别人的牌；入座链接携带 `tableId/seatIndex/token/sync`，切换 companion/remote 视图时保留；断线/未配置有中英提示。部署步骤见 README「Online Multiplayer Relay」和 `server/README.md` | `deno task sync:test` 9 绿；本地 Deno 中继 + 无头 Chrome 双客户端 E2E：Alice 只看到自己的 5S/4S、其余全暗；Alice token 查 Bob/Bot 座位均 403；伪造 hostToken POST 403；远端 Bob/Frank 点击「跟注」后房主 `activeSeatIndex` 前进、筹码/下注更新；入座链接不含 `card1/card2`（避免把牌写进 URL） |
| `386b3df` | bot equity blend：postflop 决策闸门 = 0.6×真实蒙特卡洛 equity + 0.4×原手牌分类强度（`js/botEquity.js` + `EQUITY_BLEND_WEIGHT` in `js/bot.js`） | 100 局候选 + 双向 equity 审计 + 500 局确认：面对下注弃牌率 44.7%→28.7%（要求 31.9%），硬失败 0，冠军分布更均匀 |
| `e3ad5c9` | `server/` 无头 agent API（HTTP 长轮询、无出牌倒计时、防泄牌投影、insights 端点、人类席位前身） | `python -I server/test_api.py` 全绿 |
| `783f886` | shoveWarning（全下/大额跟注警告）+ prompt 硬化（每轮必调 insights） | 第一局实战暴露的问题：LLM 96 轮只查 9 次、K6o 裸跟全下 |
| `8659e8d` | 观战页人类操作条修复（提交成功后按钮永久禁用的 bug） | 实战单挑发现 |
| `44c56c3` | `shove.rangeEquityPct`（对 Chen 排名顶部 20% 范围的真实 equity）+ `equity.yourHand`（引擎成牌名） | 校准：K6o 对随机 0.55 / 对范围 0.43；AA 0.86/0.81 |
| `d08c977` | 出局后 agent 身份窃取修复（见红线 4） | 探针抓现行 + 5 连跑全绿 |
| `f8eded0` | **人类席位**：`POST /games {"humanSeat": true, "botCount": 0}` = agent vs 人类 heads-up；watch 页操作条（弃/过/跟/加注滑条）；token 底牌裁剪；/insights 按调用者视角 | 双席对打测试 + 越权 409 + 双视角泄牌审计 |
| （2026-11-17，未提交） | **原版游戏强化**：① 删除每手结束后的 20s 自动发牌倒计时（`NEW_ROUND_COUNTDOWN_*`、`startNewRoundCountdown` 等全部移除，"New Round" 按钮保留手动点）；② 一键重玩按钮 `#replay-button` → `restartTournament()`（开局时抓座位配置存 `lastGameSeatConfig`，重开同配置锦标赛；`bot.js` 新增 `clearBotActionQueue` 防旧动作定时器打进新局）；③ 本地外挂面板 `js/cheatPanel.js` + `#cheat-overlay`（Cheat 按钮打开：偷看全部底牌/牌堆数，52 格选牌换自己手牌，牌从 deck 扣、旧牌进 graveyard，台面上的牌自动禁选）；SW bump `2026-11-17-v1` | deno test 70 绿 + engine:batch 硬失败 0 + 浏览器全流程实测（倒计时 24s 不重开、改牌即时生效、Replay 重置盲注/筹码/座位、存档恢复后 Replay 能复活被淘汰座位） |
| （2026-11-17，未提交） | **原版游戏汉化 + 滚动条主题化**（用户要求，覆盖 AGENTS.md 的"不重写 UI 文案"规则）：index.html/app.js/gameEngine/shared（actionModel、tableViewRenderer、sound）全部用户可见文案翻成中文，`getShortHandStrengthLabel` 牌型标签和摊牌赢池通知的牌型名（app.js `HAND_NAME_ZH` 映射）也翻了；页面与各面板滚动条用 `scrollbar-width/color` + `::-webkit-scrollbar` 按主题蓝黄配色；用户明确要求 UI 不出现「·」分隔符；`<title>` 改「德州扑克」，og:* 社交标签与 footer "made by Tehes" 署名、`VERSION_LOG` 版本记录、`hole-cards.html`/`remoteTable.html` 远程页**保持英文未动**（署名是许可证要求，远程页是独立功能） | deno test 70 绿 + 浏览器实测（开局提示/盲注/庄家/弃牌/赢池通知中文、按钮与说明弹窗中文、外挂面板中文、滚动条 thin+主题色生效、全文无「·」） |
| （2026-11-17，未提交） | **第二轮 UI 改造**（用户要求）：① 删音效（app.js 断开 sound.js，文件保留给 remoteTable/singleView）；音效按钮位换成 **中/EN 语言切换**（`js/i18n.js`：全部 UI 文案入 zh/en 字典，静态 HTML 走 `data-i18n`/`data-i18n-placeholder`，动态走 `t()/tf()`，语言存 localStorage `poker:lang`，切换即时重渲染）；② 外挂按钮删除，改为键盘暗号 **show**（焦点不在输入框/editable 时按 s-h-o-w 触发 openOverlay）；③ 外挂面板两区块默认收起（details/summary），偷看牌区加「悬浮看牌」开关：机器人手牌渲染为 3D 翻牌卡（牌背默认、hover rotateY 0.45s 翻面），人类座位/公共牌直显，800ms 轮询改三级 diff 防打断 hover；④ 加注金额框 `<output>` → 可输入 `<input#amount-input>`（打字中不回写不打断，change/blur/Enter 吸附最小合法加注，Escape 恢复）；⑤ 中文字体加 Noto Sans SC（Google Fonts 与 Secular One 同请求）。SW bump `2026-11-17-v4`。**坑**：给无 import 的模块（tableViewRenderer/actionModel）插 i18n import 时 CRLF banner 不匹配导致假成功 → 运行时 `t is not defined` 卡死 bot 行动链；`js/shared/*` 用 `../i18n.js` 不是 `../../`；**bot.js 严禁引入 i18n**（审计脚本 `.split("` 误报 `t("` 曾误插，已撤）。翻牌 inner 是 span 需显式 `display:block` 否则 0×0 | deno test 70 绿 + 浏览器全流程实测（中英切换、show 触发、悬浮翻牌、改牌、金额输入打字/确认/Escape、英文模式全文案） |
| （2026-11-17，未提交） | **SW 彻底禁用 + 第三轮微调**（用户反馈驱动）：`USE_SERVICE_WORKER = false`（模块自带 unregister+清缓存路径；本地玩不再有"改了不生效/新旧混跑卡死"的缓存地狱，之前 P1 卡死与 P2 重玩异常全是混合缓存所致；发布 GitHub Pages 时改回 true 并 bump 版本）。重玩按钮从行动区挪到 **footer 左下**（sound-toggle 胶囊样式，防止误点出牌按钮）；「悬浮看牌」开关从偷看牌折叠区**提到面板顶层常驻**、默认关（面板打开即见，开了才允许悬浮翻牌）。SW 版本号 v5（禁用后仅作标识） | deno test 70 绿 + 浏览器实测（footer 重玩即点即重开、顶层开关联动翻牌、SW 注册数 0 缓存空） |；**第四轮**：牌桌悬浮从"换图+翻转动画"（会抽搐）改为**手电筒遮罩**——`app.js` 的 `syncCheatTableCardHover` 给每张暗牌挂一个 div.cheat-card-torch 兄弟层（div 不参与 `img:nth-of-type` 布局），牌面做 background-image，CSS `mask-image: radial-gradient` 以鼠标为中心挖洞透出牌面（mousemove 更新 --mx/--my，光斑实时跟随、无动画帧），面板 3D 翻牌保留；`js/shared/*` 与 app.js 是混合行尾文件，批量脚本必须按行处理并用实际行尾做锚点 | deno test 70 绿 + 浏览器实测（光斑跟随、移开恢复全暗） |；**第六轮**：clip-path 硬边无羽化 + torch-on 类被轮询清除导致频闪（用户 Chrome 实测）→ 手电筒重写为**双图层结构**：torch 容器内叠 `img.cheat-torch-face`（牌面）+ `div.cheat-torch-backdrop`（radial-gradient 以 --mx/--my 为中心挖羽化洞：中心透明露牌面、82px 外盖暗色）；无动画类/无 mask/无 clip，洞位置仅两个 CSS 变量更新 → 无频闪无抽搐；transform 只在 torch 创建时复制一次（poll 不重读，避免跟随座位高亮动画抖动）；enter 直接委托 move 设坐标 | deno test 70 绿 + 浏览器实测（跨牌光斑、羽化边缘、两张同亮） |；**第七轮**：clip-path 硬边 + backdrop 暗罩方案仍有硬边/黑块/频闪（用户 Chrome 实测）→ 终版结构：torch 层改为**单个 img.cheat-card-torch（牌面图）+ 自身羽化 mask**（`mask-image: radial-gradient(circle at --mx/--my, #000 44px → transparent 82px)`，圆外透明直接露出底下渲染器牌背）；显隐不再走"类切换+轮询依赖"（频闪根因），改为 `.cheat-hand-hovering` 容器类（enter 加/leave 140ms 防抖移除，防两卡间隙抖动灭灯）；mask 常驻、位置仅 --mx/--my 两变量更新 → 悬停期间零重绘闪烁（采样 1.6s 全 visible） | deno test 70 绿 + 浏览器实测（羽化跨牌光斑 + 悬停稳定性采样全 visible） |；**第八轮**：用户 Chrome 仍频闪+"牌摇摆" → 根因是原版规则 `main .seat .hole-cards img { transition: all 0.3s }` 同样作用于 torch 层——每次 mousemove 更新 mask-image 都变成 **0.3s 离散过渡**（前半旧遮罩后半新遮罩交替 = 频闪 + 黑边忽现忽失 + 可见区抖动"摇摆"）。修复：`.cheat-card-torch { transition: none; }`（computed mask 圆心已验证即时跟随）；羽化收紧 82→70px | deno test 70 绿 + computed mask 即时性验证 |

| （2026-11-17，未提交） | **手电筒频闪修复（已完成，按当前版本收工）**：800ms 轮询会无条件销毁并重建牌面层，造成遮罩与显示状态重置；现牌码和图层相同时复用，只校准几何位置。移除 mousemove 对 `--mx/--my` 的连续更新和动态 mask，改为悬停具体暗牌时整张牌面 opacity 淡入，离开牌手区域 140ms 后淡出；关闭开关或牌面公开时移除覆盖层 | `node --check js/app.js` 通过；`deno test js/` 未运行（环境没有 `deno`）；真实 Chrome 鼠标验收未做，用户接受当前版本收工 |
| （2026-11-17，未提交） | **删掉底部横向滚动条 + 一键启动**：`body`/`main` 的 `width: 100vw` 改 `100%`（100vw 含垂直滚动条宽度，页面一竖向滚动就横向溢出 10px，原版老毛病）；SW bump `2026-11-17-v3`；新增 `启动游戏.bat`（GBK 编码——中文 Windows cmd 按 GBK 解析 bat，UTF-8 会乱码；netstat 探测 5500 已占用就直接开页面，否则后台起 `python -m http.server 5500` 并自动开浏览器，关窗口即停服务器） | 浏览器实测 overflowX=0、mainW=clientWidth；bat 冒烟测试：中文提示正常、页面 200、SW v3 生效 |
| （2026-11-17，未提交） | **恢复真正的手电筒效果**（用户要求；取代上一版"整张牌面 opacity 淡入"）：每张暗牌一个 `div.cheat-card-torch`（`background-image` 牌面，避开 `.hole-cards img:nth-of-type` 的旋转/绝对定位规则），自身 `mask-image: radial-gradient` 以 `--mx/--my` 为圆心挖羽化洞（core `4vmin` / edge `8.5vmin`，`clamp` 兜底），洞外透明露出底层牌背；mousemove 只改这两个变量，800ms 轮询只复用图层、校准几何。**关键防频闪**：`transition` 只保留 `opacity 160ms`（第 8 轮的 `transition: all 0.3s` 会把 mask 变化做成离散过渡 = 频闪+摇摆），且图层不重建（`_cheatTorch` probe 跨越两个轮询周期仍存活）。牌面有 -2°/+3° 倾斜，用 `DOMMatrix` 逆变换把鼠标坐标映射进牌面本地坐标，光斑不漂移。开关文案改「手电筒看牌 / Flashlight peek」 | `deno test js/` 70 绿；in-app Chromium 实测：光斑跟随鼠标、跨两张牌连续、静止 1.9s（跨两个轮询）mask 变量与 opacity 全稳定、移开 400ms 内熄灭、换手后光斑层自动换成新牌面；截图验收（10♦/2♠、6♦ 光斑） |
| （2026-11-17，未提交） | **runout 阶段卡死修复**：转牌结束→河牌前，`queueRunoutPhaseAdvance` 的延迟定时器丢失或 `setPhase()` 抛异常时，会出现「4 张公共牌、无活跃座位、没有河牌」，原看门狗只盯 bot 回合救不了。新增 runout 看门狗：`queueRunoutPhaseAdvance`/恢复 runout 时记录 `{at, phaseIndex, boardCount}`；每 1.5s 检查，6s 后阶段和牌面都没变、无活跃座位/无待执行动作时重新 `setPhase()`（最多 2 次，后台标签页跳过）；`setPhase` 只清自己那次的 marker，避免清掉 `startBettingRound` 为下一街登记的新 marker；全局 `error`/`unhandledrejection` 也写入 `poker.diagnostics`；新增 `poker.activeSeatIndex/flowState/runoutWatchdog` 调试字段 | `deno test js/` 70 绿；浏览器实测：强制丢弃 runout 定时器 → 看门狗自动补发翻牌、后续正常发完河牌并结算，诊断记录 `runout-watchdog`；全局错误探针进入 diagnostics |
| （2026-11-17，未提交） | **重玩卡死 0 筹码界面修复**：`restartTournament` 原先只按 `lastGameSeatConfig` 恢复座位；该配置一旦缺 bot 座位（存档恢复/旧配置/隐藏座位），重开只创建 1 个玩家 → `startGame` 进「人数不足」分支，而该分支不恢复座位、不显示开始按钮，且 `gameStarted` 留在 false，之后点重玩直接 early-return，只能刷新。修复：① 座位配置以 `gameState.allPlayers` 为准（含已出局座位），再用 `lastGameSeatConfig` 补缺；② 人数不足分支恢复完整开局界面（全座位可见、筹码 2000、名字保留、开始按钮显示、重玩隐藏、清底池/公共牌/通知）；③ 重开时同步 `lastGameSeatConfig` | `deno test js/` 70 绿；浏览器实测：只留 1 座位开局 → 自动恢复 6 座/2000/开始可用 → 再点开始正常 6 人局；故意隐藏 5 个座位后点重玩，仍完整恢复 6 人；正常局与存档恢复后重玩均正常 |
| （2026-11-17，未提交） | **bot 卡死兜底 + 快速模式修复**：① `js/bot.js` 顶层 `setBotEquityConfig` 未导入（只有 `?speedmode=1` 会执行到），整个模块导入失败 → 页面所有按钮/暗号失效；补 import。② `processBotQueue` 的 `fn()` 加 try/catch（原先任一 bot 回调异常会让 `processingBotActions` 永久 true，后续 bot 全部不行动，表现就是"某个 bot 高亮但一直不动"）。③ `runBotTurn` 记录活动回合，7s 看门狗用 `botActionTimerDueAt` 区分"定时器还活着 / 已丢"；丢失时 `clearBotActionQueue` 清孤儿动作、补一个合法 check/fold 并继续，`poker.diagnostics` 保留最近 20 条错误上下文（context/player/phase/pot）。④ 外挂面板只允许**本手进行中**换牌（`handInProgress`），堵住两手之间换旧牌把上一手的牌从牌堆"复制"出来 → pokersolver `Duplicate cards` 抛错打断行动链的路径 | `deno test js/` 70 绿；浏览器强制丢弃 3000ms bot 定时器：看门狗 ~7s 内接手（Bot 2 弃牌、pot 30→50、牌局继续），恢复定时器后 30s 正常连打零新诊断；`?speedmode=1` 恢复正常初始化；`node --check` 全过 |
| （2026-11-18，未提交） | **Agent 工具箱升级（数学包 + 服务端审计）**：① `insights` 新增 `preflop` 决策表（Chen 百分位 + 位置/筹码深度范围 + push/fold 模式）；② `draws`（同花/顺子听牌、去重 clean outs、按底池赔率算 breakeven outs、精确枚举 by-river completion，明确区分"完成听牌"与"对对手胜率"）；③ `sizing`（min、1/3、1/2、2/3、满池的 `amount` 与本街总额 `raiseToTotal`，钉死"amount = 新增投入"语义）；④ `equity.vsRangePct` + 每对手 `rangeOpponents`（按公开动作 + VPIP/PFR/AF + 筹码深度动态调范围），`shove.rangeEquityPct` 不再固定 top 20%；⑤ 服务端记录 insights 调用与决策，新增 `GET /games/{id}/report`（coverage、违规跟注 flag、每手盈亏、紧凑决策流水）。全部只用公开信息，未引入任何对手底牌/牌堆读取 | `deno test js/` 70 绿；`python -I server/test_api.py` 全绿（新增 preflop/draws/sizing/vsRange/report 断言，泄漏审计覆盖新 payload）；报告冒烟：coverage 100%、违规 flag 正确、名次/筹码 delta 与实战一致 |
| （2026-11-19，未提交） | **三局 GLM-Agent 实测评估 + 工具修复**：三局 153 个行动轮 insights 覆盖率 100%（153/153）、服务端 violations 0；名次 1/6/6（冠军 +9964，另两局各 -2000）。评估发现并修复：① **P0 Chen 排名按参数顺序取高牌**（`chenComboScore` 用 `cardA` 当底分，导致 ATo 一张顺序 top 45.4、另一顺序 top 24；A9o 甚至 100；64o 32.1 被误判进 push 表）→ 改为按实际高牌取底分；② 翻前范围表是静态 6-max，单挑 SB ATo/A9o 被误判 fold → 增加 HU/少人桌范围与 HU push/fold 阈值；③ `preflop.suggestedAction` 在面对全下时忽略动态 `shove.rangeEquityPct`，曾建议 call 而硬规则是 fold → 改为用 shove 数学统一；④ 板面四同花且手里无该花色时 `outs.clean` 仍算 9 条 flush outs → 改为共享板花 0 出路并返回 `sharedBoardFlushSuit`；⑤ sizing 新增 `cover shortest`，避免再用 `allin` 去罩短码（实测 h64 把 1130 发成 6634 的险情） | `deno test js/` 71 绿；`deno task agent-api:test` 10 绿（新增 order-independence、HU ATo、all-in 建议一致性、共享板花、cover-shortest）；`python -I server/test_api.py` 全绿；修复版 staging exe 已编译并抽样验证（A9o 40.6/ATo 24/J6o 86.1，顺序无关），8899 线上仍是旧 exe |
| （2026-11-19，未提交） | **修复版单局实测（新会话 sess_6939e040）**：84 手亚军，106/106 insights 覆盖率 100%，1 条 violation。h29 AJo 翻前 call 220：`vsRangePct 16.7` 远低于保本 37.3，但 `preflop.suggestedAction=call`（静态查表线），Agent 盲信建议并自辩“查表线允许”，属于工具与 Agent 双向问题。已验证 P0 卡片顺序修复有效：T7o 63.8 / K8s 40.6 / KQs 4.4 / 88 10.4 / SB HU A5o 80% open，旧 ATo/A9o 漂移消失；draws（h52 8 outs、h66 15 outs）与 sizing 使用正常。补修：`facingRaise` / `facing3Bet` 的 `suggestedAction` 也用 `vsRangePct` 与保本线比较，低于 1pp 容差直接改判 fold，并在 rationale 里写出 vsRange；prompt 明确“vsRange 优先于查表线”。测试 11 绿、引擎 71 绿、API 全绿；exe 已重建并重启 | `deno task agent-api:test` 11 绿；`deno test js/` 71 绿；`python -I server/test_api.py` 全绿；单局 report coverage 100%、flagCounts `{call_below_breakeven_equity:1}` |

## 三、实战记录（LLM agent vs 升级后 bot，/GLM-Flash 会话）

- 第一局：第 5 名。96 轮只调 9 次 insights；K6o 跟 5440 全下（随机 equity 57% > 保本 47% 的错觉，对真实范围只有 ~43%）。
- 第二局：第 3 名。每轮调 insights，零裸跟全下，死 zone push/fold 教科书。
- 第三局：第 3 名。85 手；shoveWarning 16 触发 15 弃（摊牌验证全对）；自曝 1 次读牌失误（把 4-5-6-7 四连牌读成顺子——`yourHand` 字段因此诞生）。
- 第四局：**冠军**。第 45 手 A3o 按 `rangeEquityPct 47.9 ≥ 47.7` 跟全下夺冠（战报引用逐字可查）。
- 结论：名次受方差影响大，**过程指标（工具调用率、裸跟全下次数、死 zone 纪律）才是修复有效的可靠证据**。

## 四、日常工作流

```bash
# 引擎/bot 测试
deno test js/

# Agent 工具确定性测试（翻前表/听牌/尺寸/动态范围）
deno task agent-api:test

# API 全套（自起临时服务）
python -I server/test_api.py

# bot 调优基线 vs 候选（仓库铁律：先基线，后改动，指标说话）
deno task engine:batch                    # 启发式基线（快）
deno run --allow-read=. --allow-write=.,/tmp ./scripts/engineBatch.js --bot-equity=on   # equity 开启的候选
deno run ... ./scripts/engineBatch.js --bot-equity=on --equity --equity-limit=250       # 带审计
# 报告在 tmp/poker-engine-batch-*/summary.json，关键段：metrics.actionsByPhase、
# analysis.postflop.mdf.facingBetOverall、tournamentFlow、metrics.postflop.bluffRaiseClassCounts["made-hand"]（硬失败必须为 0）

# agent 实战服务（源码）
deno task agent-api
# 部署版 exe（E:\Texas Player\agent-poker-api.exe，改代码后要重编）
deno task agent-api:build

# 人类版联机中转（本地）
deno task sync                 # http://127.0.0.1:8787
python -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/?sync=http://127.0.0.1:8787
deno task sync:test            # 投影/token/action/CORS 测试
```

人类单挑开局：`POST /games {"agentName":"...","botCount":0,"humanSeat":true,"humanName":"...","startingChips":2000}`，返回的 `humanSeatToken` 拼进 `/watch?game=…&token=…` 就是带操作条的席位页。

## 五、已知坑（血泪清单）

- **Windows**：Git Bash 的 `kill` 杀不掉 `./exe &` 的 Windows 子进程 → 用 `netstat -ano | grep :PORT` 拿 PID 再 `taskkill //PID x //F`，否则旧进程锁住 exe 导致 `agent-api:build` 报"拒绝访问"。
- **GBK 控制台**：不要在 API 文本里放 emoji（⚠️ 曾让 agent 的 GBK 脚本当场崩掉，已换 `[WARN]`）；自己的 python 脚本记得 `PYTHONIOENCODING=utf-8`。
- **Python 不认 `/tmp`**（Git Bash 认）——写临时文件用 `%TEMP%` 或仓库 `tmp/`（已 gitignore）。
- **API 字段名是 `botCount`**（exampleAgent.py 里 `bots` 只是客户端参数名）——直接 curl 时传 `bots` 会被静默忽略、回落默认 5。
- **盲注表**：每 6 手升一级，10/20 → 20/40 → 30/60 → …（不是翻倍，是 +10/+20）。
- **数 agent 的 insights 调用**：URL grep 会低估（轮询脚本动态构造 URL，字面量只出现一次）。看会话战报里逐手的 equity 引用更可靠。
- **Deno worker 是同步阻塞模型**：远程席位等待期间整个 worker 停住，一次只有一个玩家行动——SAB 协议依赖这一点，别改成并发。
- **本地改完 CSS/JS 刷新看不到效果 = Service Worker 缓存**：SW 版本号只在"发布提交"时 bump，开发迭代时用 `navigator.serviceWorker.getRegistrations()` 全部 unregister + `caches.keys()` 全删再刷新。测试面板网格布局时踩过三次。
- **grid 里放 SVG 卡图会被固有宽度撑爆**：`repeat(13, 1fr)` 的列在 flex/grid 嵌套下不收缩，按钮要显式 `width:100%` + `minmax(0,1fr)` + 容器 `overflow-x:hidden`（cheat 面板踩过，别再踩）。

## 六、git / 许可证

- `origin` = `github.com/pphun811-maker/poker`（用户自己的私有仓库，日常 push 这里）
- `upstream` = `github.com/Tehes/poker`（原作者 Tino Sabetta，用来同步上游更新）
- **Source-Available License v1.0**：私有仓库+个人用途合规；若转公开必须显著署名 + 链接原仓库 + 应用内 "Based on Poker by Tehes" + 声明为修改版非官方，且禁止商用。

## 七、下一步建议（按优先级）

1. **多局样本**：连打 5–10 局人类/agent 实战再评名次（当前样本仍偏少，方差大）；现在有 `/report`，优先看 coverage、违规 flag 和每手 delta，不要只看名次。
2. **Agent 工具第二批**：`recentHands`（最近 8 手摘要）、锦标赛上下文（`playersLeft` / `heroRank` / `avgStackBB` / `nextBlinds`）、`GET /state?insights=1` 合并轮询、Python SDK / MCP wrapper。数学包与审计已于 2026-11-18 落地。
3. **bot 侧下一档**：对手范围建模（equity 对真实范围而非均匀随机）——`estimateRangeEquity` 的每对手范围采样骨架可以直接复用。
4. **评测管线固化**：把 `E:\Texas Player\poker-lessons-*.md`、`/report` 的 flags 与 engine:batch 指标串成自动对比报告。
5. **bot.js 头部策略注释**记得随新机制同步（equity blend 已写进去；以后加机制照做）。
