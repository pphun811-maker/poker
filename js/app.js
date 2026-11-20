/* ==================================================================================================
MODULE BOUNDARY: Main Table Runtime
================================================================================================== */

// CURRENT STATE: Coordinates browser-facing game flow, bots, sync, local persistence, timers,
// analytics, and DOM effects. Showdown resolution/commit state, hand-end/next-hand transition
// state, browserless hand/tournament runners, hand-start setup, turn-action resolution,
// betting-round start state, betting-round progress decisions, and street progression decisions
// are extracted; browser orchestration remains here.
// TARGET STATE: app.js should stay as the browser-facing orchestrator only. Pure poker rules and
// state transforms should live in gameEngine.js, while reusable UI, sync, and control primitives
// should live in shared/*.
// PUT HERE: Engine orchestration, notifications, timers, sync, local save/restore, analytics, bot
// playback, and flow-specific DOM wiring.
// DO NOT PUT HERE: Pure poker rules, reusable action math, sync schema helpers, or generic
// render-only helpers.
// PREFERENCE: Extend the existing modules before introducing new ones.

/* --------------------------------------------------------------------------------------------------
Imports
---------------------------------------------------------------------------------------------------*/

import {
	chooseBotAction,
	clearBotActionQueue,
	enqueueBotAction,
	isBotActionPending,
	normalizeBotActionRequest,
	setBotActionErrorHandler,
	setBotPlaybackFast,
} from "./bot.js";
import {
	advanceDealer,
	calculateWinProbabilities,
	createBettingRoundProgressState,
	createBettingRoundStartPlan,
	createHandContextState,
	createHandEndPlan,
	createNextHandTransitionPlan,
	createPlayerSpotState,
	createShowdownCommitPlan,
	dealCommunityCardsForPhase,
	dealHoleCardsForNewHand,
	getBettingRoundStartExit,
	getBlindLevelUpdateForHand,
	getBotRevealDecision,
	getCurrentPhase,
	getNextBettingRoundStep,
	getNextPhasePlan,
	getPlayerActionFollowUpEffects,
	getPlayerTournamentPlacement,
	getResolvedTurnContinuation,
	getVisibleSolvedHand,
	INITIAL_BIG_BLIND,
	INITIAL_DECK,
	INITIAL_SMALL_BLIND,
	isAllInRunout,
	postBlinds,
	recordPlayerActionStats,
	resolveShowdown,
	resolveTurnAction,
} from "./gameEngine.js";
import { createEmptyPlayerProfile, readPlayerProfile, savePlayerProfileResult } from "./playerProfile.js";
import { renderPlayerProfile } from "./shared/playerProfileView.js";
import QrCreator from "./qr-creator.js";
import { getActionButtonLabel, getPlayerActionState } from "./shared/actionModel.js";
import { createHumanTurnController } from "./shared/humanTurnController.js";
import { applyStaticTranslations, getLang, onLangChange, setLang, t, tf } from "./i18n.js";
import { buildPublicPlayerView, buildSyncView } from "./shared/syncViewModel.js";
import {
	clearChipTransferAnimation,
	clearRenderedSeat,
	clearSeatActionLabel,
	clearSeatActionVisualState,
	renderChipStacks,
	renderChipTransferAnimation,
	renderCommunityCards as renderTableCommunityCards,
	renderHostSeat,
	renderNotificationBar,
	renderSeatActiveState,
	renderSeatActiveStates,
	renderSeatResolvedAction,
	renderSeatRotation,
	renderSeatSetupState,
} from "./shared/tableViewRenderer.js";
import { initServiceWorker } from "./serviceWorkerRegistration.js";
import { initCheatPanel, refreshCheatPanel } from "./cheatPanel.js";
import { APP_VERSION, VERSION_LOG } from "./version.js";

/* --------------------------------------------------------------------------------------------------
Configuration And DOM References
---------------------------------------------------------------------------------------------------*/

const startButton = document.querySelector("#start-button");
const startButtonLabel = document.querySelector("#start-button-label");
const replayButton = document.querySelector("#replay-button");
const instructionsButton = document.querySelector("#instructions-button");
const rotateIcons = document.querySelectorAll(".seat .rotate");
const closeButtons = document.querySelectorAll(".close");
const notification = document.querySelector("#notification");
const foldButton = document.querySelector("#fold-button");
const actionButton = document.querySelector("#action-button");
const amountControls = document.querySelector("#amount-controls");
const amountDecrementButton = document.querySelector(
	"#amount-decrement-button",
);
const statsButton = document.querySelector("#stats-button");
const logButton = document.querySelector("#log-button");
const fastForwardButton = document.querySelector("#fast-forward-button");
const potEl = document.getElementById("pot");
const communityCardSlots = document.querySelectorAll(
	"#community-cards .cardslot",
);
const tableRenderTarget = {
	potEl,
	chipTransferTimer: null,
	activeChipTransferId: null,
	activeChipTransferState: null,
};
const overlayBackdrop = document.querySelector("#overlay-backdrop");
const resumeGameOverlay = document.querySelector("#resume-game-overlay");
const resumeContinueButton = document.querySelector("#resume-continue-button");
const resumeNewButton = document.querySelector("#resume-new-button");
const statsOverlay = document.querySelector("#stats-overlay");
const statsCloseButton = document.querySelector("#stats-close-button");
const statsTableBody = document.querySelector("#stats-table-body");
const profileButton = document.querySelector("#profile-button");
const profileOverlay = document.querySelector("#profile-overlay");
const profileCloseButton = document.querySelector("#profile-close-button");
const profileElements = {
	groups: document.querySelector("#profile-groups"),
	history: document.querySelector("#profile-history-list"),
	groupTemplate: document.querySelector("#profile-group-template"),
	headingTemplate: document.querySelector("#profile-heading-template"),
	rowTemplate: document.querySelector("#profile-row-template"),
	cellTemplate: document.querySelector("#profile-cell-template"),
	helpTemplate: document.querySelector("#profile-help-template"),
	historyTemplate: document.querySelector("#profile-history-template"),
};
const logOverlay = document.querySelector("#log-overlay");
const logCloseButton = document.querySelector("#log-close-button");
const versionButton = document.querySelector("#version-button");
const langButton = document.querySelector("#lang-button");
const versionOverlay = document.querySelector("#version-overlay");
const versionCloseButton = document.querySelector("#version-close-button");
const versionList = document.querySelector("#version-list");
const instructionsOverlay = document.querySelector("#instructions-overlay");
const instructionsCloseButton = document.querySelector(
	"#instructions-close-button",
);
const cheatOverlay = document.querySelector("#cheat-overlay");
const cheatCloseButton = document.querySelector("#cheat-close-button");
const logList = document.querySelector("#log-list");
const amountSlider = document.querySelector("#amount-slider");
const amountIncrementButton = document.querySelector(
	"#amount-increment-button",
);
const amountInput = document.querySelector("#amount-input");
const seatRefs = Array.from(document.querySelectorAll(".seat")).map((
	seatEl,
	seatSlot,
) => ({
	seatSlot,
	seatEl,
	nameEl: seatEl.querySelector("h3"),
	totalEl: seatEl.querySelector(".chips .total"),
	betEl: seatEl.querySelector(".chips .bet"),
	stackChipEls: seatEl.querySelectorAll(".stack-visual img"),
	dealerEl: seatEl.querySelector(".dealer"),
	smallBlindEl: seatEl.querySelector(".small-blind"),
	bigBlindEl: seatEl.querySelector(".big-blind"),
	rotateEl: seatEl.querySelector(".rotate"),
	closeEl: seatEl.querySelector(".close"),
	winProbabilityEl: seatEl.querySelector(".win-probability"),
	handStrengthEl: seatEl.querySelector(".hand-strength"),
	cardEls: seatEl.querySelectorAll(".card"),
	qrContainer: seatEl.querySelector(".qr"),
	qrLink: seatEl.querySelector(".qr-link"),
	remoteLink: seatEl.querySelector(".remote-table-link"),
	winnerReactionEl: seatEl.querySelector(".winner-reaction"),
	winnerReactionTimer: null,
	actionLabelTimer: null,
	playerSeatIndex: null,
	clearActionLabelState: null,
	clearWinnerReactionState: null,
}));
const overlays = {
	stats: {
		el: statsOverlay,
		beforeOpen: () => renderStatsOverlay(),
	},
	profile: {
		el: profileOverlay,
		canOpen: () => playerProfile?.totals.tournaments > 0,
		beforeOpen: () => renderPlayerProfile(profileElements, playerProfile),
	},
	resume: {
		el: resumeGameOverlay,
		blocking: true,
	},
	log: {
		el: logOverlay,
		canOpen: () => !!logList && logList.childElementCount > 0,
	},
	version: {
		el: versionOverlay,
		beforeOpen: () => renderVersionOverlay(),
	},
	instructions: {
		el: instructionsOverlay,
	},
	cheat: {
		el: cheatOverlay,
		beforeOpen: () => refreshCheatPanel(),
	},
};

/* --------------------------------------------------------------------------------------------------
Runtime Flags And Mutable UI State
---------------------------------------------------------------------------------------------------*/

const MAX_ITEMS = 8;
const notifArr = [];
const pendingNotif = [];
let isNotifProcessing = false;
let notifTimer = null;
const DEFAULT_NOTIF_INTERVAL = 750;
let NOTIF_INTERVAL = DEFAULT_NOTIF_INTERVAL;
const FAST_FORWARD_NOTIF_INTERVAL = 0;
const DEFAULT_ACTION_LABEL_DURATION = 3000;
let ACTION_LABEL_DURATION = DEFAULT_ACTION_LABEL_DURATION;
const FAST_FORWARD_ACTION_LABEL_DURATION = 180;
const DEFAULT_RUNOUT_PHASE_DELAY = 3000;
let RUNOUT_PHASE_DELAY = DEFAULT_RUNOUT_PHASE_DELAY;
const FAST_FORWARD_RUNOUT_PHASE_DELAY = 320;
const FAST_FORWARD_CHIP_TRANSFER_DURATION = 160;
const FAST_FORWARD_CHIP_TRANSFER_STEPS = 8;
const DEFAULT_CHIP_TRANSFER_STEPS = 30;
const WINNER_REACTION_DURATION = 2000;
const SAVED_GAME_SCHEMA_VERSION = 1;
const SAVED_GAME_STORAGE_KEY = "poker:saved-game:v1";

const HISTORY_LOG = false; // Set to true to enable history logging in the console
let DEBUG_FLOW = false; // Set to true for verbose game-flow logging
const CHIP_UNIT = 10;

const speedModeParam = new URLSearchParams(globalThis.location.search).get(
	"speedmode",
);
const SPEED_MODE = speedModeParam !== null && speedModeParam !== "0" &&
	speedModeParam !== "false";
if (SPEED_MODE) {
	NOTIF_INTERVAL = 0;
	ACTION_LABEL_DURATION = 0;
	RUNOUT_PHASE_DELAY = 0;
	DEBUG_FLOW = true;
}

const STATE_SYNC_ENDPOINT = "https://poker.tehes.deno.net/state";
const ACTION_SYNC_ENDPOINT = "https://poker.tehes.deno.net/action";
let tableId = null;
const STATE_SYNC_DELAY = 750;
const ACTION_POLL_INTERVAL = 1000;
let stateSyncTimer = null;
let stateSyncTimerDelay = null;
let runoutPhaseTimer = null;
let chipTransferFinishTimer = null;
let lastGameSeatConfig = [];
let startButtonLabelKey = "button.start";
const CARD_BACK_CODE = "1B";
let summaryButtonsVisible = false;
let playerProfile = null;
let currentTournamentId = null;
let currentTournamentResultSaved = false;
let handFastForwardActive = false;
let cheatKeyBuffer = "";
let autoplayToGameEnd = false;
let nextChipTransferId = 1;
let pendingSavedGameSnapshot = null;
let currentFlowState = { type: "setup" };
let currentGameSaveEligible = false;

// Bot turn recovery: a queued bot action can be lost if its timer is dropped or if a
// rare render/engine error throws before the next turn is scheduled. Keep the active
// turn here so the watchdog can replay it (or apply a legal fallback) instead of
// leaving the table frozen on one highlighted bot forever.
const BOT_TURN_WATCHDOG_MS = 7000;
const BOT_ERROR_LOG_LIMIT = 20;
let activeBotTurn = null;
const botDiagnostics = [];
// Runout watchdog: set when a street is being advanced; cleared once setPhase()
// finishes. A lost delay timer or an exception during the deal would otherwise
// leave the table stuck with no active seat (e.g. four board cards before the river).
let runoutWatchdog = null;

function markRunoutStart() {
	runoutWatchdog = {
		at: Date.now(),
		phaseIndex: gameState.currentPhaseIndex,
		boardCount: gameState.communityCards.length,
	};
}

function clearRunoutWatchdog() {
	runoutWatchdog = null;
}

// --- Analytics --------------------------------------------------------------
let totalHands = 0;
let hadHumansAtStart = false;
let exitEventSent = false;

/* --------------------------------------------------------------------------------------------------
Game Constants And Game State
---------------------------------------------------------------------------------------------------*/

const WINNER_REACTION_EMOJIS = {
	reveal: ["😉", "😜", "🤭"],
	uncontested: ["😎", "😏", "😌"],
	split: ["🤝"],
	lucky: ["🥹", "😆", "😮‍💨"],
	comeback: ["💪", "😅"],
	monsterHand: ["🤩", "🥳"],
	strongHand: ["😁", "😄", "😬"],
	bigPot: ["🤑"],
	fallback: ["🙂", "😊"],
};
const WINNER_REACTION_MONSTER_HANDS = new Set([
	"Full House",
	"Four of a Kind",
	"Straight Flush",
]);
const WINNER_REACTION_STRONG_HANDS = new Set(["Straight", "Flush"]);
const WINNER_REACTION_LUCKY_MIN_GAP = 15;
const CARD_SUIT_SYMBOLS = {
	C: "♣",
	D: "♦",
	H: "♥",
	S: "♠",
};

const gameState = {
	currentPhaseIndex: 0,
	currentBet: 0,
	pot: 0,
	activeSeatIndex: null,
	handId: 0,
	nextDecisionId: 1,
	blindLevel: 0,
	gameStarted: false,
	gameFinished: false,
	openCardsMode: false,
	spectatorMode: false,
	raisesThisRound: 0,
	handInProgress: false,
	deck: INITIAL_DECK.slice(),
	cardGraveyard: [],
	communityCards: [],
	players: [],
	allPlayers: [],
	chipTransfer: null,
	pendingAction: null,
	smallBlind: INITIAL_SMALL_BLIND,
	bigBlind: INITIAL_BIG_BLIND,
	lastRaise: INITIAL_BIG_BLIND,
	handContext: createHandContextState(),
};

gameState.toJSON = function () {
	return {
		currentPhaseIndex: this.currentPhaseIndex,
		currentBet: this.currentBet,
		pot: this.pot,
		lastRaise: this.lastRaise,
		smallBlind: this.smallBlind,
		bigBlind: this.bigBlind,
		raisesThisRound: this.raisesThisRound,
		blindLevel: this.blindLevel,
		handContext: this.handContext ? { ...this.handContext } : null,
		communityCards: this.communityCards.slice(),
		pendingAction: this.pendingAction ? { ...this.pendingAction } : null,
		players: this.players,
		timestamp: Date.now(),
	};
};

/* --------------------------------------------------------------------------------------------------
Saved Game Persistence
---------------------------------------------------------------------------------------------------*/

function getLocalStorage() {
	try {
		return globalThis.localStorage ?? null;
	} catch (error) {
		console.warn("saved game storage unavailable", error);
		return null;
	}
}

function clonePlainValue(value, fallback = null) {
	if (value === undefined) {
		return fallback;
	}
	try {
		return JSON.parse(JSON.stringify(value));
	} catch (error) {
		console.warn("saved game clone failed", error);
		return fallback;
	}
}

function normalizeNumber(value, fallback) {
	return Number.isFinite(value) ? value : fallback;
}

function createStatsSnapshot(stats = {}) {
	return {
		hands: normalizeNumber(stats.hands, 0),
		handsWon: normalizeNumber(stats.handsWon, 0),
		handsWonAfterFlop: normalizeNumber(stats.handsWonAfterFlop, 0),
		flopsSeen: normalizeNumber(stats.flopsSeen, 0),
		vpip: normalizeNumber(stats.vpip, 0),
		pfr: normalizeNumber(stats.pfr, 0),
		calls: normalizeNumber(stats.calls, 0),
		aggressiveActs: normalizeNumber(stats.aggressiveActs, 0),
		reveals: normalizeNumber(stats.reveals, 0),
		showdowns: normalizeNumber(stats.showdowns, 0),
		showdownsWon: normalizeNumber(stats.showdownsWon, 0),
		folds: normalizeNumber(stats.folds, 0),
		foldsPreflop: normalizeNumber(stats.foldsPreflop, 0),
		foldsPostflop: normalizeNumber(stats.foldsPostflop, 0),
		allins: normalizeNumber(stats.allins, 0),
	};
}

