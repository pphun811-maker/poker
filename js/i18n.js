/* ==================================================================================================
MODULE BOUNDARY: UI Localization
================================================================================================== */

// CURRENT STATE: Single source for every user-facing UI string in Chinese and English, plus the
// language switch (persisted in localStorage) that static HTML (data-i18n) and dynamic code (t/tf)
// both consume.
// TARGET STATE: Stay the only place where UI copy lives; feature modules may register their own
// namespaces via registerStrings but must not hardcode user-visible text elsewhere.
// PUT HERE: String dictionaries, language state, translation helpers, static-HTML application.
// DO NOT PUT HERE: Game logic, rendering, or DOM access beyond the guarded localStorage read and
// the explicit document.title/placeholder application driven by data attributes.

const STORAGE_KEY = "poker:lang";
const SUPPORTED_LANGS = ["zh", "en"];

const dictionaries = {
	zh: {},
	en: {},
};

const langChangeListeners = [];
let currentLang = "zh";

function normalizeLang(value) {
	return SUPPORTED_LANGS.includes(value) ? value : "zh";
}

function readStoredLang() {
	try {
		return normalizeLang(globalThis.localStorage?.getItem(STORAGE_KEY));
	} catch {
		return "zh";
	}
}

currentLang = readStoredLang();

export function getLang() {
	return currentLang;
}

export function t(key) {
	return dictionaries[currentLang][key] ?? dictionaries.zh[key] ?? key;
}

export function tf(key, params = {}) {
	let text = t(key);
	for (const [name, value] of Object.entries(params)) {
		text = text.replaceAll(`{${name}}`, String(value));
	}
	return text;
}

export function registerStrings(namespace, strings) {
	for (const [key, langs] of Object.entries(strings)) {
		for (const lang of SUPPORTED_LANGS) {
			if (langs[lang] !== undefined) {
				dictionaries[lang][`${namespace}.${key}`] = langs[lang];
			}
		}
	}
}

export function setLang(lang) {
	currentLang = normalizeLang(lang);
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, currentLang);
	} catch {
		// Storage unavailable (private mode etc.): language just resets next load.
	}
	applyStaticTranslations();
	langChangeListeners.forEach((listener) => listener(currentLang));
}

export function onLangChange(listener) {
	langChangeListeners.push(listener);
}

// Applies translations to static markup: data-i18n sets textContent, data-i18n-placeholder
// writes the data-placeholder attribute consumed by the seat name CSS, data-i18n-title sets title.
export function applyStaticTranslations(root = document) {
	root.querySelectorAll("[data-i18n]").forEach((el) => {
		el.textContent = t(el.dataset.i18n);
	});
	root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
		el.dataset.placeholder = t(el.dataset.i18nPlaceholder);
	});
	root.querySelectorAll("[data-i18n-title]").forEach((el) => {
		el.title = t(el.dataset.i18nTitle);
	});
	document.title = t("meta.title");
}

registerStrings("meta", {
	title: { zh: "德州扑克", en: "Poker" },
});

registerStrings("ui", {
	enterName: { zh: "输入名字", en: "Enter Name" },
	close: { zh: "关闭", en: "Close" },
	thinking: { zh: "思考中…", en: "thinking …" },
	langToEn: { zh: "EN", en: "EN" },
	langToZh: { zh: "中文", en: "中文" },
	joinByLink: { zh: "链接入座", en: "join via Link" },
	openRemoteTable: { zh: "打开远程牌桌", en: "Open remote table" },
	frameBlockedAlert: {
		zh: "禁止内嵌框架访问。请访问：https://tehes.github.io/poker/",
		en: "No framing allowed. Please visit: https://tehes.github.io/poker/",
	},
	frameBlockedError: {
		zh: "禁止内嵌框架访问。请打开原站：https://tehes.github.io/poker/",
		en: "No framing allowed. Open the original: https://tehes.github.io/poker/",
	},
});

registerStrings("footer", {
	unofficial: { zh: "非官方修改版", en: "Unofficial modified version" },
});

