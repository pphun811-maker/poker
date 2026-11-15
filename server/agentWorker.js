/* ==================================================================================================
MODULE BOUNDARY: Agent Table Worker
================================================================================================== */

// CURRENT STATE: Runs one agent-vs-bots game headlessly inside a Deno worker, reusing the untouched
// pure engine and bot modules. Bot decisions run synchronously; remote seats (the HTTP agent at
// seat 0 and, when enabled, the human seat at seat 1) block the worker on a SharedArrayBuffer until
// the HTTP server writes a decision, so a remote turn has no timer and can take arbitrarily long.
// Every message posted to the main thread passes through a whitelist sanitizer that never exposes
// other players' hole cards, the deck, or the graveyard.
// PUT HERE: Game state construction, action provider wiring, remote seat decision wait loop,
// sanitized snapshot building, and the hand loop.
// DO NOT PUT HERE: HTTP routing, seat tokens, request validation, or client-facing shaping.

import {
	createBotLineState,
	createHandContextState,
	createPlayerSpotState,
	getCurrentPhase,
	INITIAL_BIG_BLIND,
	INITIAL_DECK,
	INITIAL_SMALL_BLIND,
	resolveTurnAction,
	runEngineHand,
} from "../js/gameEngine.js";
import { chooseBotAction, normalizeBotActionRequest } from "../js/bot.js";
import { getActionRequestForAmount, getPlayerActionState, normalizeActionAmount } from "../js/shared/actionModel.js";

export const AGENT_SEAT_INDEX = 0;
export const HUMAN_SEAT_INDEX = 1;
export const MAX_HANDS = 10000;
const MAX_STEPS_PER_HAND = 1000;
const AGENT_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
const SAB_TURN_FLAG = 0;
const SAB_ACTION_CODE = 1;
const SAB_ACTION_AMOUNT = 2;
const SAB_ABORT_FLAG = 3;
const ACTION_CODES = { fold: 1, check: 2, call: 3, raise: 4, allin: 5 };
const ACTION_NAMES = Object.fromEntries(
	Object.entries(ACTION_CODES).map(([name, code]) => [code, name]),
);

let sab = null;
let gameState = null;
let liveActions = [];
let snapshotRevision = 0;
let humanSeatEnabled = false;

function createPlayerStats() {
	return {
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
	};
}

function createPlayer(index, { name, isBot, startingChips }) {
	return {
		name,
		isBot,
		seatSlot: index,
		winnerReactionEmoji: "",
		winnerReactionUntil: 0,
		isWinner: false,
		actionState: null,
		winProbability: null,
		lastNonFinalWinProbability: null,
		seatIndex: index,
		holeCards: [null, null],
		visibleHoleCards: [false, false],
		dealer: false,
		smallBlind: false,
		bigBlind: false,
		folded: false,
		chips: startingChips,
		allIn: false,
		totalBet: 0,
		roundBet: 0,
		stats: createPlayerStats(),
		botLine: createBotLineState(),
		spotState: createPlayerSpotState(),
	};
}

function createGameState({ agentName, humanName, botCount, startingChips }) {
	const players = [createPlayer(AGENT_SEAT_INDEX, {
		name: agentName,
		isBot: false,
		startingChips,
	})];
	if (humanSeatEnabled) {
		players.push(createPlayer(players.length, {
			name: humanName ?? "Human",
			isBot: false,
			startingChips,
		}));
	}
	for (let index = 0; index < botCount; index++) {
		players.push(createPlayer(players.length, {
			name: `Bot ${index + 1}`,
			isBot: true,
			startingChips,
		}));
	}

	return {
		currentPhaseIndex: 0,
		currentBet: 0,
		pot: 0,
		activeSeatIndex: null,
		handId: 0,
		nextDecisionId: 1,
		blindLevel: 0,
		gameStarted: true,
		gameFinished: false,
		openCardsMode: false,
		spectatorMode: false,
		raisesThisRound: 0,
		handInProgress: false,
		deck: INITIAL_DECK.slice(),
		cardGraveyard: [],
		communityCards: [],
		players,
		allPlayers: players.slice(),
		chipTransfer: null,
		pendingAction: null,
		smallBlind: INITIAL_SMALL_BLIND,
		bigBlind: INITIAL_BIG_BLIND,
		lastRaise: INITIAL_BIG_BLIND,
		handContext: createHandContextState(),
	};
}

function postMessageToHost(message) {
	snapshotRevision += 1;
	self.postMessage({ ...message, revision: snapshotRevision });
}