function createBotLineSnapshot(botLine = {}) {
	return {
		preflopAggressor: botLine.preflopAggressor === true,
		cbetIntent: botLine.cbetIntent ?? null,
		barrelIntent: botLine.barrelIntent ?? null,
		cbetMade: botLine.cbetMade === true,
		barrelMade: botLine.barrelMade === true,
		nonValueAggressionMade: botLine.nonValueAggressionMade === true,
		checkRaiseIntent: clonePlainValue(botLine.checkRaiseIntent, null),
		passiveValueCheckIntent: clonePlainValue(
			botLine.passiveValueCheckIntent,
			null,
		),
	};
}

function createPlayerSnapshot(player) {
	return {
		name: player.name,
		isBot: player.isBot === true,
		seatSlot: player.seatSlot,
		winnerReactionEmoji: player.winnerReactionEmoji || "",
		winnerReactionUntil: normalizeNumber(player.winnerReactionUntil, 0),
		isWinner: player.isWinner === true,
		actionState: player.actionState ? { ...player.actionState } : null,
		winProbability: typeof player.winProbability === "number" ? player.winProbability : null,
		lastNonFinalWinProbability: typeof player.lastNonFinalWinProbability === "number"
			? player.lastNonFinalWinProbability
			: null,
		seatIndex: player.seatIndex,
		holeCards: Array.isArray(player.holeCards) ? player.holeCards.slice(0, 2) : [null, null],
		visibleHoleCards: Array.isArray(player.visibleHoleCards) ? player.visibleHoleCards.slice(0, 2) : [false, false],
		dealer: player.dealer === true,
		smallBlind: player.smallBlind === true,
		bigBlind: player.bigBlind === true,
		folded: player.folded === true,
		chips: normalizeNumber(player.chips, 0),
		allIn: player.allIn === true,
		totalBet: normalizeNumber(player.totalBet, 0),
		roundBet: normalizeNumber(player.roundBet, 0),
		stats: createStatsSnapshot(player.stats),
		botLine: createBotLineSnapshot(player.botLine),
		spotState: {
			...createPlayerSpotState(),
			...clonePlainValue(player.spotState, {}),
		},
	};
}

function createGameStateSnapshot() {
	return {
		currentPhaseIndex: gameState.currentPhaseIndex,
		currentBet: gameState.currentBet,
		pot: gameState.pot,
		activeSeatIndex: gameState.activeSeatIndex,
		handId: gameState.handId,
		nextDecisionId: gameState.nextDecisionId,
		blindLevel: gameState.blindLevel,
		gameStarted: gameState.gameStarted,
		gameFinished: gameState.gameFinished,
		openCardsMode: gameState.openCardsMode,
		spectatorMode: gameState.spectatorMode,
		raisesThisRound: gameState.raisesThisRound,
		handInProgress: gameState.handInProgress,
		deck: gameState.deck.slice(),
		cardGraveyard: gameState.cardGraveyard.slice(),
		communityCards: gameState.communityCards.slice(),
		activeSeatIndexes: gameState.players.map((player) => player.seatIndex),
		players: gameState.players.map(createPlayerSnapshot),
		allPlayers: gameState.allPlayers.map(createPlayerSnapshot),
		chipTransfer: clonePlainValue(gameState.chipTransfer, null),
		pendingAction: gameState.pendingAction ? { ...gameState.pendingAction } : null,
		smallBlind: gameState.smallBlind,
		bigBlind: gameState.bigBlind,
		lastRaise: gameState.lastRaise,
		handContext: clonePlainValue(gameState.handContext, createHandContextState()),
	};
}

function getLogEntriesSnapshot() {
	if (!logList) {
		return [];
	}
	return Array.from(logList.children).map((entry) => entry.textContent || "");
}

function hasExactlyOneHumanPlayer(players = []) {
	return Array.isArray(players) &&
		players.filter((player) => player?.isBot !== true).length === 1;
}

function createSavedGameSnapshot() {
	return {
		schemaVersion: SAVED_GAME_SCHEMA_VERSION,
		savedAt: Date.now(),
		appVersion: APP_VERSION,
		tableId,
		runtimeState: {
			totalHands,
			hadHumansAtStart,
			currentGameSaveEligible,
			currentTournamentId,
			currentTournamentResultSaved,
			exitEventSent,
			summaryButtonsVisible,
			handFastForwardActive,
			autoplayToGameEnd,
			nextChipTransferId,
			notifications: notifArr.slice(),
			pendingNotifications: pendingNotif.slice(),
			logEntries: getLogEntriesSnapshot(),
		},
		flowState: clonePlainValue(currentFlowState, { type: "unknown" }),
		gameState: createGameStateSnapshot(),
	};
}

function shouldSaveCurrentGame() {
	return !SPEED_MODE &&
		currentGameSaveEligible === true &&
		gameState.gameStarted === true &&
		gameState.gameFinished !== true &&
		hasExactlyOneHumanPlayer(gameState.players);
}

function shouldRemoveCurrentGameSave() {
	return currentGameSaveEligible === true &&
		gameState.gameStarted === true &&
		(
			gameState.gameFinished === true ||
			!hasExactlyOneHumanPlayer(gameState.players)
		);
}

function removeSavedGameSnapshot() {
	const storage = getLocalStorage();
	if (!storage) {
		return;
	}
	try {
		storage.removeItem(SAVED_GAME_STORAGE_KEY);
	} catch (error) {
		console.warn("saved game remove failed", error);
	}
}

function saveCurrentGameSnapshot() {
	if (!shouldSaveCurrentGame()) {
		if (shouldRemoveCurrentGameSave()) {
			removeSavedGameSnapshot();
		}
		return;
	}

	const storage = getLocalStorage();
	if (!storage) {
		return;
	}

	try {
		storage.setItem(
			SAVED_GAME_STORAGE_KEY,
			JSON.stringify(createSavedGameSnapshot()),
		);
	} catch (error) {
		console.warn("saved game write failed", error);
	}
}

function isValidSavedGameSnapshot(snapshot) {
	return snapshot?.schemaVersion === SAVED_GAME_SCHEMA_VERSION &&
		snapshot?.gameState?.gameStarted === true &&
		snapshot?.gameState?.gameFinished !== true &&
		Array.isArray(snapshot.gameState.allPlayers) &&
		Array.isArray(snapshot.gameState.players) &&
		hasExactlyOneHumanPlayer(snapshot.gameState.players) &&
		snapshot.flowState &&
		typeof snapshot.flowState.type === "string";
}

function readSavedGameSnapshot() {
	if (SPEED_MODE) {
		return null;
	}

	const storage = getLocalStorage();
	if (!storage) {
		return null;
	}

	try {
		const rawSnapshot = storage.getItem(SAVED_GAME_STORAGE_KEY);
		if (!rawSnapshot) {
			return null;
		}
		const snapshot = JSON.parse(rawSnapshot);
		if (isValidSavedGameSnapshot(snapshot)) {
			return snapshot;
		}
		storage.removeItem(SAVED_GAME_STORAGE_KEY);
	} catch (error) {
		console.warn("saved game read failed", error);
		removeSavedGameSnapshot();
	}
	return null;
}

function setCurrentFlowState(flowState) {
	currentFlowState = clonePlainValue(flowState, { type: "unknown" });
}

function createActiveTurnFlowState(player, cycles, progressState) {
	return {
		type: "active-turn",
		phaseIndex: gameState.currentPhaseIndex,
		seatIndex: player.seatIndex,
		cycles,
		progressState: {
			nextIndex: progressState.nextIndex,
			cycles: progressState.cycles,
		},
	};
}

function normalizeSavedProgressState(progressState) {
	if (
		!progressState ||
		!Number.isFinite(progressState.nextIndex) ||
		!Number.isFinite(progressState.cycles)
	) {
		return null;
	}
	return {
		nextIndex: progressState.nextIndex,
		cycles: progressState.cycles,
	};
}

function normalizeSavedPlayer(player) {
	return {
		name: typeof player?.name === "string" ? player.name : "Player",
		isBot: player?.isBot === true,
		seatSlot: normalizeNumber(player?.seatSlot, normalizeNumber(player?.seatIndex, 0)),
		winnerReactionEmoji: typeof player?.winnerReactionEmoji === "string" ? player.winnerReactionEmoji : "",
		winnerReactionUntil: normalizeNumber(player?.winnerReactionUntil, 0),
		isWinner: player?.isWinner === true,
		actionState: player?.actionState ? { ...player.actionState } : null,
		winProbability: typeof player?.winProbability === "number" ? player.winProbability : null,
		lastNonFinalWinProbability: typeof player?.lastNonFinalWinProbability === "number"
			? player.lastNonFinalWinProbability
			: null,
		seatIndex: normalizeNumber(player?.seatIndex, 0),
		holeCards: Array.isArray(player?.holeCards) ? player.holeCards.slice(0, 2) : [null, null],
		visibleHoleCards: Array.isArray(player?.visibleHoleCards)
			? player.visibleHoleCards.slice(0, 2)
			: [false, false],
		dealer: player?.dealer === true,
		smallBlind: player?.smallBlind === true,
		bigBlind: player?.bigBlind === true,
		folded: player?.folded === true,
		chips: normalizeNumber(player?.chips, 0),
		allIn: player?.allIn === true,
		totalBet: normalizeNumber(player?.totalBet, 0),
		roundBet: normalizeNumber(player?.roundBet, 0),
		stats: createStatsSnapshot(player?.stats),
		botLine: createBotLineSnapshot(player?.botLine),
		spotState: {
			...createPlayerSpotState(),
			...clonePlainValue(player?.spotState, {}),
		},
	};
}

function restoreRuntimeState(runtimeState = {}) {
	totalHands = normalizeNumber(runtimeState.totalHands, 0);
	hadHumansAtStart = runtimeState.hadHumansAtStart === true;
	currentGameSaveEligible = runtimeState.currentGameSaveEligible === true;
	currentTournamentId = typeof runtimeState.currentTournamentId === "string" &&
			runtimeState.currentTournamentId.length > 0
		? runtimeState.currentTournamentId
		: null;
	currentTournamentResultSaved = runtimeState.currentTournamentResultSaved === true;
	exitEventSent = false;
	handFastForwardActive = runtimeState.handFastForwardActive === true;
	autoplayToGameEnd = runtimeState.autoplayToGameEnd === true;
	nextChipTransferId = normalizeNumber(runtimeState.nextChipTransferId, 1);

	notifArr.splice(
		0,
		notifArr.length,
		...(Array.isArray(runtimeState.notifications) ? runtimeState.notifications.slice(0, MAX_ITEMS) : []),
	);
	pendingNotif.splice(
		0,
		pendingNotif.length,
		...(Array.isArray(runtimeState.pendingNotifications) ? runtimeState.pendingNotifications : []),
	);

	if (logList) {
		logList.replaceChildren();
		const logEntries = Array.isArray(runtimeState.logEntries) ? runtimeState.logEntries : notifArr;
		logEntries.forEach((message) => {
			const logEntry = document.createElement("div");
			logEntry.textContent = message;
			logList.appendChild(logEntry);
		});
	}

	renderNotificationBar(notification, notifArr);
	setSummaryButtonsVisible(runtimeState.summaryButtonsVisible === true);
}

function restoreGameState(savedGameState) {
	const allPlayers = savedGameState.allPlayers.map(normalizeSavedPlayer);
	const playerBySeatIndex = new Map(
		allPlayers.map((player) => [player.seatIndex, player]),
	);
	const activeSeatIndexes = Array.isArray(savedGameState.activeSeatIndexes)
		? savedGameState.activeSeatIndexes
		: savedGameState.players.map((player) => player.seatIndex);
	const activePlayers = activeSeatIndexes
		.map((seatIndex) => playerBySeatIndex.get(seatIndex))
		.filter((player) => player !== undefined);

	Object.assign(gameState, {
		currentPhaseIndex: normalizeNumber(savedGameState.currentPhaseIndex, 0),
		currentBet: normalizeNumber(savedGameState.currentBet, 0),
		pot: normalizeNumber(savedGameState.pot, 0),
		activeSeatIndex: savedGameState.activeSeatIndex ?? null,
		handId: normalizeNumber(savedGameState.handId, 0),
		nextDecisionId: normalizeNumber(savedGameState.nextDecisionId, 1),
		blindLevel: normalizeNumber(savedGameState.blindLevel, 0),
		gameStarted: savedGameState.gameStarted === true,
		gameFinished: savedGameState.gameFinished === true,
		openCardsMode: savedGameState.openCardsMode === true,
		spectatorMode: savedGameState.spectatorMode === true,
		raisesThisRound: normalizeNumber(savedGameState.raisesThisRound, 0),
		handInProgress: savedGameState.handInProgress === true,
		deck: Array.isArray(savedGameState.deck) ? savedGameState.deck.slice() : INITIAL_DECK.slice(),
		cardGraveyard: Array.isArray(savedGameState.cardGraveyard) ? savedGameState.cardGraveyard.slice() : [],
		communityCards: Array.isArray(savedGameState.communityCards) ? savedGameState.communityCards.slice() : [],
		players: activePlayers,
		allPlayers,
		chipTransfer: clonePlainValue(savedGameState.chipTransfer, null),
		pendingAction: null,
		smallBlind: normalizeNumber(savedGameState.smallBlind, INITIAL_SMALL_BLIND),
		bigBlind: normalizeNumber(savedGameState.bigBlind, INITIAL_BIG_BLIND),
		lastRaise: normalizeNumber(savedGameState.lastRaise, INITIAL_BIG_BLIND),
		handContext: {
			...createHandContextState(),
			...clonePlainValue(savedGameState.handContext, {}),
		},
	});
}

function resetRuntimeBeforeRestore() {
	clearRunoutWatchdog();
	if (notifTimer) {
		clearTimeout(notifTimer);
		notifTimer = null;
	}
	if (stateSyncTimer !== null) {
		clearTimeout(stateSyncTimer);
		stateSyncTimer = null;
		stateSyncTimerDelay = null;
	}
	if (runoutPhaseTimer) {
		clearTimeout(runoutPhaseTimer);
		runoutPhaseTimer = null;
	}
	clearChipTransferFinishTimer();
	clearChipTransferAnimation(tableRenderTarget);
	humanTurnController.hide();
	isNotifProcessing = false;
}

function renderRestoredGameState() {
	seatRefs.forEach((seatRef) => {
		clearRenderedSeat(seatRef);
		seatRef.playerSeatIndex = null;
		seatRef.clearActionLabelState = null;
		seatRef.clearWinnerReactionState = null;
		renderSeatSetupState(seatRef, {
			visible: false,
			isBot: false,
			nameEditable: false,
			controlsVisible: false,
		});
	});

	gameState.players.forEach((player) => {
		bindSeatRefPlayer(player);
		renderSeatSetupState(getSeatRef(player), {
			visible: true,
			isBot: player.isBot,
			nameEditable: player.isBot === true,
			controlsVisible: false,
		});
		renderPlayerSeat(player);
		if (
			!player.isBot &&
			gameState.handInProgress &&
			!gameState.openCardsMode &&
			!player.folded &&
			player.holeCards.every(Boolean)
		) {
			showPlayerQr(player, player.holeCards[0], player.holeCards[1]);
		} else {
			hidePlayerQr(player);
		}
	});

	renderPot();
	renderTableCommunityCards(communityCardSlots, gameState.communityCards);
	renderPlayerChipStacks();
	updateFastForwardButton();
	renderStatsOverlay();
	syncLogUi();
	syncCheatAndReplayButtons();
	instructionsButton.classList.add("hidden");
	startButton.classList.toggle("hidden", gameState.handInProgress === true);
	if (!gameState.handInProgress) {
		setStartButtonLabel("button.newRound");
	}
}

function restoreTableUrl(savedTableId) {
	tableId = typeof savedTableId === "string" && savedTableId ? savedTableId : null;
	syncTableUrlWithState();
}

function resumeRestoredFlow(flowState = {}) {
	setCurrentFlowState(flowState);
	if (flowState.type === "chip-transfer") {
		gameState.chipTransfer = null;
		clearChipTransferAnimation(tableRenderTarget);
		finishHandAfterShowdown();
		return;
	}
	if (flowState.type === "runout") {
		markRunoutStart();
		setPhase();
		return;
	}
	if (flowState.type === "active-turn" && gameState.handInProgress) {
		startButton.classList.add("hidden");
		startBettingRound({
			resetRound: false,
			progressState: normalizeSavedProgressState(flowState.progressState),
			resumeTurn: {
				seatIndex: flowState.seatIndex,
				cycles: normalizeNumber(flowState.cycles, 0),
			},
		});
		return;
	}
	if (gameState.handInProgress) {
		startButton.classList.add("hidden");
		startBettingRound({ resetRound: false });
		return;
	}

	setCurrentFlowState({ type: "between-hands" });
	setSummaryButtonsVisible(true);
	setStartButtonLabel("button.newRound");
	startButton.classList.remove("hidden");
	saveCurrentGameSnapshot();
}

function restoreSavedGame(snapshot) {
	resetRuntimeBeforeRestore();
	restoreRuntimeState(snapshot.runtimeState);
	restoreGameState(snapshot.gameState);
	// allPlayers keeps busted seats, so replaying a restored game can revive
	// the full original seat layout.
	lastGameSeatConfig = gameState.allPlayers
		.filter((player) => Number.isInteger(player.seatSlot))
		.map((player) => ({
			seatSlot: player.seatSlot,
			name: player.name,
			isBot: player.isBot,
		}));
	currentGameSaveEligible = hasExactlyOneHumanPlayer(gameState.players);
	restoreTableUrl(snapshot.tableId);
	renderRestoredGameState();
	syncRuntimePlayback();
	resumeRestoredFlow(snapshot.flowState);
	queueStateSync(0);
}