registerStrings("button", {
	start: { zh: "开始", en: "Start" },
	newRound: { zh: "下一手", en: "New Round" },
	replay: { zh: "重玩", en: "Replay" },
	instructions: { zh: "玩法说明", en: "Instructions" },
	invite: { zh: "邀请", en: "Invite" },
	stats: { zh: "统计", en: "Stats" },
	profile: { zh: "生涯", en: "Career" },
	log: { zh: "记录", en: "Log" },
	fastForward: { zh: "快进", en: "Fast Forward" },
	version: { zh: "版本", en: "Version" },
	applyCards: { zh: "应用手牌", en: "Apply Cards" },
	continueGame: { zh: "继续牌局", en: "Continue Game" },
	newGame: { zh: "开新局", en: "New Game" },
});

registerStrings("action", {
	fold: { zh: "弃牌", en: "Fold" },
	check: { zh: "过牌", en: "Check" },
	call: { zh: "跟注", en: "Call" },
	raise: { zh: "加注", en: "Raise" },
	allin: { zh: "全下", en: "All-In" },
});

registerStrings("notify", {
	hint: {
		zh: "在座位名牌上输入玩家名，留空的座位自动补机器人，然后点「开始」。",
		en: "Enter player names \u2013 leave fields empty to add bots \u2013 then click \u201CStart\u201D.",
	},
	notEnoughPlayers: {
		zh: "玩家数量不足，至少需要两个座位",
		en: "Not enough players",
	},
	replayReady: {
		zh: "牌局已重置，点「开始」发牌。",
		en: "Table reset. Click \u201CStart\u201D to deal a new game.",
	},
	blindsAreNow: {
		zh: "盲注升级为 {sb}/{bb}。",
		en: "Blinds are now {sb}/{bb}.",
	},
	postSmallBlind: {
		zh: "{name} 下小盲注 {amount}。",
		en: "{name} posted small blind of {amount}.",
	},
	postBigBlind: {
		zh: "{name} 下大盲注 {amount}。",
		en: "{name} posted big blind of {amount}.",
	},
	isDealer: { zh: "{name} 是庄家。", en: "{name} is Dealer." },
	outOfGame: { zh: "{name} 出局了！", en: "{name} is out of the game!" },
	champion: { zh: "{name} 赢得整场比赛！🏆", en: "{name} wins the game! 🏆" },
	flop: { zh: "翻牌（3 张）已发出。", en: "Flop (3 cards) dealt." },
	turn: { zh: "转牌（第 4 张）已发出。", en: "Turn (4th card) dealt." },
	river: { zh: "河牌（第 5 张）已发出。", en: "River (5th card) dealt." },
	actionFold: { zh: "{name} 弃牌。", en: "{name} folded." },
	actionCheck: { zh: "{name} 过牌。", en: "{name} checked." },
	actionCall: { zh: "{name} 跟注 {amount}。", en: "{name} called {amount}." },
	actionRaise: { zh: "{name} 加注到 {amount}。", en: "{name} raised to {amount}." },
	actionAllin: { zh: "{name} 全下。", en: "{name} is all-in." },
	actionOther: { zh: "{name} 完成了行动。", en: "{name} did something." },
	reveals: { zh: "{name} 亮牌 {cards}", en: "{name} reveals {cards}" },
	wins: { zh: "{name} 赢得 {amount}", en: "{name} wins {amount}" },
	winsWith: {
		zh: "{name} 赢得 {amount}（{hand}）",
		en: "{name} wins {amount} with {hand}",
	},
	winsPot: { zh: "{name} 赢得 {amount}！", en: "{name} wins {amount}!" },
	split: { zh: "{names} 平分 {amount}", en: "{names} split {amount}" },
});

registerStrings("hand", {
	royalFlush: { zh: "皇家同花顺", en: "Royal flush" },
	straightFlush: { zh: "同花顺", en: "Straight flush" },
	fourOfAKind: { zh: "四条", en: "4 of a kind" },
	fullHouse: { zh: "葫芦", en: "Full house" },
	flush: { zh: "同花", en: "Flush" },
	straight: { zh: "顺子", en: "Straight" },
	threeOfAKind: { zh: "三条", en: "3 of a kind" },
	twoPair: { zh: "两对", en: "2 Pair" },
	pair: { zh: "一对", en: "Pair" },
	highCard: { zh: "高牌", en: "High card" },
});

