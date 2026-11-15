# 项目交接（给之后维护本项目的 agent）

> 2026-11-16 由 ZCode 会话写入。当前项目状态：原版 Tehe's Poker 单机网页游戏 + `server/` 无头 agent API + 人类席位。本文是**增量交接**——原项目的架构说明在 `AGENTS.md` 和 `README.md`，引擎规则在 `js/gameEngine.js` 的模块头注释，本文只讲"后来发生了什么"和"怎么继续"。

## 一、红线（改代码前先背下来）

1. **bot 决策只能用公开信息**：绝不读 `gameState.deck`、弃牌堆、对手真实底牌。`server/agentWorker.js` 的白名单 sanitizer 保证状态投影无泄牌；`scopeStateForToken` 保证人类局按 token 裁剪底牌。任何改动都要保住这条，测试里 `audit_no_card_leaks` 是守门员。
2. **insights 的 equity 只用公开数学**：`js/botEquity.js` 从「52 张 − 自己底牌 − 公共牌」采样假设手牌。**不要**改用引擎的真实牌堆采样——`gameState.deck` 排除了对手的实际手牌，用它等于间接泄牌（用户明确红线：连"采样对手手牌"这种表述都容易误导，实现上必须是纯公开信息推导）。
3. **牌面格式是大写花色**（`"KC"`、`"2S"`，见 `INITIAL_DECK`）。混入小写会让采样池出现"幽灵重复牌"（pokersolver 视为不同牌），历史教训见 `js/botEquity.test.js` 的校准测试。
4. **身份永远来自 seatIndex，绝不从数组顺序猜**。引擎每手轮转 players 数组顺序，且 agent 出局后会被移出数组——`server/insights.js` 里那个 `(state.players ?? [])[0]` 回退曾把任意座位当成 agent（commit d08c977 修掉）。
5. **agent 实战红线**见 `server/AGENT_PROMPT.md`：每轮必调 insights、面对全下用 `shove.rangeEquityPct ≥ callBreakevenEquityPct + 5` 判断（随机 equity 会高估对真实全下范围的胜率——第一局 K6o 跟 5440 全下输掉锦标赛的教训）。

## 二、今日里程碑（全部有提交与验证记录）

| 提交 | 内容 | 验证 |
|---|---|---|
| `386b3df` | bot equity blend：postflop 决策闸门 = 0.6×真实蒙特卡洛 equity + 0.4×原手牌分类强度（`js/botEquity.js` + `EQUITY_BLEND_WEIGHT` in `js/bot.js`） | 100 局候选 + 双向 equity 审计 + 500 局确认：面对下注弃牌率 44.7%→28.7%（要求 31.9%），硬失败 0，冠军分布更均匀 |
| `e3ad5c9` | `server/` 无头 agent API（HTTP 长轮询、无出牌倒计时、防泄牌投影、insights 端点、人类席位前身） | `python -I server/test_api.py` 全绿 |
| `783f886` | shoveWarning（全下/大额跟注警告）+ prompt 硬化（每轮必调 insights） | 第一局实战暴露的问题：LLM 96 轮只查 9 次、K6o 裸跟全下 |
| `8659e8d` | 观战页人类操作条修复（提交成功后按钮永久禁用的 bug） | 实战单挑发现 |
| `44c56c3` | `shove.rangeEquityPct`（对 Chen 排名顶部 20% 范围的真实 equity）+ `equity.yourHand`（引擎成牌名） | 校准：K6o 对随机 0.55 / 对范围 0.43；AA 0.86/0.81 |
| `d08c977` | 出局后 agent 身份窃取修复（见红线 4） | 探针抓现行 + 5 连跑全绿 |
| `f8eded0` | **人类席位**：`POST /games {"humanSeat": true, "botCount": 0}` = agent vs 人类 heads-up；watch 页操作条（弃/过/跟/加注滑条）；token 底牌裁剪；/insights 按调用者视角 | 双席对打测试 + 越权 409 + 双视角泄牌审计 |

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

## 六、git / 许可证

- `origin` = `github.com/pphun811-maker/poker`（用户自己的私有仓库，日常 push 这里）
- `upstream` = `github.com/Tehes/poker`（原作者 Tino Sabetta，用来同步上游更新）
- **Source-Available License v1.0**：私有仓库+个人用途合规；若转公开必须显著署名 + 链接原仓库 + 应用内 "Based on Poker by Tehes" + 声明为修改版非官方，且禁止商用。

## 七、下一步建议（按优先级）

1. **多局样本**：连打 5–10 局人类/agent 实战再评名次（当前 4 局，方差大）。
2. **insights 对手范围个性化**：reads（VPIP/PFR/AF）已有，把 `shove.rangeEquityPct` 的"顶部 20%"换成按该对手实测倾向动态调整的范围宽度。
3. **bot 侧下一档**：对手范围建模（equity 对真实范围而非均匀随机）——`estimateRangeEquity` 的采样骨架可以直接复用。
4. **评测管线固化**：把 agent 战报（`E:\Texas Player\poker-lessons-*.md`）与 engine:batch 指标串成自动对比报告。
5. **bot.js 头部策略注释**记得随新机制同步（equity blend 已写进去；以后加机制照做）。