function trackSavedGameResume() {
	if (SPEED_MODE) {
		return;
	}
	globalThis.umami?.track("Poker", {
		resumedGame: true,
	});
}

function openResumeGameOverlay(snapshot) {
	if (!resumeGameOverlay) {
		return;
	}
	pendingSavedGameSnapshot = snapshot;
	openOverlay("resume");
}

function closeResumeGameOverlay() {
	pendingSavedGameSnapshot = null;
	if (!resumeGameOverlay) {
		return;
	}
	resumeGameOverlay.classList.add("hidden");
	syncOverlayBackdrop();
}

function continueSavedGame() {
	const snapshot = pendingSavedGameSnapshot;
	if (!snapshot) {
		return;
	}
	removeSavedGameSnapshot();
	closeResumeGameOverlay();
	restoreSavedGame(snapshot);
	trackSavedGameResume();
}

function discardSavedGame() {
	removeSavedGameSnapshot();
	closeResumeGameOverlay();
}

function handlePageLifecycleSave() {
	saveCurrentGameSnapshot();
	trackUnfinishedExit();
}

/* --------------------------------------------------------------------------------------------------
Low-Level Utilities And Formatting Helpers
---------------------------------------------------------------------------------------------------*/

function logHistory(msg) {
	if (HISTORY_LOG) console.log(msg);
}

function logFlow(msg, data) {
	if (DEBUG_FLOW) {
		const ts = new Date().toISOString().slice(11, 23);
		if (data !== undefined) {
			console.log("%c" + ts, "color:#888", msg, data);
		} else {
			console.log("%c" + ts, "color:#888", msg);
		}
	}
}

function logSpeedmodeEvent(type, payload) {
	if (!SPEED_MODE) {
		return;
	}
	console.log("speedmode_event", { type, ...payload });
}

function clearBotCheckRaiseIntent(player, reason) {
	const intent = player.botLine?.checkRaiseIntent;
	if (!intent) {
		return;
	}

	logSpeedmodeEvent("bot_check_raise_intent_clear", {
		handId: gameState.handId ?? 0,
		player: player.name,
		seatIndex: player.seatIndex,
		reason,
		street: intent.street,
		edge: intent.edge,
		rawHandRank: intent.rawHandRank,
		rawHand: intent.rawHand,
		textureRisk: intent.textureRisk,
		structureTag: intent.structureTag,
		plannedAmount: intent.plannedAmount,
	});
	player.botLine.checkRaiseIntent = null;
}

function clearBotCheckRaiseIntents(reason) {
	gameState.players.forEach((player) => clearBotCheckRaiseIntent(player, reason));
}

function clearBotPassiveValueCheckIntent(player, reason) {
	const intent = player.botLine?.passiveValueCheckIntent;
	if (!intent) {
		return;
	}

	logSpeedmodeEvent("bot_passive_value_check_intent_clear", {
		handId: gameState.handId ?? 0,
		player: player.name,
		seatIndex: player.seatIndex,
		reason,
		street: intent.street,
		edge: intent.edge,
		rawHandRank: intent.rawHandRank,
		rawHand: intent.rawHand,
		textureRisk: intent.textureRisk,
		structureTag: intent.structureTag,
		plannedAmount: intent.plannedAmount,
	});
	player.botLine.passiveValueCheckIntent = null;
}

function clearBotPassiveValueCheckIntents(reason) {
	gameState.players.forEach((player) => clearBotPassiveValueCheckIntent(player, reason));
}

function buildSpeedmodeHandStartPlayers(players) {
	return players.map((player) => ({
		name: player.name,
		seatIndex: player.seatIndex,
		chipsStart: player.chips,
	}));
}

function buildSpeedmodeTotalBetByPlayer(contributors) {
	return contributors.reduce((totals, player) => {
		totals[player.name] = player.totalBet;
		return totals;
	}, {});
}

function buildSpeedmodeTotalBetBySeatIndex(contributors) {
	return contributors.reduce((totals, player) => {
		totals[player.seatIndex] = player.totalBet;
		return totals;
	}, {});
}

function buildSpeedmodePayoutByPlayer(totalPayoutByPlayer) {
	const payouts = {};
	for (const [player, amount] of totalPayoutByPlayer.entries()) {
		payouts[player.name] = amount;
	}
	return payouts;
}

function buildSpeedmodePayoutBySeatIndex(totalPayoutByPlayer) {
	const payouts = {};
	for (const [player, amount] of totalPayoutByPlayer.entries()) {
		payouts[player.seatIndex] = amount;
	}
	return payouts;
}

function createPageUrl(pageName) {
	const base = globalThis.location.origin +
		globalThis.location.pathname.replace(/[^/]*$/, "");
	return new URL(`${base}${pageName}`);
}

function formatPercent(numerator, denominator) {
	if (denominator === 0) {
		return "-";
	}
	return `${Math.round((numerator / denominator) * 100)}%`;
}

function getRandomItem(items) {
	return items[Math.floor(Math.random() * items.length)];
}

/* --------------------------------------------------------------------------------------------------
Seat And Player Binding Helpers
---------------------------------------------------------------------------------------------------*/

function getSeatRef(target) {
	if (typeof target === "number") {
		return seatRefs[target] ?? null;
	}
	if (!target) {
		return null;
	}
	if (target.seatEl) {
		return target;
	}
	if (typeof target.seatSlot === "number") {
		return seatRefs[target.seatSlot] ?? null;
	}
	return null;
}

function setPlayerActionState(player, actionName, labelUntil) {
	if (!player || !actionName || !Number.isFinite(labelUntil)) {
		clearPlayerActionState(player);
		return;
	}
	player.actionState = {
		name: actionName,
		labelUntil,
	};
}

function clearPlayerActionState(player) {
	if (!player) {
		return;
	}
	player.actionState = null;
}

function clearPlayerWinnerReactionState(player) {
	player.winnerReactionEmoji = "";
	player.winnerReactionUntil = 0;
}

function bindSeatRefPlayer(player) {
	const seatRef = getSeatRef(player);
	if (!seatRef) {
		return;
	}
	seatRef.playerSeatIndex = player.seatIndex;
	seatRef.clearActionLabelState = () => clearPlayerActionState(player);
	seatRef.clearWinnerReactionState = () => clearPlayerWinnerReactionState(player);
}

function buildPlayerSeatState(
	player,
	communityCards = getCommunityCardCodes(),
) {
	const publicPlayerView = buildPublicPlayerView(
		player,
		communityCards,
		gameState,
	);
	const winProbabilityLabel = publicPlayerView.showWinProbability &&
			typeof publicPlayerView.winProbability === "number"
		? `${Math.round(publicPlayerView.winProbability)}%`
		: "";

	return {
		name: publicPlayerView.name,
		chips: publicPlayerView.chips,
		roundBet: publicPlayerView.roundBet,
		visibleCardCodes: publicPlayerView.publicHoleCards,
		dealer: publicPlayerView.dealer,
		smallBlind: publicPlayerView.smallBlind,
		bigBlind: publicPlayerView.bigBlind,
		folded: publicPlayerView.folded,
		allIn: publicPlayerView.allIn,
		active: gameState.activeSeatIndex === player.seatIndex,
		winner: publicPlayerView.winner,
		handStrengthLabel: publicPlayerView.handStrengthLabel,
		winProbabilityLabel,
		actionState: publicPlayerView.actionState,
		winnerReaction: publicPlayerView.winnerReaction,
	};
}

function renderPlayerSeat(player, communityCards = getCommunityCardCodes()) {
	const seatRef = getSeatRef(player);
	if (!seatRef) {
		return;
	}
	renderHostSeat(seatRef, buildPlayerSeatState(player, communityCards));
}

function renderPlayerResolvedAction(player) {
	const seatRef = getSeatRef(player);
	if (!seatRef) {
		return;
	}
	renderSeatResolvedAction(seatRef, {
		playerName: player.name,
		actionName: player.actionState?.name,
		labelUntil: player.actionState?.labelUntil,
		isFolded: player.folded,
	});
}

function getPlayerSeatRenderData(playerList = gameState.players) {
	return playerList
		.map((player) => {
			const seatRef = getSeatRef(player);
			if (!seatRef) {
				return null;
			}
			return {
				seatIndex: player.seatIndex,
				chips: player.chips,
				totalEl: seatRef.totalEl,
				stackChipEls: seatRef.stackChipEls,
			};
		})
		.filter((playerView) => playerView !== null);
}

function renderPlayerChipStacks(playerList = gameState.players) {
	renderChipStacks(getPlayerSeatRenderData(playerList));
}

function renderPlayerTotal(player) {
	renderPlayerSeat(player);
}

function setPlayerSeatName(player, text) {
	const nameEl = getSeatRef(player)?.nameEl ?? null;
	if (!nameEl || nameEl === document.activeElement) {
		// The player may be renaming this bot right now; keep the edit intact.
		return;
	}
	nameEl.textContent = text;
}

function showPlayerQr(player, card1, card2) {
	const seatRef = getSeatRef(player);
	if (!seatRef?.qrContainer || !seatRef.qrLink || !seatRef.remoteLink) {
		return;
	}

	seatRef.qrContainer.classList.remove("hidden");
	const holeCardsUrl = createPageUrl("hole-cards.html");
	holeCardsUrl.searchParams.set("card1", card1);
	holeCardsUrl.searchParams.set("card2", card2);
	holeCardsUrl.searchParams.set("name", player.name);
	holeCardsUrl.searchParams.set("chips", `${player.chips}`);
	holeCardsUrl.searchParams.set("seatIndex", `${player.seatIndex}`);
	if (tableId !== null) {
		holeCardsUrl.searchParams.set("tableId", tableId);
	}
	holeCardsUrl.searchParams.set("t", `${Date.now()}`);
	const url = holeCardsUrl.toString();
	seatRef.qrLink.replaceChildren();
	seatRef.qrLink.href = url;
	QrCreator.render({
		text: url,
		size: 200,
		fill: "#333",
		background: "#fff",
		radius: 0,
	}, seatRef.qrLink);

	if (tableId !== null) {
		const remoteTableUrl = createPageUrl("remoteTable.html");
		remoteTableUrl.searchParams.set("tableId", tableId);
		remoteTableUrl.searchParams.set("seatIndex", `${player.seatIndex}`);
		seatRef.remoteLink.href = remoteTableUrl.toString();
		seatRef.remoteLink.classList.remove("hidden");
	} else {
		seatRef.remoteLink.removeAttribute("href");
		seatRef.remoteLink.classList.add("hidden");
	}

	seatRef.qrContainer.dataset.url = url;
}

function hidePlayerQr(player) {
	const seatRef = getSeatRef(player);
	if (!seatRef?.qrContainer || !seatRef.qrLink || !seatRef.remoteLink) {
		return;
	}

	seatRef.qrContainer.classList.add("hidden");
	seatRef.qrLink.replaceChildren();
	seatRef.qrLink.removeAttribute("href");
	seatRef.remoteLink.removeAttribute("href");
	seatRef.remoteLink.classList.add("hidden");
	delete seatRef.qrContainer.dataset.url;
}

function resetPlayerRoundBet(player) {
	player.roundBet = 0;
	renderPlayerSeat(player);
}

function clearPlayerActionLabel(player) {
	clearPlayerActionState(player);
	renderPlayerResolvedAction(player);
}

function applyPlayerPatches(playerPatches) {
	playerPatches.forEach(({ player, patch }) => {
		Object.assign(player, patch);
	});
}

function applyGameStatePatch(gameStatePatch) {
	Object.assign(gameState, gameStatePatch);
}

function applyHandContextPatch(handContextPatch) {
	if (!handContextPatch) {
		return;
	}
	if (!gameState.handContext) {
		gameState.handContext = createHandContextState();
	}
	Object.assign(gameState.handContext, handContextPatch);
}

function clearPlayerWinnerReaction(player) {
	clearPlayerWinnerReactionState(player);
	renderPlayerSeat(player);
}

function showPlayerWinnerReaction(player, emoji, visibleUntil) {
	player.winnerReactionEmoji = emoji;
	player.winnerReactionUntil = visibleUntil;
	renderPlayerSeat(player);
}

/* --------------------------------------------------------------------------------------------------
Render And Overlay Helpers
---------------------------------------------------------------------------------------------------*/

function renderPot() {
	potEl.textContent = gameState.pot;
}

function setCommunityCards(cardCodes) {
	gameState.communityCards = cardCodes.slice();
	renderTableCommunityCards(communityCardSlots, gameState.communityCards);
}

function setPlayerVisibleHoleCards(player, visibleHoleCards) {
	player.visibleHoleCards = visibleHoleCards.slice();
	renderPlayerHoleCards(player);
}

function renderPlayerHoleCards(player) {
	renderPlayerSeat(player);
}

function getStatsPlayers() {
	return gameState.allPlayers.slice().sort((a, b) => {
		if (b.chips !== a.chips) {
			return b.chips - a.chips;
		}
		return a.seatIndex - b.seatIndex;
	});
}

function createStatsCell(tagName, value) {
	const cell = document.createElement(tagName);
	cell.textContent = `${value}`;
	return cell;
}

function renderStatsOverlay() {
	if (!statsTableBody) {
		return;
	}

	statsTableBody.replaceChildren();
	getStatsPlayers().forEach((player) => {
		const row = document.createElement("tr");
		row.appendChild(createStatsCell("th", player.name));
		row.appendChild(createStatsCell("td", player.chips));
		row.appendChild(createStatsCell("td", player.stats.hands));
		row.appendChild(createStatsCell("td", player.stats.handsWon));
		row.appendChild(
			createStatsCell(
				"td",
				formatPercent(player.stats.handsWon, player.stats.hands),
			),
		);
		row.appendChild(createStatsCell("td", player.stats.showdowns));
		row.appendChild(createStatsCell("td", player.stats.showdownsWon));
		row.appendChild(
			createStatsCell(
				"td",
				formatPercent(
					player.stats.showdownsWon,
					player.stats.showdowns,
				),
			),
		);
		row.appendChild(createStatsCell("td", player.stats.folds));
		row.appendChild(createStatsCell("td", player.stats.foldsPreflop));
		row.appendChild(createStatsCell("td", player.stats.foldsPostflop));
		row.appendChild(createStatsCell("td", player.stats.allins));
		statsTableBody.appendChild(row);
	});
}

function renderVersionOverlay() {
	if (!versionList) {
		return;
	}

	versionList.replaceChildren();
	VERSION_LOG.forEach((entry) => {
		const versionEntry = document.createElement("article");
		versionEntry.className = "version-entry";

		const heading = document.createElement("div");
		heading.className = "version-entry-heading";

		const versionLabel = document.createElement("h3");
		versionLabel.className = "version-entry-version";
		versionLabel.textContent = `v${entry.version}`;
		heading.appendChild(versionLabel);

		const title = document.createElement("p");
		title.className = "version-entry-title";
		title.textContent = entry.title;
		heading.appendChild(title);

		const meta = document.createElement("span");
		meta.className = "version-entry-meta";
		meta.textContent = entry.date;
		heading.appendChild(meta);

		if (entry.credit) {
			const credit = document.createElement("a");
			credit.className = "version-entry-credit";
			credit.href = entry.credit.url;
			credit.target = "_blank";
			credit.rel = "noopener noreferrer";
			credit.textContent = `Contributed by @${entry.credit.name}`;
			heading.appendChild(credit);
		}

		const notes = document.createElement("ul");
		notes.className = "version-entry-notes";
		entry.notes.forEach((note) => {
			const noteItem = document.createElement("li");
			noteItem.textContent = note;
			notes.appendChild(noteItem);
		});

		versionEntry.appendChild(heading);
		versionEntry.appendChild(notes);
		versionList.appendChild(versionEntry);
	});
}

function syncOverlayBackdrop() {
	const isOverlayOpen = Object.values(overlays).some(({ el }) => el && !el.classList.contains("hidden"));
	overlayBackdrop.classList.toggle("hidden", !isOverlayOpen);
}

function isBlockingOverlayOpen() {
	return Object.values(overlays).some((overlay) =>
		overlay.blocking === true &&
		overlay.el &&
		!overlay.el.classList.contains("hidden")
	);
}

function openOverlay(name) {
	const overlay = overlays[name];
	if (!overlay) {
		return;
	}
	if (overlay.canOpen && !overlay.canOpen()) {
		return;
	}
	Object.entries(overlays).forEach(([key, entry]) => {
		entry.el?.classList.toggle("hidden", key !== name);
	});
	overlay.beforeOpen?.();
	syncOverlayBackdrop();
}

function closeOverlay(name) {
	const overlay = overlays[name];
	if (!overlay || overlay.blocking === true) {
		return;
	}
	overlay.el.classList.add("hidden");
	syncOverlayBackdrop();
}

function closeAllOverlays() {
	Object.values(overlays).forEach(({ el, blocking }) => {
		if (blocking !== true) {
			el?.classList.add("hidden");
		}
	});
	syncOverlayBackdrop();
}