// Full pokersolver hand names as they appear in winner notifications (en mirrors the solver wording)
registerStrings("handName", {
	"Royal Flush": { zh: "皇家同花顺", en: "Royal Flush" },
	"Straight Flush": { zh: "同花顺", en: "Straight Flush" },
	"Four of a Kind": { zh: "四条", en: "Four of a Kind" },
	"Full House": { zh: "葫芦", en: "Full House" },
	"Flush": { zh: "同花", en: "Flush" },
	"Straight": { zh: "顺子", en: "Straight" },
	"Three of a Kind": { zh: "三条", en: "Three of a Kind" },
	"Two Pair": { zh: "两对", en: "Two Pair" },
	"Pair": { zh: "一对", en: "Pair" },
	"High Card": { zh: "高牌", en: "High card" },
});

registerStrings("stats", {
	player: { zh: "玩家", en: "Player" },
	stack: { zh: "筹码", en: "Stack" },
	hands: { zh: "手数", en: "Hands" },
	won: { zh: "胜场", en: "Won" },
	winRate: { zh: "胜率", en: "Win %" },
	showdowns: { zh: "摊牌", en: "Showdowns" },
	sdWon: { zh: "摊牌胜", en: "SD Won" },
	sdRate: { zh: "摊牌率", en: "SD %" },
	folds: { zh: "弃牌", en: "Folds" },
	pre: { zh: "翻前", en: "Pre" },
	post: { zh: "翻后", en: "Post" },
	allins: { zh: "全下", en: "All-ins" },
});

registerStrings("resume", {
	title: { zh: "继续上次的牌局？", en: "Continue saved game?" },
	body: {
		zh: "本机找到了一局未完成的牌局，可以接着打，也可以开一局新的。",
		en: "A saved poker game was found on this device. Continue it or start a fresh game.",
	},
});