// Whitelist projection of one player. Other players' hole cards are only included when the hand
// reached a showdown, where cards are public information in poker.
function buildPlayerView(player, { reveal = false } = {}) {
	const view = {
		seatIndex: player.seatIndex,
		name: player.name,
		chips: player.chips,
		roundBet: player.roundBet,
		totalBet: player.totalBet,
		folded: player.folded === true,
		allIn: player.allIn === true,
		dealer: player.dealer === true,
		smallBlind: player.smallBlind === true,
		bigBlind: player.bigBlind === true,
		isBot: player.isBot === true,
	};
	const isSelfSeat = player.seatIndex === AGENT_SEAT_INDEX ||
		(humanSeatEnabled && player.seatIndex === HUMAN_SEAT_INDEX);
	if (isSelfSeat || reveal) {
		view.holeCards = player.holeCards.slice();
	}
	return view;
}

function buildPlayersView({ reveal = false } = {}) {
	return gameState.players.map((player) => buildPlayerView(player, { reveal }));
}

function buildStateView({
	yourTurn = false,
	humanTurn = false,
	actionState = null,
	reveal = false,
	actorSeatIndex = null,
} = {}) {
	return {
		agentSeatIndex: AGENT_SEAT_INDEX,
		actorSeatIndex,
		handId: gameState.handId,
		phase: getCurrentPhase(gameState.currentPhaseIndex),
		communityCards: gameState.communityCards.slice(),
		pot: gameState.pot,
		currentBet: gameState.currentBet,
		lastRaise: gameState.lastRaise,
		raisesThisRound: gameState.raisesThisRound,
		smallBlind: gameState.smallBlind,
		bigBlind: gameState.bigBlind,
		blindLevel: gameState.blindLevel,
		gameFinished: gameState.gameFinished === true,
		players: buildPlayersView({ reveal }),
		actions: liveActions.slice(),
		yourTurn,
		humanTurn: humanTurn && humanSeatEnabled,
		actionState,
	};
}

// Posted before EVERY decision (bots included) so spectators see each action; yourTurn/humanTurn
// and actionState are only set for the remote seats (agent seat 0, human seat 1).
function postTurnSnapshot(player) {
	const isAgent = player.seatIndex === AGENT_SEAT_INDEX;
	const isHuman = humanSeatEnabled && player.seatIndex === HUMAN_SEAT_INDEX;
	const actionState = isAgent || isHuman ? getPlayerActionState(gameState, player) : null;
	postMessageToHost({
		type: "turn",
		state: buildStateView({
			yourTurn: isAgent,
			humanTurn: isHuman,
			actionState: actionState ? { ...actionState } : null,
			actorSeatIndex: player.seatIndex,
		}),
	});
}

function postHandResult(handResult) {
	const showdownResult = handResult.showdownResult;
	const hadShowdown = showdownResult.hadShowdown === true;
	postMessageToHost({
		type: "hand_result",
		handId: handResult.handId,
		state: {
			...buildStateView({ reveal: hadShowdown }),
			hadShowdown,
			totalPot: showdownResult.totalPot,
			potResults: showdownResult.potResults.map((potResult) => ({
				players: potResult.players.slice(),
				amount: potResult.amount,
				hand: potResult.hand,
				isRefundOnly: potResult.isRefundOnly === true,
			})),
			winners: showdownResult.winningPlayers.map((player) => ({
				name: player.name,
				seatIndex: player.seatIndex,
			})),
			payouts: Array.from(showdownResult.totalPayoutByPlayer.entries()).map((
				[player, amount],
			) => ({
				seatIndex: player.seatIndex,
				name: player.name,
				amount,
			})),
			bustedPlayers: gameState.players
				.filter((player) => player.chips <= 0)
				.map((player) => ({ name: player.name, seatIndex: player.seatIndex })),
			// Authoritative resolved actions for the finished hand, replacing the live preview list.
			actions: handResult.actions.map(({ phase, player, actionRequest, resolvedAction }) => ({
				phase,
				seatIndex: player.seatIndex,
				name: player.name,
				request: { action: actionRequest?.action ?? null, amount: actionRequest?.amount ?? null },
				resolved: {
					action: resolvedAction.action,
					amount: resolvedAction.amount,
				},
			})),
		},
	});
}

function postGameOver(champion, note = null) {
	postMessageToHost({
		type: "game_over",
		champion: champion ? { name: champion.name, seatIndex: champion.seatIndex } : null,
		note,
		state: buildStateView(),
	});
}

function postError(message, details = null) {
	postMessageToHost({ type: "error", message, details });
}

function recordAction(player, request, resolvedAction) {
	liveActions.push({
		phase: getCurrentPhase(gameState.currentPhaseIndex),
		seatIndex: player.seatIndex,
		name: player.name,
		request: { action: request.action, amount: request.amount ?? null },
		resolved: {
			action: resolvedAction.action,
			amount: resolvedAction.amount,
		},
	});
}

function chooseBotRequest(player) {
	const decision = chooseBotAction(player, gameState);
	const request = normalizeBotActionRequest(decision);
	if (request) {
		return request;
	}
	const actionState = getPlayerActionState(gameState, player);
	return actionState.canCheck ? { action: "check" } : { action: "fold" };
}