function syncLogUi() {
	const hasLogHistory = !!logList && logList.childElementCount > 0;
	const showSummaryButtons = !SPEED_MODE && summaryButtonsVisible;
	// Career stats survive page refreshes, so the button stays available on the
	// setup screen and between hands; only an active hand hides it.
	const showProfileButton = !SPEED_MODE && !gameState.handInProgress &&
		playerProfile?.totals.tournaments > 0;

	statsButton.classList.toggle("hidden", !showSummaryButtons);
	profileButton.classList.toggle("hidden", !showProfileButton);
	logButton.classList.toggle("hidden", !showSummaryButtons || !hasLogHistory);
}

function setSummaryButtonsVisible(isVisible) {
	summaryButtonsVisible = isVisible;
	syncLogUi();
}

function renderLangButton() {
	langButton.textContent = getLang() === "zh" ? "EN" : "中文";
}

function renderStartButtonLabel() {
	const text = t(startButtonLabelKey);
	if (startButtonLabel) {
		startButtonLabel.textContent = text;
		startButtonLabel.classList.remove("hidden");
		return;
	}
	startButton.textContent = text;
}

function setStartButtonLabel(key) {
	startButtonLabelKey = key;
	renderStartButtonLabel();
}

/* --------------------------------------------------------------------------------------------------
Notification And Playback Helpers
---------------------------------------------------------------------------------------------------*/

function isFastPlaybackActive() {
	return SPEED_MODE || handFastForwardActive || autoplayToGameEnd;
}

function isTurboPlaybackActive() {
	return handFastForwardActive || autoplayToGameEnd;
}

function getNotifInterval() {
	if (SPEED_MODE) {
		return 0;
	}
	if (isTurboPlaybackActive()) {
		return FAST_FORWARD_NOTIF_INTERVAL;
	}
	return NOTIF_INTERVAL;
}

function getActionLabelDuration() {
	if (SPEED_MODE) {
		return 0;
	}
	if (isTurboPlaybackActive()) {
		return FAST_FORWARD_ACTION_LABEL_DURATION;
	}
	return ACTION_LABEL_DURATION;
}

function getPlayerActionNotificationText(playerName, actionName, amount = 0) {
	switch (actionName) {
		case "fold":
			return tf("notify.actionFold", { name: playerName });
		case "check":
			return tf("notify.actionCheck", { name: playerName });
		case "call":
			return tf("notify.actionCall", { name: playerName, amount });
		case "raise":
			return tf("notify.actionRaise", { name: playerName, amount });
		case "allin":
			return tf("notify.actionAllin", { name: playerName });
		default:
			return tf("notify.actionOther", { name: playerName });
	}
}

function logSkippedPlayerActionProbability(
	player,
	action,
	skipProbabilityLogReason,
) {
	switch (skipProbabilityLogReason) {
		case "allin-runout-preflop":
			logFlow("winProbability: preflop all-in runout pending", {
				action,
				name: player.name,
			});
			break;
		case "fold-preflop":
			logFlow("winProbability: preflop fold skipped", {
				name: player.name,
			});
			break;
	}
}

function getRunoutPhaseDelay() {
	if (SPEED_MODE) {
		return 0;
	}
	if (isTurboPlaybackActive()) {
		return FAST_FORWARD_RUNOUT_PHASE_DELAY;
	}
	return RUNOUT_PHASE_DELAY;
}

function scheduleNextNotif() {
	if (notifTimer) {
		clearTimeout(notifTimer);
	}
	notifTimer = setTimeout(() => {
		notifTimer = null;
		showNextNotif();
	}, getNotifInterval());
}

function deliverNotification(msg) {
	// newest message first for tracking
	if (logList) {
		const logEntry = document.createElement("div");
		logEntry.textContent = msg;
		logList.prepend(logEntry);
	}
	notifArr.unshift(msg);
	if (notifArr.length > MAX_ITEMS) notifArr.pop();
	syncLogUi();
	queueStateSync();
	renderNotificationBar(notification, notifArr);
	logHistory(msg);
}

function flushPendingNotifications() {
	if (notifTimer) {
		clearTimeout(notifTimer);
		notifTimer = null;
	}
	if (pendingNotif.length === 0) {
		isNotifProcessing = false;
		return;
	}
	isNotifProcessing = true;
	while (pendingNotif.length > 0) {
		deliverNotification(pendingNotif.shift());
	}
	isNotifProcessing = false;
}

function refreshNotificationPlayback() {
	if (!isNotifProcessing || pendingNotif.length === 0) {
		return;
	}
	scheduleNextNotif();
}

function syncRuntimePlayback() {
	setBotPlaybackFast(handFastForwardActive || autoplayToGameEnd);
	if (isFastPlaybackActive()) {
		flushPendingNotifications();
		return;
	}
	refreshNotificationPlayback();
}

function clearChipTransferFinishTimer() {
	if (chipTransferFinishTimer === null) {
		return;
	}
	clearTimeout(chipTransferFinishTimer);
	chipTransferFinishTimer = null;
}

function enqueueNotification(msg) {
	pendingNotif.push(msg);
	if (isFastPlaybackActive()) {
		flushPendingNotifications();
		return;
	}
	if (!isNotifProcessing) {
		showNextNotif();
	}
}

function showNextNotif() {
	if (pendingNotif.length === 0) {
		isNotifProcessing = false;
		notifTimer = null;
		return;
	}
	isNotifProcessing = true;
	deliverNotification(pendingNotif.shift());
	scheduleNextNotif();
}

function clearActionLabels() {
	gameState.players.forEach((player) => {
		clearPlayerActionLabel(player);
	});
}

function getHumanPlayers() {
	return gameState.players.filter((p) => !p.isBot);
}

function getHumansWithChipsCount() {
	return gameState.players.filter((p) => !p.isBot && p.chips > 0).length;
}

function updateFastForwardButton() {
	if (!fastForwardButton) {
		return;
	}
	const humanPlayers = getHumanPlayers();
	const noHumanCanAct = humanPlayers.length === 0 ||
		humanPlayers.every((player) => player.folded);
	const shouldShow = !SPEED_MODE &&
		hadHumansAtStart &&
		gameState.handInProgress &&
		!gameState.gameFinished &&
		!handFastForwardActive &&
		!autoplayToGameEnd &&
		noHumanCanAct;
	fastForwardButton.classList.toggle("hidden", !shouldShow);
}

function resetRuntimeFastForward() {
	handFastForwardActive = false;
	autoplayToGameEnd = false;
	syncRuntimePlayback();
	updateFastForwardButton();
}

function activateFastForward() {
	if (
		!gameState.handInProgress || handFastForwardActive ||
		autoplayToGameEnd || SPEED_MODE
	) {
		return;
	}
	handFastForwardActive = true;
	clearActionLabels();
	syncRuntimePlayback();
	updateFastForwardButton();
	if (runoutPhaseTimer) {
		clearTimeout(runoutPhaseTimer);
		runoutPhaseTimer = null;
		setPhase();
	}
}

/* --------------------------------------------------------------------------------------------------
Analytics And Remote State-Sync Helpers
---------------------------------------------------------------------------------------------------*/

function getHandsPlayedBucket(handCount) {
	if (handCount < 35) return "<35";
	if (handCount <= 40) return "36-40";
	if (handCount <= 45) return "41-45";
	if (handCount <= 50) return "46-50";
	if (handCount <= 55) return "51-55";
	if (handCount <= 60) return "56-60";
	if (handCount <= 70) return "61-70";
	if (handCount <= 80) return "71-80";
	if (handCount <= 90) return "81-90";
	if (handCount <= 100) return "91-100";
	if (handCount <= 120) return "101-120";
	return ">120";
}

function getExitCounts() {
	const humansWithChipsAtExit = gameState.players.filter((p) => !p.isBot && p.chips > 0).length;
	const botsWithChipsAtExit = gameState.players.filter((p) => p.isBot && p.chips > 0).length;
	return { humansWithChipsAtExit, botsWithChipsAtExit };
}

function trackUnfinishedExit() {
	if (
		SPEED_MODE ||
		!globalThis.umami ||
		!gameState.gameStarted ||
		gameState.gameFinished ||
		exitEventSent ||
		!hadHumansAtStart
	) {
		return;
	}
	const { humansWithChipsAtExit, botsWithChipsAtExit } = getExitCounts();
	const exitCategory = humansWithChipsAtExit === 0 ? "last_human_bust" : "humans_left_with_chips";
	exitEventSent = true;
	globalThis.umami?.track("Poker", {
		finished: false,
		humansWithChipsAtExit,
		botsWithChipsAtExit,
		exitCategory,
	});
}

function registerBotReveal(player) {
	if (player?.stats) {
		player.stats.reveals++;
	}
	if (SPEED_MODE) {
		return;
	}
	globalThis.umami?.track("Poker", {
		botReveal: true,
	});
}

function hasStateSyncEnabled() {
	return tableId !== null;
}

function getHumanPlayerCount(players = gameState.players) {
	return players.filter((player) => !player.isBot).length;
}

function shouldEnableStateSyncForGame() {
	return getHumanPlayerCount() >= 2;
}

function syncTableUrlWithState() {
	const tableUrl = new URL(globalThis.location.href);
	if (tableId === null) {
		tableUrl.searchParams.delete("tableId");
	} else {
		tableUrl.searchParams.set("tableId", tableId);
	}
	globalThis.history.replaceState(null, "", tableUrl.toString());
}

function initStateSyncForGame() {
	if (!shouldEnableStateSyncForGame()) {
		tableId = null;
		syncTableUrlWithState();
		return;
	}

	const tableUrl = new URL(globalThis.location.href);
	tableId = tableUrl.searchParams.get("tableId") ||
		Math.random().toString(36).slice(2, 8);
	syncTableUrlWithState();
}

function createTurnToken() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function setPendingAction(player) {
	if (
		!hasStateSyncEnabled() || !player || player.isBot || player.folded ||
		player.allIn
	) {
		if (gameState.pendingAction !== null) {
			gameState.pendingAction = null;
			queueStateSync(0);
		}
		return null;
	}

	const actionState = getPlayerActionState(gameState, player);
	const pendingAction = {
		seatIndex: player.seatIndex,
		turnToken: createTurnToken(),
		needToCall: actionState.needToCall,
		minAmount: actionState.minAmount,
		maxAmount: actionState.maxAmount,
		minRaise: actionState.minRaise,
		maxRaiseAmount: actionState.maxRaiseAmount,
		canCheck: actionState.canCheck,
		buttonLabel: getActionButtonLabel(actionState.minAmount, actionState),
	};
	gameState.pendingAction = pendingAction;
	queueStateSync(0);
	return pendingAction;
}

function clearPendingAction() {
	if (gameState.pendingAction === null) {
		return;
	}
	gameState.pendingAction = null;
	queueStateSync(0);
}

async function fetchPendingRemoteAction(turnToken) {
	if (!hasStateSyncEnabled() || !turnToken) {
		return null;
	}

	try {
		const url = `${ACTION_SYNC_ENDPOINT}?tableId=${encodeURIComponent(tableId)}&turnToken=${
			encodeURIComponent(turnToken)
		}`;
		const res = await fetch(url, {
			cache: "no-store",
		});
		if (res.status === 204) {
			return null;
		}
		if (!res.ok) {
			logFlow("remote action poll failed", { status: res.status });
			return null;
		}
		return await res.json();
	} catch (error) {
		logFlow("remote action poll failed", error);
		return null;
	}
}

async function sendTableState() {
	const payload = {
		tableId: tableId,
		view: buildSyncView(gameState, notifArr.slice(0, MAX_ITEMS)),
	};

	try {
		const res = await fetch(STATE_SYNC_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			throw new Error(`state sync failed with status ${res.status}`);
		}
	} catch (error) {
		logFlow("state sync failed", error);
		queueStateSync();
	}
}

function queueStateSync(delay = STATE_SYNC_DELAY) {
	if (!hasStateSyncEnabled()) {
		return;
	}

	const nextDelay = Math.max(0, delay);
	if (stateSyncTimer !== null) {
		if (stateSyncTimerDelay !== null && stateSyncTimerDelay <= nextDelay) {
			return;
		}
		clearTimeout(stateSyncTimer);
	}

	stateSyncTimerDelay = nextDelay;
	stateSyncTimer = setTimeout(() => {
		stateSyncTimer = null;
		stateSyncTimerDelay = null;
		sendTableState();
	}, nextDelay);
}

const humanTurnController = createHumanTurnController({
	foldButton,
	actionButton,
	amountControls,
	amountSlider,
	amountInput,
	decrementButton: amountDecrementButton,
	incrementButton: amountIncrementButton,
	actionPollInterval: ACTION_POLL_INTERVAL,
	actionStep: CHIP_UNIT,
	onControlsHidden: updateFastForwardButton,
	setActiveTurnPlayer,
	setPendingAction,
	clearPendingAction,
	fetchPendingRemoteAction,
	applyTurnAction,
	continueAfterResolvedTurn,
	getPlayerActionState: (player) => getPlayerActionState(gameState, player),
	getResolvedTurnMeta,
});

/* --------------------------------------------------------------------------------------------------
Card Visibility, Hand-Strength, Reveal, And Winner-Reaction Logic
---------------------------------------------------------------------------------------------------*/

function revealPlayerHoleCards(player) {
	setPlayerVisibleHoleCards(player, [true, true]);
}

function getCommunityCardCodes() {
	return gameState.communityCards.slice();
}

function revealActiveHoleCards() {
	gameState.players.filter((p) => !p.folded).forEach((p) => {
		revealPlayerHoleCards(p);
		hidePlayerQr(p);
	});
	updateHandStrengthDisplays();
}

function formatCardLabel(cardCode) {
	if (!cardCode || cardCode.length < 2) {
		return "";
	}
	const rank = cardCode[0] === "T" ? "10" : cardCode[0];
	const suit = CARD_SUIT_SYMBOLS[cardCode[1]] || cardCode[1];
	return `${rank}${suit}`;
}

// pokersolver hand names -> i18n keys for winner notifications
const HAND_NAME_I18N_KEY = {
	"Royal Flush": "handName.Royal Flush",
	"Straight Flush": "handName.Straight Flush",
	"Four of a Kind": "handName.Four of a Kind",
	"Full House": "handName.Full House",
	"Flush": "handName.Flush",
	"Straight": "handName.Straight",
	"Three of a Kind": "handName.Three of a Kind",
	"Two Pair": "handName.Two Pair",
	"Pair": "handName.Pair",
	"High Card": "handName.High Card",
};

function translateHandName(handName) {
	const key = HAND_NAME_I18N_KEY[handName];
	return key ? t(key) : handName;
}

function applyBotReveal(player, revealDecision) {
	if (!revealDecision) {
		return;
	}
	if (gameState.spectatorMode) {
		updateHandStrengthDisplays();
		return;
	}
	const revealedCards = new Set(revealDecision.codes);
	setPlayerVisibleHoleCards(
		player,
		player.holeCards.map((cardCode) => revealedCards.has(cardCode)),
	);
	hidePlayerQr(player);
	updateHandStrengthDisplays();
}

function getLuckyWinnerReactionGap(player, showdownPlayers = []) {
	const playerSnapshot = player?.lastNonFinalWinProbability;
	if (typeof playerSnapshot !== "number" || !Array.isArray(showdownPlayers)) {
		return null;
	}

	let hasOtherSnapshot = false;
	let highestSnapshot = playerSnapshot;
	showdownPlayers.forEach((showdownPlayer) => {
		if (showdownPlayer === player) {
			return;
		}
		const showdownSnapshot = showdownPlayer?.lastNonFinalWinProbability;
		if (typeof showdownSnapshot !== "number") {
			return;
		}
		hasOtherSnapshot = true;
		if (showdownSnapshot > highestSnapshot) {
			highestSnapshot = showdownSnapshot;
		}
	});

	if (!hasOtherSnapshot || playerSnapshot === highestSnapshot) {
		return null;
	}

	return highestSnapshot - playerSnapshot;
}

function getWinnerReactionEmoji(player, context) {
	if (context.revealedPlayers.has(player)) {
		return getRandomItem(WINNER_REACTION_EMOJIS.reveal);
	}

	if (context.activePlayerCount === 1) {
		return getRandomItem(WINNER_REACTION_EMOJIS.uncontested);
	}

	if (context.mainPotWinnerCount > 1) {
		return getRandomItem(WINNER_REACTION_EMOJIS.split);
	}

	if (context.hadShowdown) {
		const luckyGap = getLuckyWinnerReactionGap(
			player,
			context.showdownPlayers,
		);
		if (
			luckyGap !== null &&
			luckyGap >= WINNER_REACTION_LUCKY_MIN_GAP
		) {
			return getRandomItem(WINNER_REACTION_EMOJIS.lucky);
		}
	}

	const totalPayout = context.totalPayout;
	const stackBeforePayout = context.stackBeforePayout;
	const stackAfterPayout = stackBeforePayout + totalPayout;
	if (
		stackBeforePayout <= 6 * context.bigBlind &&
		stackAfterPayout >= 12 * context.bigBlind &&
		stackAfterPayout >= stackBeforePayout * 3
	) {
		return getRandomItem(WINNER_REACTION_EMOJIS.comeback);
	}

	if (context.hadShowdown) {
		const solvedHand = getVisibleSolvedHand(player, context.communityCards);
		if (solvedHand) {
			if (
				solvedHand.descr === "Royal Flush" ||
				WINNER_REACTION_MONSTER_HANDS.has(solvedHand.name)
			) {
				return getRandomItem(WINNER_REACTION_EMOJIS.monsterHand);
			}
			if (WINNER_REACTION_STRONG_HANDS.has(solvedHand.name)) {
				return getRandomItem(WINNER_REACTION_EMOJIS.strongHand);
			}
		}
	}

	if (totalPayout >= Math.max(12 * context.bigBlind, stackBeforePayout)) {
		return getRandomItem(WINNER_REACTION_EMOJIS.bigPot);
	}

	return getRandomItem(WINNER_REACTION_EMOJIS.fallback);
}