registerStrings("profile", {
	title: { zh: "我的生涯", en: "My Career" },
	subtitle: {
		zh: "本机完成的单人对机器人整场对局。",
		en: "Completed Solo vs Bots tournaments on this device.",
	},
	historyHeading: { zh: "近期名次", en: "Recent placements" },
	historyHint: {
		zh: "从旧到新，显示 名次 / 人数",
		en: "Oldest to latest, placement / players",
	},
	historyAxisFirst: { zh: "冠军", en: "First" },
	historyAxisLast: { zh: "末位", en: "Last" },
	helpHeading: { zh: "这些统计是什么意思", en: "What these stats mean" },
	historyTitle: {
		zh: "{date}，第 {placement} 名 / 共 {participantCount} 人",
		en: "{date}, place {placement} of {participantCount}",
	},
	note: {
		zh: "这些百分比描述你的打法，数值高不代表打得更好。「—」表示该值无法计算。",
		en: "Percentages describe your play; higher does not automatically mean better. \u201C—\u201D means the value cannot be calculated.",
	},
	"period.latest": { zh: "最近", en: "Latest" },
	"period.last10": { zh: "近10场", en: "L10" },
	"period.overall": { zh: "总计", en: "Overall" },
	"period.games": { zh: "{count} 场", en: "{count} games" },
	"group.results": { zh: "对局结果", en: "Tournament results" },
	"group.preflop": { zh: "翻前", en: "Preflop" },
	"group.postflop": { zh: "翻后", en: "Postflop" },
	"metric.tournaments": { zh: "对局数", en: "Tournaments" },
	"metric.winRate": { zh: "夺冠率", en: "Win rate" },
	"metric.placement": { zh: "名次", en: "Placement" },
	"metric.handsPerGame": { zh: "场均手数", en: "Hands per game" },
	"metric.handsWon": { zh: "胜场手数", en: "Hands won" },
	"metric.nonShowdownWins": { zh: "非摊牌胜", en: "Non-showdown wins" },
	"metric.vpip": { zh: "VPIP", en: "VPIP" },
	"metric.pfr": { zh: "PFR", en: "PFR" },
	"metric.vpipPfrGap": { zh: "VPIP−PFR 差值", en: "VPIP\u2013PFR gap" },
	"metric.preflopFold": { zh: "翻前弃牌", en: "Preflop fold" },
	"metric.flopSeen": { zh: "看翻牌率", en: "Flop seen" },
	"metric.aggressionFactor": { zh: "激进度", en: "Aggression factor" },
	"metric.wtsd": { zh: "摊牌率 (WTSD)", en: "WTSD" },
	"metric.wsd": { zh: "摊牌胜率 (W$SD)", en: "W$SD" },
	"metric.wwsf": { zh: "看翻后赢率 (WWSF)", en: "WWSF" },
	"metric.postflopFold": { zh: "翻后弃牌", en: "Postflop fold" },
	"metric.allin": { zh: "全下率", en: "All-in" },
	"help.tournaments": {
		zh: "已完成的整场对局。中途离开未结束的对局不计入。",
		en: "Completed tournaments. Leaving an unfinished game does not add a result.",
	},
	"help.winRate": {
		zh: "你夺冠的对局占比。",
		en: "Percentage of tournaments you won.",
	},
	"help.placement": {
		zh: "「最近」显示实际名次，「近10场」和「总计」显示按 6 人桌折算的平均名次。",
		en: "Latest shows your actual finish. L10 and Overall average finishes after scaling them to six players.",
	},
	"help.handsPerGame": {
		zh: "每场对局平均发到你手里的手数，直到你出局或夺冠。「最近」显示该场的手数。",
		en: "Average hands dealt to you per completed tournament, until you were eliminated or won. Latest shows that tournament's hands.",
	},
	"help.handsWon": {
		zh: "你赢下底池的手数。平分底池计为一手；未被跟注的退回不算赢。",
		en: "Hands in which you won a pot. Split pots count as one won hand; returned, uncalled chips do not count as a win.",
	},
	"help.nonShowdownWins": {
		zh: "你赢下的手数中，没有走到摊牌就结束的比例。",
		en: "Percentage of hands you won that ended without a showdown.",
	},
	"help.vpip": {
		zh: "翻前主动跟注或加注进锅的手数占比。盲注不算主动进锅。",
		en: "Hands in which you voluntarily called or raised preflop. Posting blinds does not count.",
	},
	"help.pfr": {
		zh: "翻前至少加注过一次的手数占比。",
		en: "Hands in which you raised preflop at least once.",
	},
	"help.vpipPfrGap": {
		zh: "VPIP 减 PFR，单位是百分点 (pp)，描述你翻前只跟不加的频率。",
		en: "VPIP minus PFR, in percentage points (pp). This describes how often you entered preflop without raising.",
	},
	"help.preflopFold": {
		zh: "翻牌前就弃牌的手数占比。",
		en: "Hands in which you folded before the flop.",
	},
	"help.flopSeen": {
		zh: "没有翻前弃牌、看到翻牌的手数占比，包括全下跑马和大盲免费看牌。",
		en: "Hands in which you reached the flop without folding, including all-in runouts and free flops in the big blind.",
	},
	"help.aggressionFactor": {
		zh: "翻后下注加注次数除以跟注次数。全下跟注计入跟注。没有跟注时无法计算。",
		en: "Postflop bets and raises divided by calls. All-in calls count as calls. With no calls, there is no finite factor to display.",
	},
	"help.wtsd": {
		zh: "看过翻牌的手数中走到摊牌的比例。",
		en: "Went to showdown: how often you reached a showdown after seeing the flop.",
	},
	"help.wsd": {
		zh: "走到摊牌的手数中赢下底池的比例。平分底池计为一次赢。",
		en: "Won at showdown: how often you won a pot when reaching showdown. Split-pot wins count once.",
	},
	"help.wwsf": {
		zh: "看过翻牌的手数中赢下底池的比例，含摊牌与非摊牌。",
		en: "Won when saw flop: how often you won a pot after seeing the flop, with or without a showdown.",
	},
	"help.postflopFold": {
		zh: "翻牌后弃牌的手数占比。",
		en: "Hands in which you folded after the flop.",
	},
	"help.allin": {
		zh: "通过跟注或加注全下的手数占比。盲注被强制全下不计入。",
		en: "Hands in which you went all-in by calling or raising. Forced blind all-ins are excluded.",
	},
});

registerStrings("version", {
	history: { zh: "版本历史", en: "Version History" },
});