// Blocks the worker thread until the HTTP server writes a decision into the shared buffer. No timer
// is involved: the engine simply pauses here for as long as the agent thinks.
function awaitAgentDecision() {
	while (true) {
		Atomics.store(sab, SAB_ACTION_CODE, 0);
		Atomics.store(sab, SAB_TURN_FLAG, 1);
		// The host may have raced its decision in between the snapshot post and this store; the
		// compareExchange detects flag === 2 so the already-arrived decision never deadlocks.
		let wakeReason = "not-equal";
		if (Atomics.compareExchange(sab, SAB_TURN_FLAG, 1, 1) === 1) {
			wakeReason = Atomics.wait(sab, SAB_TURN_FLAG, 1, AGENT_WAIT_TIMEOUT_MS);
		}
		if (wakeReason === "ok" || wakeReason === "not-equal") {
			break;
		}
		if (Atomics.load(sab, SAB_ABORT_FLAG) === 1) {
			throw new Error("game-aborted");
		}
		// Spurious or timed-out wake on a still-pending turn: keep waiting. The 1h timeout only
		// exists so a dead host cannot leave the worker parked forever.
	}

	const code = Atomics.load(sab, SAB_ACTION_CODE);
	const amount = Atomics.load(sab, SAB_ACTION_AMOUNT);
	Atomics.store(sab, SAB_TURN_FLAG, 0);
	if (code === 0) {
		throw new Error("game-aborted");
	}

	const action = ACTION_NAMES[code];
	if (!action) {
		throw new Error(`invalid action code from host: ${code}`);
	}
	return { action, amount: action === "raise" ? amount : 0 };
}

// Re-runs the engine's own normalization so an out-of-range agent request can never reach the
// engine as an invalid action (which would abort the hand).
function normalizeAgentRequest(player, request) {
	const actionState = getPlayerActionState(gameState, player);
	switch (request.action) {
		case "fold":
			return { action: "fold" };
		case "check":
			return actionState.canCheck ? { action: "check" } : { action: "call" };
		case "call":
			return actionState.canCheck
				? { action: "check" }
				: getActionRequestForAmount(actionState.needToCall, actionState);
		case "allin":
			return { action: "allin" };
		case "raise": {
			const amount = Number.parseInt(request.amount, 10);
			const normalized = Number.isNaN(amount)
				? getActionRequestForAmount(actionState.minRaise, actionState)
				: getActionRequestForAmount(normalizeActionAmount(amount, actionState), actionState);
			return normalized;
		}
		default:
			return actionState.canCheck ? { action: "check" } : { action: "fold" };
	}
}

function actionProvider(_engineGameState, player) {
	postTurnSnapshot(player);
	const isRemoteSeat = player.seatIndex === AGENT_SEAT_INDEX ||
		(humanSeatEnabled && player.seatIndex === HUMAN_SEAT_INDEX);
	if (isRemoteSeat) {
		const decision = awaitAgentDecision();
		const request = normalizeAgentRequest(player, decision);
		const resolvedAction = resolveTurnAction(gameState, player, request);
		recordAction(player, request, resolvedAction ?? { action: request.action, amount: 0 });
		return request;
	}

	const request = chooseBotRequest(player);
	const resolvedAction = resolveTurnAction(gameState, player, request);
	recordAction(player, request, resolvedAction ?? { action: request.action, amount: 0 });
	return request;
}

function runTournament() {
	let handId = 1;
	while (handId <= MAX_HANDS) {
		const handResult = runEngineHand(gameState, actionProvider, {
			handId,
			maxSteps: MAX_STEPS_PER_HAND,
			dealerRandomValue: handId === 1 ? Math.random() : 0,
		});

		if (handResult.type === "game-over") {
			postGameOver(handResult.nextHandPlan?.champion ?? null);
			return;
		}
		if (handResult.type === "no-players") {
			postGameOver(null, "no-players");
			return;
		}
		if (handResult.type !== "showdown") {
			postError(`engine stopped hand with type "${handResult.type}"`, {
				type: handResult.type,
				invalidAction: handResult.invalidAction,
			});
			return;
		}

		postHandResult(handResult);
		liveActions = [];
		handId += 1;
	}

	postError(`tournament did not finish within ${MAX_HANDS} hands`);
}

function startGame(startConfig) {
	sab = new Int32Array(startConfig.sab);
	humanSeatEnabled = startConfig.humanSeat === true;
	gameState = createGameState(startConfig);
	try {
		runTournament();
	} catch (error) {
		if (error?.message === "game-aborted") {
			postMessageToHost({ type: "aborted" });
			return;
		}
		postError(`worker crashed: ${error?.stack ?? String(error)}`);
	}
}

self.onmessage = (event) => {
	if (event.data?.type === "start") {
		startGame(event.data);
	}
};