function triggerMainPotWinnerReactions(context) {
	if (isFastPlaybackActive() || context.mainPotWinners.length === 0) {
		return;
	}

	context.mainPotWinners.forEach((player) => {
		const totalPayout = context.totalPayoutByPlayer.get(player) || 0;
		if (totalPayout <= 0) {
			return;
		}
		const emoji = getWinnerReactionEmoji(player, {
			...context,
			totalPayout,
			stackBeforePayout: player.chips,
		});
		const visibleUntil = Date.now() + WINNER_REACTION_DURATION;
		player.winnerReactionEmoji = emoji;
		player.winnerReactionUntil = visibleUntil;
		showPlayerWinnerReaction(player, emoji, visibleUntil);
		queueStateSync(0);
	});
}

function updateHandStrengthDisplays() {
	const communityCards = getCommunityCardCodes();
	gameState.players.forEach((player) => renderPlayerSeat(player, communityCards));
}

function updateWinProbabilityDisplays() {
	const communityCards = getCommunityCardCodes();
	gameState.players.forEach((player) => renderPlayerSeat(player, communityCards));
}

function computeSpectatorWinProbabilities(reason = "") {
	if (
		!gameState.spectatorMode &&
		!isAllInRunout(gameState.players, gameState.currentBet)
	) {
		return;
	}
	if (gameState.currentPhaseIndex === 0) {
		logFlow("winProbability: preflop skipped", { reason });
		updateWinProbabilityDisplays();
		return;
	}

	const communityCards = getCommunityCardCodes();
	const missingCount = 5 - communityCards.length;
	if (missingCount < 0) {
		logFlow("winProbability: invalid board state", {
			communityCards,
			missingCount,
		});
		return;
	}

	const activePlayers = gameState.players.filter((p) => !p.folded);
	if (activePlayers.length === 0) {
		updateWinProbabilityDisplays();
		return;
	}

	gameState.players.forEach((p) => {
		p.winProbability = p.folded ? 0 : null;
	});
	const result = calculateWinProbabilities(
		gameState.players,
		communityCards,
		gameState.deck,
	);

	if (result.status === "invalid_board") {
		logFlow("winProbability: invalid board state", {
			communityCards,
			missingCount,
		});
		return;
	}

	if (result.status === "no_players") {
		updateWinProbabilityDisplays();
		return;
	}

	if (result.status === "too_many_boards") {
		logFlow("winProbability: skipped heavy enumeration", {
			phase: getCurrentPhase(gameState.currentPhaseIndex),
			reason,
			missingCount,
			totalBoards: result.totalBoards,
			deckSize: gameState.deck.length,
		});
		updateWinProbabilityDisplays();
		return;
	}

	if (result.status === "no_boards") {
		logFlow("winProbability: no boards to evaluate", {
			deckSize: gameState.deck.length,
			missingCount,
		});
		updateWinProbabilityDisplays();
		return;
	}

	result.activePlayers.forEach((player) => {
		player.winProbability = result.probabilities.get(player) ?? null;
		if (missingCount > 0 && typeof player.winProbability === "number") {
			player.lastNonFinalWinProbability = player.winProbability;
		}
	});

	updateWinProbabilityDisplays();

	logFlow("winProbability", {
		phase: getCurrentPhase(gameState.currentPhaseIndex),
		reason,
		missingCount,
		totalBoards: result.totalBoards,
		boards: result.boardsSeen,
		players: result.activePlayers.map((player) => ({
			name: player.name,
			winProbability: Number(player.winProbability.toFixed(2)),
		})),
	});
}

/* --------------------------------------------------------------------------------------------------
Game Setup And Hand Lifecycle
---------------------------------------------------------------------------------------------------*/

function startGame() {
	if (!gameState.gameStarted) {
		resetRuntimeFastForward();
		totalHands = 0;
		gameState.handId = 0;
		gameState.nextDecisionId = 1;
		gameState.blindLevel = 0;
		gameState.smallBlind = INITIAL_SMALL_BLIND;
		gameState.bigBlind = INITIAL_BIG_BLIND;
		gameState.lastRaise = INITIAL_BIG_BLIND;
		gameState.handInProgress = false;
		// Remember the seat layout for one-click replay. An empty name marks a
		// bot seat at this point; createPlayers() assigns bot names afterwards.
		lastGameSeatConfig = seatRefs
			.filter((seatRef) => !seatRef.seatEl.classList.contains("hidden"))
			.map((seatRef) => ({
				seatSlot: seatRef.seatSlot,
				name: seatRef.nameEl.textContent.trim(),
				isBot: seatRef.seatEl.classList.contains("bot") ||
					seatRef.nameEl.textContent.trim() === "",
			}));
		createPlayers();
		hadHumansAtStart = gameState.players.some((p) => !p.isBot);
		currentGameSaveEligible = hasExactlyOneHumanPlayer(gameState.players);
		// One stable id per tournament lets the career profile dedupe saves across restores.
		currentTournamentId = currentGameSaveEligible && !SPEED_MODE ? crypto.randomUUID() : null;
		currentTournamentResultSaved = false;
		exitEventSent = false;

		if (gameState.players.length > 1) {
			seatRefs.forEach((seatRef) =>
				renderSeatSetupState(seatRef, {
					nameEditable: seatRef.seatEl.classList.contains("bot"),
					controlsVisible: false,
				})
			);
			startButton.classList.add("hidden");
			instructionsButton.classList.add("hidden");
			closeAllOverlays();
			gameState.gameStarted = true;
			syncCheatAndReplayButtons();
			initStateSyncForGame();

			preFlop();
		} else {
			hadHumansAtStart = false;
			currentGameSaveEligible = false;
			// Not enough players: restore a usable setup screen. The old code left the
			// table on a dead $0 view with Start hidden and gameStarted=false, so every
			// later Replay click early-returned until the page was refreshed.
			gameState.players = [];
			gameState.allPlayers = [];
			gameState.pot = 0;
			gameState.communityCards = [];
			gameState.gameStarted = false;
			humanTurnController.hide();
			clearActiveTurnPlayer(false);
			clearPendingAction();
			notifArr.length = 0;
			renderNotificationBar(notification, notifArr);
			renderPot();
			setCommunityCards([]);
			seatRefs.forEach((seatRef) => {
				const preservedName = seatRef.nameEl.textContent.trim();
				clearRenderedSeat(seatRef);
				renderSeatSetupState(seatRef, {
					visible: true,
					isBot: preservedName === "",
					nameEditable: true,
					controlsVisible: true,
				});
				seatRef.nameEl.textContent = preservedName;
				seatRef.totalEl.textContent = "2000";
				seatRef.betEl.textContent = "0";
			});
			setStartButtonLabel("button.start");
			startButton.classList.remove("hidden");
			instructionsButton.classList.remove("hidden");
			syncCheatAndReplayButtons();
			enqueueNotification(t("notify.notEnoughPlayers"));
		}
	} else {
		// New Round
		preFlop();
	}
}

function createPlayers() {
	gameState.players = [];
	gameState.allPlayers = [];
	let botIndex = 1;
	for (const seatRef of seatRefs) {
		seatRef.playerSeatIndex = null;
		seatRef.clearActionLabelState = null;
		seatRef.clearWinnerReactionState = null;
		if (seatRef.seatEl.classList.contains("hidden")) {
			continue;
		}
		// Bot identity comes from the seat's "bot" class (set during setup or replay);
		// an empty name means "assign the next default bot name", a custom name is kept.
		const isBotSeat = seatRef.seatEl.classList.contains("bot") ||
			seatRef.nameEl.textContent.trim() === "";
		if (isBotSeat) {
			if (seatRef.nameEl.textContent.trim() === "") {
				seatRef.nameEl.textContent = `Bot ${botIndex++}`;
			}
			renderSeatSetupState(seatRef, { isBot: true });
		} else {
			renderSeatSetupState(seatRef, { isBot: false });
		}
	}

	const activeSeatRefs = seatRefs.filter((seatRef) => !seatRef.seatEl.classList.contains("hidden"));
	for (const seatRef of activeSeatRefs) {
		const seatIndex = gameState.players.length;
		const playerState = {
			name: seatRef.nameEl.textContent,
			isBot: seatRef.seatEl.classList.contains("bot"),
			seatSlot: seatRef.seatSlot,
			winnerReactionEmoji: "",
			winnerReactionUntil: 0,
			isWinner: false,
			actionState: null,
			winProbability: null,
			lastNonFinalWinProbability: null,
			seatIndex,
			holeCards: [null, null],
			visibleHoleCards: [false, false],
			dealer: false,
			smallBlind: false,
			bigBlind: false,
			folded: false,
			chips: 2000,
			allIn: false,
			totalBet: 0,
			roundBet: 0,
			stats: {
				hands: 0,
				handsWon: 0,
				vpip: 0,
				pfr: 0,
				calls: 0,
				aggressiveActs: 0,
				reveals: 0,
				showdowns: 0,
				showdownsWon: 0,
				folds: 0,
				foldsPreflop: 0,
				foldsPostflop: 0,
				allins: 0,
			},
			botLine: {
				preflopAggressor: false,
				cbetIntent: null,
				barrelIntent: null,
				cbetMade: false,
				barrelMade: false,
				nonValueAggressionMade: false,
				checkRaiseIntent: null,
				passiveValueCheckIntent: null,
			},
			spotState: createPlayerSpotState(),
		};
		bindSeatRefPlayer(playerState);
		gameState.players.push(playerState);
	}
	renderPlayerChipStacks();
	gameState.players.forEach((player) => {
		renderPlayerTotal(player);
		resetPlayerRoundBet(player);
		renderPlayerHoleCards(player);
	});
	gameState.allPlayers = gameState.players.slice();
}

function syncCheatAndReplayButtons() {
	const showButtons = gameState.gameStarted === true;
	replayButton.classList.toggle("hidden", !showButtons);
}

// One-click replay: reset the running tournament and immediately deal a new one
// with the same seat configuration (seat count, names, bot seats).
// Seat layout for a replay: live players are the source of truth, because a restored
// or partially captured lastGameSeatConfig may be missing bot seats. Hiding those
// seats would leave createPlayers() with one player and strand the table on $0.
function getReplaySeatConfigMap() {
	const configs = new Map();
	gameState.allPlayers.forEach((player) => {
		if (!Number.isInteger(player.seatSlot)) {
			return;
		}
		configs.set(player.seatSlot, {
			seatSlot: player.seatSlot,
			name: player.name,
			isBot: player.isBot === true,
		});
	});
	lastGameSeatConfig.forEach((entry) => {
		if (
			!Number.isInteger(entry.seatSlot) || configs.has(entry.seatSlot)
		) {
			return;
		}
		configs.set(entry.seatSlot, entry);
	});
	return configs;
}

function restartTournament() {
	if (!gameState.gameStarted) {
		return;
	}
	const replayConfigs = getReplaySeatConfigMap();
	// Bot seats keep their (possibly renamed) names; createPlayers() fills only
	// bot seats whose name is empty with a fresh default bot name.
	seatRefs.forEach((seatRef) => {
		clearRenderedSeat(seatRef);
		seatRef.playerSeatIndex = null;
		seatRef.clearActionLabelState = null;
		seatRef.clearWinnerReactionState = null;
		const config = replayConfigs.get(seatRef.seatSlot);
		renderSeatSetupState(
			seatRef,
			config
				? { visible: true, isBot: config.isBot, nameEditable: config.isBot === true, controlsVisible: false }
				: { visible: false, isBot: false, nameEditable: false, controlsVisible: false },
		);
		if (config && (config.name || !config.isBot)) {
			seatRef.nameEl.textContent = config.name;
		}
	});
	lastGameSeatConfig = [...replayConfigs.values()].sort((a, b) => a.seatSlot - b.seatSlot);
	resetRuntimeBeforeRestore();
	clearBotActionQueue();
	activeBotTurn = null;
	clearPendingAction();
	setSummaryButtonsVisible(false);
	removeSavedGameSnapshot();
	closeAllOverlays();
	gameState.gameStarted = false;
	gameState.handInProgress = false;
	// Gate the new game behind the start button instead of dealing immediately.
	syncCheatAndReplayButtons();
	setCommunityCards([]);
	renderPot();
	setStartButtonLabel("button.start");
	startButton.classList.remove("hidden");
	enqueueNotification(tf("notify.replayReady"));
}

// Bot names can be edited mid-game on the seat badge. This syncs every place that
// still shows the old name: log history, notification bar, stats table, cheat panel,
// remote clients, and the saved-game snapshot.
function applyPlayerRename(oldName, nextName) {
	// Only messages that lead with the name are rewritten, so "Bot 1" never
	// corrupts "Bot 10" in historical log entries.
	const rewriteMessage = (message) =>
		message.startsWith(`${oldName} `) ? `${nextName}${message.slice(oldName.length)}` : message;
	notifArr.forEach((message, index) => {
		notifArr[index] = rewriteMessage(message);
	});
	for (let i = 0; i < pendingNotif.length; i++) {
		pendingNotif[i] = rewriteMessage(pendingNotif[i]);
	}
	if (logList) {
		Array.from(logList.children).forEach((entry) => {
			entry.textContent = rewriteMessage(entry.textContent || "");
		});
	}
	renderNotificationBar(notification, notifArr);
}

function applySeatRename(seatRef) {
	const rawName = seatRef.nameEl.textContent.replace(/\s+/g, " ").trim();
	const player = gameState.allPlayers.find(
		(currentPlayer) => currentPlayer.seatSlot === seatRef.seatSlot,
	);
	// Only live bot seats sync here; setup-phase edits go through the normal start flow.
	if (!player || player.isBot !== true) {
		return;
	}
	// Clearing the badge mid-game keeps the current name instead of unnaming the seat.
	const nextName = rawName === "" ? player.name : rawName;
	if (nextName === player.name) {
		seatRef.nameEl.textContent = nextName;
		return;
	}
	const oldName = player.name;
	player.name = nextName;
	seatRef.nameEl.textContent = nextName;
	// Drop a pending action-label timer before it can restore the old name.
	clearSeatActionLabel(seatRef, nextName);
	applyPlayerRename(oldName, nextName);
	renderStatsOverlay();
	refreshCheatPanel();
	queueStateSync();
	saveCurrentGameSnapshot();
}

// Clicking a bot badge may catch it mid action label ("跟注", "思考中…"); put the
// real name back so the edit starts from the actual name.
function prepareSeatRename(seatRef) {
	const player = gameState.allPlayers.find(
		(currentPlayer) => currentPlayer.seatSlot === seatRef.seatSlot,
	);
	if (!player || player.isBot !== true) {
		return;
	}
	seatRef.nameEl.textContent = player.name;
}

function getCheatTableState() {
	return {
		gameStarted: gameState.gameStarted,
		handInProgress: gameState.handInProgress,
		deckCount: gameState.deck.length,
		communityCards: gameState.communityCards.slice(),
		graveyardCards: gameState.cardGraveyard.slice(),
		players: gameState.allPlayers.map((player) => ({
			seatIndex: player.seatIndex,
			name: player.name,
			isBot: player.isBot,
			chips: player.chips,
			folded: player.folded,
			allIn: player.allIn,
			busted: !gameState.players.includes(player),
			holeCards: player.holeCards.slice(),
		})),
	};
}

// Cheat helper: swap one of a seated player's hole cards by trading with the deck.
// The replaced card goes to the graveyard so the next shuffle stays a fair 52-card deck.
function applyCheatCardSwap(seatIndex, oldCardCode, newCardCode) {
	if (!gameState.handInProgress) {
		return { ok: false, message: t("cheat.handNotInProgress") };
	}
	const player = gameState.allPlayers.find((entry) => entry.seatIndex === seatIndex);
	if (!player) {
		return { ok: false, message: t("cheat.noSeat") };
	}
	if (!player.holeCards.every(Boolean)) {
		return { ok: false, message: t("cheat.noHoleCards") };
	}
	if (player.folded) {
		return { ok: false, message: t("cheat.alreadyFolded") };
	}
	const cardIndex = player.holeCards.indexOf(oldCardCode);
	if (cardIndex === -1) {
		return { ok: false, message: tf("cheat.notInHand", { code: oldCardCode }) };
	}
	const knownCards = new Set(INITIAL_DECK);
	if (!knownCards.has(newCardCode)) {
		return { ok: false, message: tf("cheat.unknownCard", { code: newCardCode }) };
	}
	if (newCardCode === oldCardCode) {
		return { ok: false, message: tf("cheat.notInDeck", { code: newCardCode }) };
	}
	if (player.holeCards.includes(newCardCode)) {
		return { ok: false, message: tf("cheat.onTable", { code: newCardCode }) };
	}
	const cardsInPlay = new Set();
	gameState.allPlayers.forEach((entry) => {
		if (entry !== player) {
			entry.holeCards.forEach((code) => code && cardsInPlay.add(code));
		}
	});
	gameState.communityCards.forEach((code) => cardsInPlay.add(code));
	if (cardsInPlay.has(newCardCode)) {
		return { ok: false, message: tf("cheat.onTable", { code: newCardCode }) };
	}
	if (!gameState.deck.includes(newCardCode)) {
		return { ok: false, message: tf("cheat.notInDeck", { code: newCardCode }) };
	}
	gameState.deck.splice(gameState.deck.indexOf(newCardCode), 1);
	gameState.cardGraveyard.push(oldCardCode);
	player.holeCards[cardIndex] = newCardCode;
	renderPlayerSeat(player);
	updateHandStrengthDisplays();
	queueStateSync();
	return { ok: true, message: tf("cheat.swapped", { old: oldCardCode, new: newCardCode }) };
}
// Flashlight peek on the shared table: one face layer per hidden card, lit by a
// feathered spotlight that follows the pointer. The 800ms sync reuses existing
// layers and only recalibrates geometry; the mask stays mounted so hovering
// never rebuilds (or flashes) anything.
function setCheatCardReveal(cardEl, cardCode) {
	const holeCardsEl = cardEl.parentElement;
	const currentTorch = cardEl._cheatTorch;
	if (cardEl.dataset.cheatCode !== cardCode || currentTorch?.parentElement !== holeCardsEl) {
		clearCheatCardReveal(cardEl);
		cardEl.dataset.cheatCode = cardCode;
		const torch = document.createElement("div");
		torch.className = "cheat-card-torch";
		torch.style.backgroundImage = `url("cards/${cardCode}.svg")`;
		torch._cheatCardEl = cardEl;
		cardEl._cheatTorch = torch;
		holeCardsEl.appendChild(torch);
		syncCheatCardTorchGeometry(cardEl);
	}
	bindCheatHandHover(holeCardsEl);
}