registerStrings("instructions", {
	title: { zh: "牌桌玩法说明", en: "How this table works" },
	intro: {
		zh: "点击「开始」后，会根据入座的人类玩家数量自动选择游玩模式。",
		en: "The play mode is chosen automatically when you press \u201CStart\u201D, depending on how many human players are seated.",
	},
	setupTitle: { zh: "选择布局", en: "Choose your setup" },
	groupTitle: { zh: "多人同屏（2 人及以上）", en: "Group Play (2+ humans)" },
	groupP1: {
		zh: "每位人类玩家输入名字。发牌后，每个人类座位会显示二维码（私密查看自己的底牌）以及远程牌桌的直达链接。",
		en: "Each human enters a name. After the hand starts, every human seat shows a QR code for the private hole-card view and a direct link to the remote table view.",
	},
	groupP2: {
		zh: "行动可以直接在共享牌桌上进行，轮到对应座位时也可以在扫码的设备上操作。",
		en: "Actions can still happen on the shared table, or from the linked device when that seat is active.",
	},
	groupNote: {
		zh: "留空的座位会自动由机器人补位，人类与机器人混桌无需任何额外设置。",
		en: "Empty seats are automatically filled by bots, so mixed human/bot tables work without any setup.",
	},
	soloTitle: { zh: "单人对机器人（1 人）", en: "Solo vs Bots (1 human)" },
	soloP1: {
		zh: "唯一的人类玩家直接在本机操作，无需扫码，该玩家的底牌会一直亮在牌桌上。",
		en: "One human plays directly on the main device. No QR scan is required and that player\u2019s hole cards remain visible on the table.",
	},
	spectatorTitle: { zh: "观战模式（0 人）", en: "Spectator / TV Poker (0 humans)" },
	spectatorP1: {
		zh: "全部座位由机器人补位，牌局自动进行，所有底牌保持亮明。",
		en: "All seats are filled by bots. The table runs automatically and all hole cards remain visible.",
	},
	beforeTitle: { zh: "开始之前", en: "Before you start" },
	before1: { zh: "在座位名牌上输入玩家名。", en: "Enter player names in the name badges." },
	before2: { zh: "想让机器人入座就留空名字。", en: "Leave a seat empty if you want it filled by a bot." },
	before3: { zh: "用关闭图标移除不需要的座位。", en: "Use the close icon to remove seats you do not need." },
	before4: {
		zh: "用旋转图标把座位朝向对应的玩家，平板上尤其有用。",
		en: "Use the rotate icon to orient a seat toward the player sitting there. This is especially useful on tablets.",
	},
	before5: {
		zh: "至少需要 2 个有效座位才能开局。",
		en: "You need at least 2 active seats before the game can start.",
	},
	duringTitle: { zh: "一手牌进行中", en: "During a hand" },
	during1: {
		zh: "庄位与盲注自动分配，盲注级别会随时间上涨。",
		en: "Dealer and blinds are assigned automatically, and the blind level increases over time.",
	},
	during2: {
		zh: "操作遵循标准德州扑克术语：弃牌、过牌、跟注、加注、全下。",
		en: "The table uses standard poker action labels: Fold, Check, Call, Raise, All-in.",
	},
	during3: {
		zh: "滑杆说明：拉到 0 等于过牌，等于当前下注额是跟注，再往上为加注，拉满为全下。",
		en: "Slider guide: 0 = Check, matching the current bet = Call, above that = Raise, maximum = All-in.",
	},
	during4: {
		zh: "加注额太小时滑杆会变红，松手后自动回到最小合法加注额。",
		en: "Raises that are too small turn red while dragging and snap to the minimum legal raise when released.",
	},
	readTitle: { zh: "怎么看牌桌", en: "Read the table" },
	read1: {
		zh: "底池显示在中央，公共牌在中间，每个座位显示筹码量和本轮下注。",
		en: "The pot is shown in the center. Community cards are in the middle, and each seat displays its stack and current round bet.",
	},
	read2: {
		zh: "庄家、小盲、大盲图标标出当前位置。",
		en: "Dealer, small blind, and big blind icons indicate the current positions.",
	},
	read3: {
		zh: "点击通知栏可以打开牌局记录。",
		en: "The notification bar is clickable and opens the hand log.",
	},
	read4: {
		zh: "完成一手后即可使用统计和记录功能。",
		en: "Stats and Log become available after completed hands.",
	},
	read5: {
		zh: "只有当底牌在共享牌桌上亮明时（观战模式或全下跑马），才会显示胜率与牌型标签。",
		en: "Win percentages and short hand labels only appear when hole cards are visible on the shared table, such as in spectator mode or during all-in runouts.",
	},
});