function clearCheatCardReveal(cardEl) {
	const torch = cardEl._cheatTorch;
	if (!cardEl.dataset.cheatCode && !torch) {
		return;
	}
	delete cardEl.dataset.cheatCode;
	delete cardEl._cheatInv;
	if (!torch) {
		return;
	}
	const holeCardsEl = torch.parentElement;
	torch.remove();
	delete cardEl._cheatTorch;
	if (holeCardsEl && !holeCardsEl.querySelector(".cheat-card-torch")) {
		holeCardsEl.classList.remove("cheat-hand-hovering");
	}
}

// The overlay is positioned over its card and re-measured on each cheat poll tick.
function syncCheatCardTorchGeometry(cardEl) {
	const torch = cardEl._cheatTorch;
	if (!torch) {
		return;
	}
	torch.style.left = `${cardEl.offsetLeft}px`;
	torch.style.top = `${cardEl.offsetTop}px`;
	torch.style.width = `${cardEl.offsetWidth}px`;
	torch.style.height = `${cardEl.offsetHeight}px`;
	const cardTransform = getComputedStyle(cardEl).transform;
	torch.style.transform = cardTransform === "none" ? "" : cardTransform;
	// Hole cards are tilted a few degrees; invert that so the light spot stays
	// glued to the pointer instead of drifting toward the card edges.
	try {
		cardEl._cheatInv = cardTransform === "none" ? null : new DOMMatrix(cardTransform).inverse();
	} catch {
		cardEl._cheatInv = null;
	}
}

// Move the mask hole only: two custom properties per torch, no layout work.
function updateCheatTorchLight(holeCardsEl, clientX, clientY) {
	const containerRect = holeCardsEl.getBoundingClientRect();
	const pointerX = clientX - containerRect.left;
	const pointerY = clientY - containerRect.top;
	holeCardsEl.querySelectorAll(".cheat-card-torch").forEach((torch) => {
		const cardEl = torch._cheatCardEl;
		if (!cardEl) {
			return;
		}
		const width = cardEl.offsetWidth;
		const height = cardEl.offsetHeight;
		let offsetX = pointerX - cardEl.offsetLeft - width / 2;
		let offsetY = pointerY - cardEl.offsetTop - height / 2;
		const inverse = cardEl._cheatInv;
		if (inverse) {
			const rotatedX = inverse.a * offsetX + inverse.c * offsetY + inverse.e;
			const rotatedY = inverse.b * offsetX + inverse.d * offsetY + inverse.f;
			offsetX = rotatedX;
			offsetY = rotatedY;
		}
		torch.style.setProperty("--mx", `${(offsetX + width / 2).toFixed(1)}px`);
		torch.style.setProperty("--my", `${(offsetY + height / 2).toFixed(1)}px`);
	});
}

function bindCheatHandHover(holeCardsEl) {
	if (holeCardsEl._cheatHoverBound) {
		return;
	}
	holeCardsEl._cheatHoverBound = true;
	holeCardsEl.addEventListener("mouseenter", handleCheatHandEnter);
	holeCardsEl.addEventListener("mousemove", handleCheatHandMove);
	holeCardsEl.addEventListener("mouseleave", handleCheatHandLeave);
}

function handleCheatHandEnter(ev) {
	handleCheatHandMove.call(this, ev);
}

function handleCheatHandMove(ev) {
	const holeCardsEl = this;
	if (holeCardsEl._cheatHideTimer) {
		clearTimeout(holeCardsEl._cheatHideTimer);
		holeCardsEl._cheatHideTimer = null;
	}
	holeCardsEl.classList.add("cheat-hand-hovering");
	updateCheatTorchLight(holeCardsEl, ev.clientX, ev.clientY);
}

function handleCheatHandLeave() {
	const holeCardsEl = this;
	if (holeCardsEl._cheatHideTimer) {
		clearTimeout(holeCardsEl._cheatHideTimer);
	}
	holeCardsEl._cheatHideTimer = setTimeout(() => {
		// Seat highlight animations can shift the hand under a stationary pointer.
		if (holeCardsEl.matches(":hover")) {
			holeCardsEl._cheatHideTimer = null;
			return;
		}
		holeCardsEl.classList.remove("cheat-hand-hovering");
		holeCardsEl._cheatHideTimer = null;
	}, 140);
}

// Runs on every cheat poll tick and on toggle change; idempotent per card element.
function syncCheatTableCardHover(enabled) {
	gameState.allPlayers.forEach((player) => {
		const seatRef = getSeatRef(player);
		if (!seatRef) {
			return;
		}
		player.holeCards.forEach((cardCode, cardIndex) => {
			const cardEl = seatRef.cardEls[cardIndex];
			if (!cardEl) {
				return;
			}
			const isHiddenRealCard = Boolean(cardCode) && player.visibleHoleCards[cardIndex] !== true;
			if (enabled && isHiddenRealCard) {
				setCheatCardReveal(cardEl, cardCode);
				syncCheatCardTorchGeometry(cardEl);
			} else {
				clearCheatCardReveal(cardEl);
			}
		});
	});
}
function setDealer() {
	const dealerPlan = advanceDealer(gameState.players);
	if (!dealerPlan) {
		return;
	}
	applyPlayerPatches(dealerPlan.playerPatches);
	gameState.players = dealerPlan.players;
	if (dealerPlan.previousDealer) {
		renderPlayerSeat(dealerPlan.previousDealer);
	}
	renderPlayerSeat(dealerPlan.dealer);

	enqueueNotification(tf("notify.isDealer", { name: gameState.players[0].name }));
}

function updateBlindLevelForCurrentHand() {
	const blindLevelUpdate = getBlindLevelUpdateForHand(totalHands, gameState);
	if (!blindLevelUpdate) {
		return;
	}

	applyGameStatePatch(blindLevelUpdate.gameStatePatch);
	if (blindLevelUpdate.blindsChanged) {
		enqueueNotification(
			tf("notify.blindsAreNow", {
				sb: gameState.smallBlind,
				bb: gameState.bigBlind,
			}),
		);
	}
}

function setBlinds() {
	updateBlindLevelForCurrentHand();

	const blindPlan = postBlinds(gameState);
	applyPlayerPatches(blindPlan.playerPatches);
	applyGameStatePatch(blindPlan.gameStatePatch);
	blindPlan.playerPatches.forEach(({ player }) => {
		renderPlayerSeat(player);
	});
	renderPot();

	enqueueNotification(
		tf("notify.postSmallBlind", {
			name: blindPlan.smallBlindPlayer.name,
			amount: blindPlan.smallBlindAmount,
		}),
	);
	enqueueNotification(
		tf("notify.postBigBlind", {
			name: blindPlan.bigBlindPlayer.name,
			amount: blindPlan.bigBlindAmount,
		}),
	);
}

function dealCards() {
	const dealPlan = dealHoleCardsForNewHand(gameState);
	applyPlayerPatches(dealPlan.playerPatches);
	applyGameStatePatch(dealPlan.gameStatePatch);

	dealPlan.dealtPlayers.forEach(({ player, card1, card2 }) => {
		renderPlayerHoleCards(player);
		if (!player.isBot) {
			if (gameState.openCardsMode) {
				hidePlayerQr(player);
			} else {
				showPlayerQr(player, card1, card2);
			}
		} else {
			hidePlayerQr(player);
		}
	});
}

// Execute the standard pre-flop steps: rotate dealer, post blinds, deal cards, start betting.
function preFlop() {
	// --- Hand Start And Reset ---------------------------------------------------
	clearRunoutWatchdog();
	setCurrentFlowState({ type: "hand-start" });
	// Analytics: count hands and mark start time
	totalHands++;
	if (runoutPhaseTimer) {
		clearTimeout(runoutPhaseTimer);
		runoutPhaseTimer = null;
	}
	clearChipTransferFinishTimer();
	clearChipTransferAnimation(tableRenderTarget);

	startButton.classList.add("hidden");
	closeAllOverlays();
	setSummaryButtonsVisible(false);
	clearActionLabels();
	clearActiveTurnPlayer(false);

	const nextHandPlan = createNextHandTransitionPlan(gameState, totalHands);
	applyPlayerPatches(nextHandPlan.playerPatches);
	applyGameStatePatch(nextHandPlan.gameStatePatch);

	nextHandPlan.playerPatches.forEach(({ player }) => {
		clearPlayerWinnerReaction(player);
		renderPlayerSeat(player);
		renderPlayerHoleCards(player);
		hidePlayerQr(player);
	});
	setCommunityCards(gameState.communityCards);

	nextHandPlan.bustedPlayers.forEach((player) => {
		renderSeatSetupState(getSeatRef(player), { visible: false });
		enqueueNotification(tf("notify.outOfGame", { name: player.name }));
		logFlow("player_bust", { name: player.name });
		logSpeedmodeEvent("player_bust", {
			handId: gameState.handId,
			player: player.name,
			seatIndex: player.seatIndex,
		});
	});

	updateWinProbabilityDisplays();
	updateHandStrengthDisplays();

	// --- Game Over Check ---------------------------------------------------------
	// GAME OVER: only one player left at the table
	if (nextHandPlan.type === "game-over") {
		const champion = nextHandPlan.champion;
		clearActiveTurnPlayer(false);
		enqueueNotification(tf("notify.champion", { name: champion.name }));
		// Reveal champion's stack
		renderPlayerTotal(champion);
		renderPlayerSeat(champion);
		logFlow("tournament_end", { champion: champion.name });
		clearPendingAction();
		humanTurnController.hide();
		resetRuntimeFastForward();
		if (!SPEED_MODE) {
			globalThis.umami?.track("Poker", {
				champion: champion.name,
				botWon: champion.isBot,
				handsPlayed: getHandsPlayedBucket(totalHands),
				finished: true,
			});
			renderStatsOverlay();
			setSummaryButtonsVisible(true);
		}
		if (currentGameSaveEligible) {
			removeSavedGameSnapshot();
		}
		queueStateSync(0);
		return; // skip the rest of preFlop()
	}
	// ----------------------------------------------------------

	// --- Dealer, Blinds, Deal, And First Round ----------------------------------
	updateFastForwardButton();

	// Assign dealer
	setDealer();

	// post blinds
	setBlinds();
	const handStartPlayers = buildSpeedmodeHandStartPlayers(gameState.players);

	// Shuffle and deal new hole cards
	dealCards();
	if (totalHands === 1 && !SPEED_MODE) {
		globalThis.umami?.track("Poker", {
			players: gameState.players.length,
			bots: gameState.players.filter((p) => p.isBot).length,
			humans: gameState.players.filter((p) => !p.isBot).length,
		});
	}
	logSpeedmodeEvent("hand_start", {
		handId: gameState.handId,
		blindLevel: gameState.blindLevel,
		smallBlind: gameState.smallBlind,
		bigBlind: gameState.bigBlind,
		dealerSeatIndex: gameState.players.find((player) => player.dealer)?.seatIndex ?? null,
		communityCards: [],
		players: handStartPlayers,
	});

	// Start first betting round (preflop)
	queueStateSync();
	startBettingRound();
}

function dealCommunityCards(amount) {
	const dealPlan = dealCommunityCardsForPhase(
		gameState,
		amount,
		communityCardSlots.length,
	);
	if (!dealPlan) {
		console.warn("Not enough empty slots for", amount);
		logFlow("dealCommunityCards: not enough slots");
		return;
	}
	applyGameStatePatch(dealPlan.gameStatePatch);
	applyPlayerPatches(dealPlan.playerPatches ?? []);
	renderTableCommunityCards(communityCardSlots, gameState.communityCards);
	updateHandStrengthDisplays();
	if (
		gameState.spectatorMode ||
		isAllInRunout(gameState.players, gameState.currentBet)
	) {
		computeSpectatorWinProbabilities("dealCommunityCards");
	}
}

function setPhase() {
	const watchdogAtStart = runoutWatchdog;
	logFlow("setPhase", {
		phase: getCurrentPhase(gameState.currentPhaseIndex),
	});
	const phasePlan = getNextPhasePlan(gameState);
	if (phasePlan.botIntentResetReason) {
		clearBotCheckRaiseIntents(phasePlan.botIntentResetReason);
		clearBotPassiveValueCheckIntents(phasePlan.botIntentResetReason);
	}
	if (phasePlan.reason === "onlyActivePlayer") {
		// startBettingRound()/queueRunoutPhaseAdvance() may have registered the next
		// street's marker while this phase was resolving; only clear our own.
		if (runoutWatchdog === watchdogAtStart) {
			clearRunoutWatchdog();
		}
		return doShowdown();
	}

	applyGameStatePatch(phasePlan.gameStatePatch);
	applyHandContextPatch(phasePlan.handContextPatch);

	switch (phasePlan.phase) {
		case "flop":
			dealCommunityCards(phasePlan.cardsToDeal);
			enqueueNotification(t("notify.flop"));
			startBettingRound();
			break;
		case "turn":
			dealCommunityCards(phasePlan.cardsToDeal);
			enqueueNotification(t("notify.turn"));
			startBettingRound();
			break;
		case "river":
			dealCommunityCards(phasePlan.cardsToDeal);
			enqueueNotification(t("notify.river"));
			startBettingRound();
			break;
		case "showdown":
			doShowdown();
			break;
	}
	if (runoutWatchdog === watchdogAtStart) {
		clearRunoutWatchdog();
	}
	queueStateSync();
}

function queueRunoutPhaseAdvance(reason = "") {
	humanTurnController.hide();
	setCurrentFlowState({
		type: "runout",
		reason,
		phaseIndex: gameState.currentPhaseIndex,
	});
	if (runoutPhaseTimer) {
		return;
	}
	markRunoutStart();
	const runoutPhaseDelay = getRunoutPhaseDelay();
	if (
		!isAllInRunout(gameState.players, gameState.currentBet) ||
		runoutPhaseDelay === 0
	) {
		saveCurrentGameSnapshot();
		return setPhase();
	}
	logFlow("delay runout phase", {
		reason,
		phase: getCurrentPhase(gameState.currentPhaseIndex),
		delay: runoutPhaseDelay,
	});
	runoutPhaseTimer = setTimeout(() => {
		runoutPhaseTimer = null;
		setPhase();
	}, runoutPhaseDelay);
	saveCurrentGameSnapshot();
}

/* --------------------------------------------------------------------------------------------------
Turn Handling And Betting Round Flow
---------------------------------------------------------------------------------------------------*/

function notifyPlayerAction(player, action = "", amount = 0, actionMeta = {}) {
	recordPlayerActionStats(gameState, player, action, actionMeta);

	const msg = getPlayerActionNotificationText(player.name, action, amount);
	if (action) {
		setPlayerActionState(
			player,
			action,
			Date.now() + getActionLabelDuration(),
		);
	} else {
		clearPlayerActionState(player);
	}

	renderPlayerResolvedAction(player);

	const followUpEffects = getPlayerActionFollowUpEffects(
		gameState,
		player,
		action,
	);
	if (followUpEffects.clearWinProbability) {
		player.winProbability = 0;
	}
	if (followUpEffects.revealActiveHoleCards) {
		revealActiveHoleCards();
	} else if (followUpEffects.refreshHandStrength) {
		updateHandStrengthDisplays();
	}
	if (followUpEffects.recomputeSpectatorWinProbabilities) {
		computeSpectatorWinProbabilities(followUpEffects.probabilityReason);
	} else if (followUpEffects.skipProbabilityLogReason) {
		logSkippedPlayerActionProbability(
			player,
			action,
			followUpEffects.skipProbabilityLogReason,
		);
	}
	queueStateSync(0);
	updateFastForwardButton();
	enqueueNotification(msg);
}

function setActiveTurnPlayer(player) {
	const previousActiveSeatIndex = gameState.activeSeatIndex;
	gameState.activeSeatIndex = player.seatIndex;
	renderSeatActiveStates(seatRefs, gameState.activeSeatIndex);
	if (previousActiveSeatIndex !== player.seatIndex) {
		queueStateSync(0);
	}
}

function clearActiveTurnPlayer(sync = true) {
	renderSeatActiveStates(seatRefs, null);
	if (gameState.activeSeatIndex === null) {
		return;
	}
	gameState.activeSeatIndex = null;
	if (sync) {
		queueStateSync(0);
	}
}

function continueAfterResolvedTurn({
	player,
	cycles,
	nextPlayer,
	logPrefix,
	advanceReason,
}) {
	const continuation = getResolvedTurnContinuation(gameState, cycles);
	if (continuation.type === "next") {
		logFlow(`${logPrefix} next`, { name: player.name });
		nextPlayer();
	} else if (continuation.type === "wait") {
		logFlow(`${logPrefix} wait`, { name: player.name });
		nextPlayer();
	} else {
		clearActiveTurnPlayer(false);
		logFlow(`${logPrefix} advance`, { name: player.name });
		queueRunoutPhaseAdvance(advanceReason);
	}
}

function getResolvedTurnMeta(resolvedAction) {
	if (resolvedAction?.action === "fold") {
		return {
			logPrefix: "fold",
			advanceReason: "fold",
		};
	}
	if (resolvedAction?.action === "allin") {
		return {
			logPrefix: "human",
			advanceReason: "human-allin",
		};
	}
	return {
		logPrefix: "human",
		advanceReason: "human",
	};
}

function applyResolvedTurnActionPatches(player, resolvedAction) {
	Object.assign(player, resolvedAction.playerPatch);
	Object.assign(gameState, resolvedAction.gameStatePatch);

	if (Object.keys(resolvedAction.playerPatch).length > 0) {
		renderPlayerSeat(player);
	}
	if (
		Object.prototype.hasOwnProperty.call(
			resolvedAction.gameStatePatch,
			"pot",
		)
	) {
		renderPot();
	}
}

function applyTurnAction(player, actionRequest) {
	const resolvedAction = resolveTurnAction(gameState, player, actionRequest);
	if (!resolvedAction) {
		return null;
	}

	applyResolvedTurnActionPatches(player, resolvedAction);
	notifyPlayerAction(
		player,
		resolvedAction.action,
		resolvedAction.amount,
		resolvedAction.actionMeta,
	);
	if (resolvedAction.action === "fold") {
		hidePlayerQr(player);
	}
	return resolvedAction;
}

function getBotTurnSignature(player) {
	return [
		player.chips,
		player.roundBet,
		player.folded === true,
		player.allIn === true,
		player.actionState?.name ?? "",
		gameState.pot,
		gameState.currentBet,
		gameState.raisesThisRound,
		gameState.currentPhaseIndex,
	].join("|");
}

function reportBotError(context, error, player = null) {
	const entry = {
		context,
		message: error?.message ?? String(error),
		stack: error?.stack ?? "",
		at: new Date().toISOString(),
		handId: gameState.handId,
		phase: gameState.currentPhaseIndex,
		activeSeatIndex: gameState.activeSeatIndex,
		player: player?.name ?? null,
		playerSeatIndex: player?.seatIndex ?? null,
		pot: gameState.pot,
		currentBet: gameState.currentBet,
	};
	botDiagnostics.push(entry);
	if (botDiagnostics.length > BOT_ERROR_LOG_LIMIT) {
		botDiagnostics.shift();
	}
	console.error("[poker] bot turn error", entry, error);
}

// The action patch is applied before rendering/notification side effects, so a changed
// signature means the bet already landed and only the remainder of the flow is missing.
function recoverActiveBotTurn(turn, error) {
	if (!turn) {
		return false;
	}
	turn.recoveryAttempts = (turn.recoveryAttempts ?? 0) + 1;
	if (turn.recoveryAttempts > 2) {
		reportBotError("bot-turn-give-up", error, turn.player);
		return false;
	}
	const player = turn.player;
	// If the flow already moved to another seat, nextPlayer() completed before the
	// error surfaced; replaying the continuation would skip a player.
	if (gameState.activeSeatIndex !== player.seatIndex) {
		logFlow("bot recovery skipped: turn already advanced", {
			name: player.name,
		});
		return true;
	}
	const acted = getBotTurnSignature(player) !== turn.signature;
	try {
		if (!acted) {
			const actionState = getPlayerActionState(gameState, player);
			const fallback = actionState.canCheck ? { action: "check" } : { action: "fold" };
			const resolvedAction = applyTurnAction(player, fallback);
			if (!resolvedAction) {
				reportBotError("bot-turn-fallback-rejected", error, player);
				return false;
			}
			logFlow("bot turn fallback applied", {
				name: player.name,
				action: fallback.action,
			});
		} else {
			logFlow("bot turn resumed after error", { name: player.name });
		}
		continueAfterResolvedTurn({
			player,
			cycles: turn.cycles,
			nextPlayer: turn.nextPlayer,
			logPrefix: "bot",
			advanceReason: "bot",
		});
		return true;
	} catch (recoveryError) {
		reportBotError("bot-turn-recovery-failed", recoveryError, player);
		// Last resort: clear the highlight so the next phase can still schedule players.
		try {
			clearActiveTurnPlayer(false);
			queueRunoutPhaseAdvance("bot-recovery-failed");
		} catch (finalError) {
			reportBotError("bot-turn-final-recovery-failed", finalError, player);
		}
		return false;
	}
}

// A turn with no queued action and no state change for BOT_TURN_WATCHDOG_MS was lost
// (dropped timer, exception before enqueue, stale queue). Recover it instead of freezing.
function checkBotTurnWatchdog() {
	const turn = activeBotTurn;
	if (!turn || !gameState.gameStarted || gameState.gameFinished) {
		return;
	}
	// Background tabs throttle both the bot timer and this interval; don't misread
	// that throttling as a lost action.
	if (document.visibilityState !== "visible") {
		return;
	}
	if (Date.now() - turn.startedAt < BOT_TURN_WATCHDOG_MS) {
		return;
	}
	if (isBotActionPending()) {
		return;
	}
	if (gameState.activeSeatIndex !== turn.player.seatIndex) {
		activeBotTurn = null;
		return;
	}
	const acted = getBotTurnSignature(turn.player) !== turn.signature;
	// Drop the orphaned queue entry: its timer is gone, so leaving it would make the
	// next scheduled turn execute a stale closure against the repaired state.
	clearBotActionQueue();
	reportBotError(
		acted ? "bot-turn-watchdog-after-action" : "bot-turn-watchdog-lost",
		new Error("bot turn watchdog fired"),
		turn.player,
	);
	const recovered = recoverActiveBotTurn(
		turn,
		new Error("bot turn watchdog"),
	);
	if (activeBotTurn === turn) {
		if (recovered) {
			activeBotTurn = null;
		} else if (turn.recoveryAttempts > 2) {
			// Give up quietly after the capped attempts; keep the diagnostics entry.
			activeBotTurn = null;
		} else {
			// Keep the turn alive for one more watchdog pass, but don't spin hot.
			turn.startedAt = Date.now();
		}
	}
}

// The street did not advance (lost runout delay timer or setPhase threw before
// dealing). Re-issue setPhase; the phase/board snapshot prevents double-dealing.
function checkRunoutWatchdog() {
	const pending = runoutWatchdog;
	if (
		!pending || !gameState.gameStarted || !gameState.handInProgress ||
		gameState.gameFinished
	) {
		return;
	}
	if (document.visibilityState !== "visible") {
		return;
	}
	if (Date.now() - pending.at < 6000) {
		return;
	}
	if (
		gameState.currentPhaseIndex !== pending.phaseIndex ||
		gameState.communityCards.length !== pending.boardCount
	) {
		// setPhase already moved the hand along; do not deal a second card.
		clearRunoutWatchdog();
		return;
	}
	if (gameState.activeSeatIndex !== null || isBotActionPending()) {
		return;
	}
	const actionButtonEl = document.querySelector("#action-button");
	if (
		actionButtonEl && !actionButtonEl.classList.contains("hidden") &&
		actionButtonEl.offsetParent
	) {
		return;
	}
	pending.attempts = (pending.attempts ?? 0) + 1;
	if (pending.attempts > 2) {
		clearRunoutWatchdog();
		reportBotError(
			"runout-give-up",
			new Error("runout phase did not advance"),
			null,
		);
		return;
	}
	pending.at = Date.now();
	reportBotError(
		"runout-watchdog",
		new Error("runout phase did not advance"),
		null,
	);
	if (runoutPhaseTimer) {
		clearTimeout(runoutPhaseTimer);
		runoutPhaseTimer = null;
	}
	try {
		setPhase();
	} catch (error) {
		reportBotError("runout-recovery-failed", error, null);
	}
}

function runBotTurn({ player, cycles, nextPlayer }) {
	setActiveTurnPlayer(player);
	humanTurnController.hide();
	clearPlayerActionLabel(player);
	clearSeatActionVisualState(getSeatRef(player));
	setPlayerSeatName(player, t("ui.thinking"));

	const turn = {
		player,
		cycles,
		nextPlayer,
		signature: getBotTurnSignature(player),
		startedAt: Date.now(),
		recoveryAttempts: 0,
	};
	activeBotTurn = turn;

	enqueueBotAction(() => {
		try {
			const decision = chooseBotAction(player, gameState);
			const actionRequest = normalizeBotActionRequest(decision);
			let resolvedAction = applyTurnAction(player, actionRequest);
			if (!resolvedAction) {
				logFlow("bot action fallback", {
					name: player.name,
					decision: decision?.action ?? null,
				});
				const fallbackActionState = getPlayerActionState(gameState, player);
				resolvedAction = applyTurnAction(
					player,
					fallbackActionState.canCheck ? { action: "check" } : { action: "fold" },
				);
			}
			continueAfterResolvedTurn({
				player,
				cycles,
				nextPlayer,
				logPrefix: "bot",
				advanceReason: "bot",
			});
		} catch (error) {
			reportBotError("bot-turn", error, player);
			const recovered = recoverActiveBotTurn(turn, error);
			if (!recovered && activeBotTurn === turn) {
				// Let the watchdog make the final attempt instead of stalling here.
				turn.startedAt = Date.now();
				return;
			}
		}
		if (activeBotTurn === turn) {
			activeBotTurn = null;
		}
	});
}

function startBettingRound(options = {}) {
	// --- Round Reset -------------------------------------------------------------
	const shouldResetRound = options.resetRound !== false;
	if (shouldResetRound) {
		const roundStartPlan = createBettingRoundStartPlan(gameState);
		if (roundStartPlan.botIntentResetReason) {
			clearBotCheckRaiseIntents(roundStartPlan.botIntentResetReason);
			clearBotPassiveValueCheckIntents(roundStartPlan.botIntentResetReason);
		}
		applyPlayerPatches(roundStartPlan.playerPatches);
		applyGameStatePatch(roundStartPlan.gameStatePatch);
		applyHandContextPatch(roundStartPlan.handContextPatch);
		roundStartPlan.playerPatches.forEach(({ player, patch }) => {
			if ("roundBet" in patch) {
				renderPlayerSeat(player);
			}
		});
	}
	logFlow("startBettingRound", {
		phase: getCurrentPhase(gameState.currentPhaseIndex),
		currentBet: gameState.currentBet,
		lastRaise: gameState.lastRaise,
		order: gameState.players.map((p) => p.name),
		resume: !shouldResetRound,
	});
	// Clear action indicators from the previous betting round
	clearActiveTurnPlayer(false);
	if (shouldResetRound) {
		gameState.players.forEach((player) => {
			clearSeatActionVisualState(getSeatRef(player), { preserveAllIn: true });
		});
	}
	clearPendingAction();

	const startExit = getBettingRoundStartExit(gameState);
	if (startExit) {
		logFlow("skip betting round", {
			active: startExit.activePlayerCount,
			actionable: startExit.actionablePlayerCount,
		});
		clearActiveTurnPlayer(false);
		clearPendingAction();
		return queueRunoutPhaseAdvance(startExit.reason);
	}

	let progressState = normalizeSavedProgressState(options.progressState) ||
		createBettingRoundProgressState(gameState);
	const loggedStartPlayer = gameState.players.length > 0
		? gameState.players[progressState.nextIndex % gameState.players.length]
		: null;

	logFlow("betting start index", {
		index: progressState.nextIndex,
		player: loggedStartPlayer?.name ?? null,
	});

	// --- Turn Loop ----------------------------------------------------------------
	function nextPlayer() {
		const step = getNextBettingRoundStep(gameState, progressState);
		if (step.progressState) {
			progressState = step.progressState;
		}

		if (step.type === "advance" && step.reason === "nextPlayer") {
			logFlow("no actionable players, advance phase (nextPlayer)", {
				active: step.activePlayers.map((p) => ({
					name: p.name,
					allIn: p.allIn,
					roundBet: p.roundBet,
				})),
			});
			clearActiveTurnPlayer(false);
			clearPendingAction();
			return queueRunoutPhaseAdvance("nextPlayer");
		}

		logFlow(
			"nextPlayer",
			{
				index: step.index,
				cycles: step.previousCycles,
				name: step.player.name,
				folded: step.player.folded,
				allIn: step.player.allIn,
				roundBet: step.player.roundBet,
			},
		);

		if (step.reason === "foldedAllIn") {
			logFlow("skip folded/allin", { name: step.player.name });
			return setTimeout(nextPlayer, 0); // avoid recursive stack growth
		}

		if (step.reason === "waitUncalled") {
			logFlow("already matched bet", {
				name: step.player.name,
				cycles: step.cycles,
			});
			logFlow("wait uncalled", { name: step.player.name });
			return setTimeout(nextPlayer, 0); // schedule asynchronously to break call chain
		}

		if (step.type === "advance") {
			logFlow("already matched bet", {
				name: step.player.name,
				cycles: step.cycles,
			});
			logFlow("advance phase", { name: step.player.name });
			clearActiveTurnPlayer(false);
			clearPendingAction();
			return queueRunoutPhaseAdvance(step.reason);
		}

		if (step.reason === "firstPassMatched") {
			logFlow("already matched bet", {
				name: step.player.name,
				cycles: step.cycles,
			});
		}

		return runTurn(step.player, step.cycles, nextPlayer);
	}

	function runTurn(player, cycles, nextPlayer) {
		setCurrentFlowState(
			createActiveTurnFlowState(player, cycles, progressState),
		);

		// --- Bot Branch --------------------------------------------------------------
		// If this is a bot, choose an action based on hand strength
		if (player.isBot) {
			runBotTurn({
				player,
				cycles,
				nextPlayer,
			});
			saveCurrentGameSnapshot();
			return;
		}

		// --- Human Branch ------------------------------------------------------------
		humanTurnController.runHumanTurn({
			player,
			cycles,
			nextPlayer,
		});
		saveCurrentGameSnapshot();
	}

	const resumeTurn = options.resumeTurn;
	if (
		resumeTurn &&
		Number.isFinite(resumeTurn.seatIndex) &&
		Number.isFinite(resumeTurn.cycles)
	) {
		const resumePlayer = gameState.players.find((player) => player.seatIndex === resumeTurn.seatIndex);
		if (resumePlayer && !resumePlayer.folded && !resumePlayer.allIn) {
			runTurn(resumePlayer, resumeTurn.cycles, nextPlayer);
			return;
		}
	}

	nextPlayer();
}

/* --------------------------------------------------------------------------------------------------
Showdown And Payout Flow
---------------------------------------------------------------------------------------------------*/

// Build the synchronized payout transfer plan and let the shared table-view renderer
// animate the visible pot and stack counts from the final canonical state.
function getChipTransferStepCount() {
	if (isTurboPlaybackActive()) {
		return FAST_FORWARD_CHIP_TRANSFER_STEPS;
	}
	return DEFAULT_CHIP_TRANSFER_STEPS;
}

function getChipTransferDurationMs(amount) {
	if (isTurboPlaybackActive()) {
		return FAST_FORWARD_CHIP_TRANSFER_DURATION;
	}
	return Math.min(Math.max(amount * 20, 300), 3000);
}

function buildChipTransferState(transferQueue) {
	if (
		SPEED_MODE ||
		!Array.isArray(transferQueue) ||
		transferQueue.length === 0
	) {
		return null;
	}

	const startedAt = Date.now();
	return {
		id: nextChipTransferId++,
		startedAt,
		transfers: transferQueue.map((transfer) => ({
			seatIndex: transfer.player.seatIndex,
			amount: transfer.amount,
			durationMs: getChipTransferDurationMs(transfer.amount),
			stepCount: getChipTransferStepCount(),
		})),
	};
}

function applyChipTransferResults(commitPlan) {
	applyPlayerPatches(commitPlan.payoutPlayerPatches);
	applyGameStatePatch(commitPlan.payoutGameStatePatch);
}

function getChipTransferRemainingDuration(chipTransfer) {
	if (
		!chipTransfer || !Array.isArray(chipTransfer.transfers) ||
		chipTransfer.transfers.length === 0
	) {
		return 0;
	}

	const endAt = chipTransfer.transfers.reduce(
		(maxEndAt, transfer) => Math.max(maxEndAt, chipTransfer.startedAt + transfer.durationMs),
		chipTransfer.startedAt,
	);
	return Math.max(0, Math.ceil(endAt - Date.now()));
}