registerStrings("cheat", {
	title: { zh: "外挂面板", en: "Cheat Panel" },
	peek: { zh: "偷看牌", en: "Peek" },
	change: { zh: "更换手牌", en: "Change Hole Cards" },
	seat: { zh: "座位", en: "Seat" },
	current: { zh: "当前", en: "Current" },
	boardCards: {
		zh: "公共牌（牌堆剩 {count} 张）",
		en: "Board (deck: {count})",
	},
	human: { zh: "人类", en: "human" },
	bot: { zh: "机器人", en: "bot" },
	out: { zh: "出局", en: "out" },
	folded: { zh: "弃牌", en: "folded" },
	allin: { zh: "全下", en: "all-in" },
	noCards: { zh: "尚未发牌", en: "no cards yet" },
	startFirst: { zh: "请先开始一局。", en: "Start a game first." },
	cardBack: { zh: "牌背", en: "hidden card" },
	noSeat: { zh: "找不到该座位。", en: "Seat not found." },
	noHoleCards: { zh: "该座位还没有手牌。", en: "That seat has no hole cards yet." },
	alreadyFolded: { zh: "该座位已经弃牌。", en: "That seat has already folded." },
	pickTwo: { zh: "需要恰好选两张牌。", en: "Pick exactly two cards." },
	pickDifferent: { zh: "两张牌不能相同。", en: "Pick two different cards." },
	unknownCard: { zh: "不认识的牌：{code}。", en: "Unknown card: {code}." },
	onTable: { zh: "{code} 已经在牌桌上。", en: "{code} is already on the table." },
	notInDeck: { zh: "{code} 不在牌堆里。", en: "{code} is not in the deck." },
	notInHand: { zh: "{code} 不在那张座位的手牌里。", en: "{code} is not in that seat’s hand." },
	handNotInProgress: {
		zh: "只能在本手牌进行中换牌。",
		en: "Cards can only be changed while a hand is in progress.",
	},
	swapped: { zh: "已将 {old} 换成 {new}。", en: "Swapped {old} for {new}." },
	set: { zh: "手牌已换为 {cards}。", en: "Cards set to {cards}." },
});

registerStrings("sync", {
	waiting: { zh: "等待牌桌更新…", en: "Waiting for updates…" },
	loading: { zh: "正在载入牌桌…", en: "Loading table…" },
	connectionLost: { zh: "与联机服务器断开，正在重试…", en: "Connection lost, retrying…" },
	tableUnavailable: { zh: "牌桌不可用。", en: "Table unavailable." },
	seatUnavailable: { zh: "该座位暂不可用。", en: "Seat unavailable." },
	missingLink: { zh: "入座链接不完整或已失效。", en: "This seat link is incomplete or no longer valid." },
	actionFailed: { zh: "操作发送失败，请重试。", en: "Action failed, please try again." },
	notConfigured: {
		zh: "联机服务未配置，远程入座不可用。",
		en: "Online sync is not configured, so remote seats are unavailable.",
	},
});

registerStrings("invite", {
	title: { zh: "邀请", en: "Invite players" },
	pendingHint: {
		zh: "把每个座位的链接私发给对应的人。他们可以先打开链接等着，你点「开始」后就会看到自己的牌。",
		en: "Send each seat link privately to the matching player. They can open it and wait; their cards appear when you start the hand.",
	},
	liveHint: {
		zh: "牌局进行中。把对应座位的链接私发给该玩家，打开即可入座。",
		en: "The game is running. Send each seat link privately; opening it seats that player.",
	},
	keepSeats: {
		zh: "邀请后不要再改座位顺序或名字，否则链接会对错人。",
		en: "Do not reorder seats or rename players after inviting, or links will point at the wrong seat.",
	},
	needTwoPlayers: {
		zh: "先给至少两个座位填上名字，再邀请。留空的座位会自动变机器人。",
		en: "Type at least two player names first. Empty seats become bots.",
	},
	noRelay: {
		zh: "联机中转未配置，暂时不能生成入座链接。",
		en: "The online relay is not configured, so seat links are unavailable.",
	},
	seatLabel: { zh: "座位 {seat}", en: "Seat {seat}" },
	copy: { zh: "复制链接", en: "Copy link" },
	copied: { zh: "已复制", en: "Copied" },
	open: { zh: "打开", en: "Open" },
	waitingForHost: { zh: "等待房主开局…", en: "Waiting for the host to start…" },
});