function startChipTransferAnimation(commitPlan, onDone) {
	const transferQueue = commitPlan.transferQueue;
	if (!Array.isArray(transferQueue) || transferQueue.length === 0) {
		if (onDone) {
			onDone();
		}
		return;
	}

	clearChipTransferFinishTimer();
	clearChipTransferAnimation(tableRenderTarget);

	const chipTransfer = buildChipTransferState(transferQueue);
	gameState.chipTransfer = chipTransfer;
	applyChipTransferResults(commitPlan);

	if (!chipTransfer) {
		if (onDone) {
			onDone();
		}
		return;
	}

	renderChipTransferAnimation(tableRenderTarget, {
		finalPot: gameState.pot,
		players: getPlayerSeatRenderData(gameState.players),
		chipTransfer,
	});
	setCurrentFlowState({ type: "chip-transfer" });
	queueStateSync(0);
	saveCurrentGameSnapshot();

	chipTransferFinishTimer = setTimeout(() => {
		chipTransferFinishTimer = null;
		gameState.chipTransfer = null;
		clearChipTransferAnimation(tableRenderTarget);
		queueStateSync(0);
		if (onDone) {
			onDone();
		}
	}, getChipTransferRemainingDuration(chipTransfer));
}

// Persist a finished solo-vs-bots tournament into the long-term career profile.
// Runs after every hand end and no-ops while the human is still seated with chips
// and more than one player remains; the profile module dedupes by tournament id.
function saveCompletedSoloTournament() {
	if (
		SPEED_MODE || !currentGameSaveEligible || currentTournamentResultSaved ||
		!currentTournamentId || gameState.handInProgress
	) {
		return;
	}
	const player = gameState.allPlayers.find((currentPlayer) => !currentPlayer.isBot);
	if (!player) {
		return;
	}
	const placement = getPlayerTournamentPlacement(gameState.players, player);
	if (placement === null) {
		return;
	}
	const storage = getLocalStorage();
	if (!storage) {
		return;
	}
	const saved = savePlayerProfileResult(storage, {
		id: currentTournamentId,
		finishedAt: Date.now(),
		participantCount: gameState.allPlayers.length,
		placement,
		stats: createStatsSnapshot(player.stats),
	});
	if (saved) {
		currentTournamentResultSaved = true;
		playerProfile = readPlayerProfile(storage) ?? playerProfile;
		syncLogUi();
		if (!profileOverlay.classList.contains("hidden")) {
			renderPlayerProfile(profileElements, playerProfile);
		}
	}
}

function finishHandAfterShowdown() {
	const handEndPlan = createHandEndPlan(gameState);
	renderPlayerChipStacks();

	clearActiveTurnPlayer(false);
	applyGameStatePatch(handEndPlan.gameStatePatch);
	renderPot();
	saveCompletedSoloTournament();

	humanTurnController.hide();
	activeBotTurn = null;
	clearRunoutWatchdog();
	if (SPEED_MODE) {
		queueStateSync();
		preFlop();
		return;
	}
	if (autoplayToGameEnd) {
		queueStateSync();
		preFlop();
		return;
	}
	if (handFastForwardActive && getHumansWithChipsCount() === 0) {
		handFastForwardActive = false;
		autoplayToGameEnd = true;
		syncRuntimePlayback();
		updateFastForwardButton();
		queueStateSync();
		preFlop();
		return;
	}
	handFastForwardActive = false;
	syncRuntimePlayback();
	updateFastForwardButton();
	renderStatsOverlay();
	setSummaryButtonsVisible(true);
	setStartButtonLabel("button.newRound");
	startButton.classList.remove("hidden");
	setCurrentFlowState({ type: "between-hands" });
	queueStateSync();
	saveCurrentGameSnapshot();
}

function doShowdown() {
	// --- Active Players And Showdown State ---------------------------------------
	const communityCards = getCommunityCardCodes();
	const showdownResult = resolveShowdown(
		gameState.players,
		communityCards,
		CHIP_UNIT,
	);
	const {
		activePlayers,
		contributors,
		hadShowdown,
		uncontestedWinner,
		mainPotWinners,
		winningPlayers,
		potResults,
		totalPayoutByPlayer,
		totalPot,
	} = showdownResult;
	const commitPlan = createShowdownCommitPlan(gameState, showdownResult);
	logSpeedmodeEvent("hand_result", {
		handId: gameState.handId,
		communityCards: communityCards.slice(),
		hadShowdown,
		uncontestedWinner: uncontestedWinner?.name ?? null,
		uncontestedWinnerSeatIndex: uncontestedWinner?.seatIndex ?? null,
		mainPotWinners: mainPotWinners.map((player) => player.name),
		mainPotWinnerSeatIndexes: mainPotWinners.map((player) => player.seatIndex),
		winningPlayers: winningPlayers.map((player) => player.name),
		winningSeatIndexes: winningPlayers.map((player) => player.seatIndex),
		potResults: potResults.map((result) => ({ ...result })),
		totalPayoutByPlayer: buildSpeedmodePayoutByPlayer(totalPayoutByPlayer),
		totalPayoutBySeatIndex: buildSpeedmodePayoutBySeatIndex(
			totalPayoutByPlayer,
		),
		totalBetByPlayer: buildSpeedmodeTotalBetByPlayer(contributors),
		totalBetBySeatIndex: buildSpeedmodeTotalBetBySeatIndex(contributors),
		totalPot,
	});

	applyPlayerPatches(commitPlan.playerPatches);
	commitPlan.playerPatches.forEach(({ player }) => {
		renderPlayerSeat(player);
	});
	commitPlan.revealPlayers.forEach((player) => {
		hidePlayerQr(player);
	});
	if (commitPlan.revealPlayers.length > 0) {
		updateHandStrengthDisplays();
	}
	commitPlan.mainPotWinners.forEach((player) => {
		renderSeatActiveState(getSeatRef(player), false);
	});

	if (uncontestedWinner) {
		const revealedPlayers = new Set();
		const revealDecision = getBotRevealDecision(
			uncontestedWinner,
			communityCards,
		);
		if (revealDecision) {
			revealedPlayers.add(uncontestedWinner);
			applyBotReveal(uncontestedWinner, revealDecision);
			registerBotReveal(uncontestedWinner);
			enqueueNotification(
				tf("notify.reveals", {
					name: uncontestedWinner.name,
					cards: revealDecision.codes.map(formatCardLabel).join(" "),
				}),
			);
		} else {
			hidePlayerQr(uncontestedWinner);
		}
		triggerMainPotWinnerReactions({
			activePlayerCount: activePlayers.length,
			bigBlind: gameState.bigBlind,
			communityCards,
			contributors,
			hadShowdown,
			mainPotWinnerCount: mainPotWinners.length,
			mainPotWinners,
			revealedPlayers,
			showdownPlayers: activePlayers,
			totalPayoutByPlayer,
		});
		enqueueNotification(tf("notify.winsPot", { name: uncontestedWinner.name, amount: totalPot }));
		startChipTransferAnimation(commitPlan, () => {
			finishHandAfterShowdown();
		});
		return;
	}

	// Skip pure refund-only side pots in the log. They animate correctly, but they are not real wins.
	const filteredResults = potResults.filter((result) => result.isRefundOnly !== true);

	// --- Notification Consolidation ----------------------------------------------
	// Consolidate notifications: if same player wins all pots, combine amounts
	if (filteredResults.length > 0) {
		const allSame = filteredResults.every((r) =>
			r.players.length === 1 &&
			r.players[0] === filteredResults[0].players[0]
		);
		if (allSame) {
			const total = filteredResults.reduce((sum, r) => sum + r.amount, 0);
			const handText = filteredResults[0].hand ? translateHandName(filteredResults[0].hand) : null;
			enqueueNotification(
				handText
					? tf("notify.winsWith", {
						name: filteredResults[0].players[0],
						amount: total,
						hand: handText,
					})
					: tf("notify.wins", {
						name: filteredResults[0].players[0],
						amount: total,
					}),
			);
		} else {
			filteredResults.forEach((r) => {
				if (r.players.length === 1) {
					const handText = r.hand ? translateHandName(r.hand) : null;
					enqueueNotification(
						handText
							? tf("notify.winsWith", {
								name: r.players[0],
								amount: r.amount,
								hand: handText,
							})
							: tf("notify.wins", {
								name: r.players[0],
								amount: r.amount,
							}),
					);
				} else {
					enqueueNotification(
						tf("notify.split", { names: r.players.join(" / "), amount: r.amount }),
					);
				}
			});
		}
	}

	triggerMainPotWinnerReactions({
		activePlayerCount: activePlayers.length,
		bigBlind: gameState.bigBlind,
		communityCards,
		contributors,
		hadShowdown,
		mainPotWinnerCount: mainPotWinners.length,
		mainPotWinners,
		revealedPlayers: new Set(),
		showdownPlayers: activePlayers,
		totalPayoutByPlayer,
	});

	// --- Payout Animation --------------------------------------------------------
	// Build one synced transfer plan and let host and remote play the same animation locally.
	startChipTransferAnimation(commitPlan, () => {
		finishHandAfterShowdown();
	});
	return; // exit doShowdown early because UI flow continues in animation
}

/* --------------------------------------------------------------------------------------------------
Seat-Editing Helpers
---------------------------------------------------------------------------------------------------*/

function rotateSeat(ev) {
	const seatEl = ev.currentTarget.closest(".seat");
	const seatRef = seatRefs.find((currentSeatRef) => currentSeatRef.seatEl === seatEl);
	const rotation = Number.parseInt(seatEl?.dataset.rotation ?? "0", 10);
	renderSeatRotation(seatRef, rotation + 90);
}

function deletePlayer(ev) {
	const seatEl = ev.currentTarget.closest(".seat");
	const seatRef = seatRefs.find((currentSeatRef) => currentSeatRef.seatEl === seatEl);
	renderSeatSetupState(seatRef, { visible: false });
}

/* --------------------------------------------------------------------------------------------------
App Bootstrap And Public API
---------------------------------------------------------------------------------------------------*/

function init() {
	renderLangButton();
	langButton.addEventListener("click", () => {
		setLang(getLang() === "zh" ? "en" : "zh");
	}, false);
	onLangChange(() => {
		renderLangButton();
		applyStaticTranslations();
		renderStartButtonLabel();
		updateHandStrengthDisplays();
		if (playerProfile && !profileOverlay.classList.contains("hidden")) {
			renderPlayerProfile(profileElements, playerProfile);
		}
	});
	try {
		const storage = getLocalStorage();
		playerProfile = storage ? readPlayerProfile(storage) : createEmptyPlayerProfile();
	} catch {
		playerProfile = createEmptyPlayerProfile();
	}
	// Surface the career button right after a page refresh if results are stored.
	syncLogUi();
	applyStaticTranslations();

	// Prevent framing
	if (globalThis.top !== globalThis.self) {
		try {
			globalThis.top.location.href = globalThis.location.href;
		} catch {
			alert(
				t("ui.frameBlockedAlert"),
			);
			throw new Error(
				t("ui.frameBlockedError"),
			);
		}
	}

	if (versionButton) {
		versionButton.textContent = `v${APP_VERSION}`;
	}

	document.addEventListener("touchstart", function () {}, false);
	document.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape" && !isBlockingOverlayOpen()) {
			closeAllOverlays();
		}
	}, false);
	document.addEventListener("keydown", (ev) => {
		const target = ev.target;
		const isTypingTarget = target instanceof HTMLElement &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
				target.isContentEditable);
		if (
			isTypingTarget || ev.ctrlKey || ev.altKey || ev.metaKey ||
			ev.key.length !== 1
		) {
			return;
		}
		cheatKeyBuffer = (cheatKeyBuffer + ev.key).toLowerCase().slice(-4);
		if (cheatKeyBuffer === "show") {
			cheatKeyBuffer = "";
			openOverlay("cheat");
		}
	}, false);
	startButton.addEventListener("click", startGame, false);
	replayButton.addEventListener("click", restartTournament, false);
	instructionsButton.addEventListener(
		"click",
		() => openOverlay("instructions"),
		false,
	);
	versionButton.addEventListener(
		"click",
		() => openOverlay("version"),
		false,
	);
	notification.addEventListener("click", () => openOverlay("log"), false);
	statsButton.addEventListener("click", () => openOverlay("stats"), false);
	profileButton.addEventListener("click", () => openOverlay("profile"), false);
	logButton.addEventListener("click", () => openOverlay("log"), false);
	fastForwardButton.addEventListener("click", activateFastForward, false);
	statsCloseButton.addEventListener(
		"click",
		() => closeOverlay("stats"),
		false,
	);
	logCloseButton.addEventListener("click", () => closeOverlay("log"), false);
	profileCloseButton.addEventListener(
		"click",
		() => closeOverlay("profile"),
		false,
	);
	versionCloseButton.addEventListener(
		"click",
		() => closeOverlay("version"),
		false,
	);
	instructionsCloseButton.addEventListener(
		"click",
		() => closeOverlay("instructions"),
		false,
	);
	cheatCloseButton.addEventListener("click", () => closeOverlay("cheat"), false);
	resumeContinueButton?.addEventListener("click", continueSavedGame, false);
	resumeNewButton?.addEventListener("click", discardSavedGame, false);
	initCheatPanel({
		getTableState: getCheatTableState,
		swapCard: applyCheatCardSwap,
		syncTableCardHover: syncCheatTableCardHover,
	});
	// Last-resort guard: if some future bot queue path throws outside runBotTurn's own
	// catch, still unblock the queue and try to finish the active turn.
	setBotActionErrorHandler((error) => {
		if (activeBotTurn) {
			recoverActiveBotTurn(activeBotTurn, error);
		} else {
			reportBotError("bot-queue", error);
		}
	});
	setInterval(checkBotTurnWatchdog, 1500);
	setInterval(checkRunoutWatchdog, 1500);
	// Uncaught errors in timers/click handlers are exactly what used to freeze the
	// table silently; keep the last few in poker.diagnostics for later inspection.
	globalThis.addEventListener("error", (event) => {
		const error = event.error instanceof Error ? event.error : new Error(event.message || "window error");
		reportBotError("window-error", error, null);
	});
	globalThis.addEventListener("unhandledrejection", (event) => {
		const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
		reportBotError("unhandled-rejection", error, null);
	});
	overlayBackdrop.addEventListener("click", () => {
		if (!isBlockingOverlayOpen()) {
			closeAllOverlays();
		}
	}, false);
	globalThis.addEventListener("pagehide", handlePageLifecycleSave, false);
	globalThis.addEventListener(
		"beforeunload",
		handlePageLifecycleSave,
		false,
	);
	document.addEventListener(
		"visibilitychange",
		() => {
			if (document.visibilityState === "hidden") {
				handlePageLifecycleSave();
			}
		},
		false,
	);
	humanTurnController.init();
	renderPot();
	renderTableCommunityCards(communityCardSlots, gameState.communityCards);

	for (const rotateIcon of rotateIcons) {
		rotateIcon.addEventListener("click", rotateSeat, false);
	}
	for (const closeButton of closeButtons) {
		closeButton.addEventListener("click", deletePlayer, false);
	}
	for (const seatRef of seatRefs) {
		// Commit a seat rename on Enter or when the badge loses focus.
		seatRef.nameEl.addEventListener("focus", () => prepareSeatRename(seatRef));
		seatRef.nameEl.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				seatRef.nameEl.blur();
			}
		});
		seatRef.nameEl.addEventListener("focusout", () => applySeatRename(seatRef));
	}

	const savedGameSnapshot = readSavedGameSnapshot();
	if (savedGameSnapshot) {
		openResumeGameOverlay(savedGameSnapshot);
	}
}

globalThis.poker = {
	init,
	get players() {
		return gameState.allPlayers;
	},
	get gameFinished() {
		return gameState.gameFinished;
	},
	get handInProgress() {
		return gameState.handInProgress;
	},
	get reveals() {
		return gameState.allPlayers.map((player) => ({
			name: player.name,
			reveals: player.stats.reveals,
		}));
	},
	get diagnostics() {
		return botDiagnostics.slice();
	},
	get activeSeatIndex() {
		return gameState.activeSeatIndex;
	},
	get flowState() {
		return { ...currentFlowState };
	},
	get runoutWatchdog() {
		return runoutWatchdog
			? {
				at: runoutWatchdog.at,
				phaseIndex: runoutWatchdog.phaseIndex,
				boardCount: runoutWatchdog.boardCount,
				attempts: runoutWatchdog.attempts ?? 0,
			}
			: null;
	},
};

poker.init();

/* --------------------------------------------------------------------------------------------------
 * Service Worker configuration
 * - USE_SERVICE_WORKER: enable or disable SW for this project
 * - SERVICE_WORKER_VERSION: bump to force new SW and new cache
 * - AUTO_RELOAD_ON_SW_UPDATE: reload page once after an update
 -------------------------------------------------------------------------------------------------- */
const USE_SERVICE_WORKER = false;
const SERVICE_WORKER_VERSION = "2026-11-17-v5";
const AUTO_RELOAD_ON_SW_UPDATE = true;

initServiceWorker({
	useServiceWorker: USE_SERVICE_WORKER,
	serviceWorkerVersion: SERVICE_WORKER_VERSION,
	autoReloadOnUpdate: AUTO_RELOAD_ON_SW_UPDATE,
});
