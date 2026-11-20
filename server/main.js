/* ==================================================================================================
MODULE BOUNDARY: Agent Table API Server
================================================================================================== */

// CURRENT STATE: Deno HTTP server that hosts headless agent-vs-bots poker games. Each game runs in
// a worker that reuses the untouched pure engine; the agent seat is controlled over HTTP with
// long-polling instead of turn timers, so an agent can think as long as it wants. The server only
// ever serves worker-posted sanitized snapshots, so other players' hole cards and the deck never
// leave the worker process boundary.
// PUT HERE: Route handling, game registry, seat token checks, agent action validation/normalization,
// long-poll waiter management, and CORS. Agent-facing decision insights live in insights.js and are
// built only from sanitized views.
// DO NOT PUT HERE: Poker rules, bot decisions, or snapshot building (all live in the worker/engine).

import { getActionRequestForAmount, normalizeActionAmount } from "../js/shared/actionModel.js";
import { buildInsights, clampInsightSamples, DEFAULT_INSIGHT_SAMPLES } from "./insights.js";

const DEFAULT_PORT = 8899;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BOT_COUNT = 5;
const DEFAULT_STARTING_CHIPS = 2000;
const DEFAULT_AGENT_NAME = "Agent";
const DEFAULT_HUMAN_NAME = "Human";
const HUMAN_SEAT_INDEX = 1;
const MAX_BOT_COUNT = 8;
const MIN_STARTING_CHIPS = 100;
const MAX_STARTING_CHIPS = 1000000;
const DEFAULT_WAIT_TIMEOUT_MS = 600000;
const MAX_WAIT_TIMEOUT_MS = 3600000;
const MAX_STREAM_MESSAGES = 30000;
const MAX_AUDIT_ENTRIES = 5000;
const ACTION_FOLD = 1;
const ACTION_CHECK = 2;
const ACTION_CALL = 3;
const ACTION_RAISE = 4;
const ACTION_ALLIN = 5;
const SAB_TURN_FLAG = 0;
const SAB_ACTION_CODE = 1;
const SAB_ACTION_AMOUNT = 2;
const SAB_ABORT_FLAG = 3;

const games = new Map();

function parseServerArgs(args) {
	const config = { port: DEFAULT_PORT, host: DEFAULT_HOST };
	for (const arg of args) {
		if (arg.startsWith("--port=")) {
			const port = Number.parseInt(arg.slice(7), 10);
			if (!Number.isInteger(port) || port <= 0 || port > 65535) {
				throw new Error(`Invalid port: ${arg}`);
			}
			config.port = port;
		} else if (arg.startsWith("--host=")) {
			config.host = arg.slice(7);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return config;
}

function parseCreateGameBody(body) {
	const config = {
		agentName: DEFAULT_AGENT_NAME,
		botCount: DEFAULT_BOT_COUNT,
		startingChips: DEFAULT_STARTING_CHIPS,
		humanSeat: false,
		humanName: DEFAULT_HUMAN_NAME,
	};

	if (body.agentName !== undefined) {
		if (typeof body.agentName !== "string") {
			throw new RequestError("agentName must be a string");
		}
		const name = body.agentName.trim();
		if (name.length === 0 || name.length > 40) {
			throw new RequestError("agentName must be 1-40 characters");
		}
		config.agentName = name;
	}
	if (body.humanSeat !== undefined) {
		if (typeof body.humanSeat !== "boolean") {
			throw new RequestError("humanSeat must be a boolean");
		}
		config.humanSeat = body.humanSeat;
	}
	if (body.humanName !== undefined) {
		if (typeof body.humanName !== "string") {
			throw new RequestError("humanName must be a string");
		}
		const name = body.humanName.trim();
		if (name.length === 0 || name.length > 40) {
			throw new RequestError("humanName must be 1-40 characters");
		}
		config.humanName = name;
	}
	if (body.botCount !== undefined) {
		if (!Number.isInteger(body.botCount) || body.botCount < 0 || body.botCount > MAX_BOT_COUNT) {
			throw new RequestError(`botCount must be an integer in [0, ${MAX_BOT_COUNT}]`);
		}
		config.botCount = body.botCount;
	}
	if (config.botCount === 0 && !config.humanSeat) {
		throw new RequestError("botCount 0 requires humanSeat: true (agent + human heads-up table)");
	}
	if (body.startingChips !== undefined) {
		if (
			!Number.isInteger(body.startingChips) ||
			body.startingChips < MIN_STARTING_CHIPS ||
			body.startingChips > MAX_STARTING_CHIPS
		) {
			throw new RequestError(
				`startingChips must be an integer in [${MIN_STARTING_CHIPS}, ${MAX_STARTING_CHIPS}]`,
			);
		}
		config.startingChips = body.startingChips;
	}

	return config;
}

function parseWaitNumber(value, fallback, max) {
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return fallback;
	}
	return Math.min(parsed, max);
}

class RequestError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

function buildInitialSnapshot(config) {
	const players = [{
		seatIndex: 0,
		name: config.agentName,
		chips: config.startingChips,
		isBot: false,
	}];
	if (config.humanSeat) {
		players.push({
			seatIndex: HUMAN_SEAT_INDEX,
			name: config.humanName,
			chips: config.startingChips,
			isBot: false,
		});
	}
	for (let index = 0; index < config.botCount; index++) {
		players.push({
			seatIndex: players.length,
			name: `Bot ${index + 1}`,
			chips: config.startingChips,
			isBot: true,
		});
	}

	return {
		agentSeatIndex: 0,
		handId: 0,
		phase: null,
		communityCards: [],
		pot: 0,
		currentBet: 0,
		lastRaise: 20,
		raisesThisRound: 0,
		smallBlind: 10,
		bigBlind: 20,
		blindLevel: 0,
		gameFinished: false,
		players,
		actions: [],
		yourTurn: false,
		actionState: null,
	};
}

function createGame(config) {
	const gameId = crypto.randomUUID();
	const seatToken = crypto.randomUUID();
	const humanSeatToken = config.humanSeat ? crypto.randomUUID() : null;
	const sabBuffer = new SharedArrayBuffer(16);
	const game = {
		id: gameId,
		seatToken,
		humanSeatToken,
		config,
		sab: new Int32Array(sabBuffer),
		messages: [{
			revision: 0,
			type: "snapshot",
			state: buildInitialSnapshot(config),
		}],
		pendingTurn: null,
		turnInFlight: false,
		status: "running",
		champion: null,
		errorMessage: null,
		handResults: [],
		// Audit trail for /report: every insights call and every submitted decision, per seat.
		// Only public numbers and action metadata are stored; no cards beyond the agent's own view.
		insightsCalls: [],
		decisionLog: [],
		agentPlacement: null,
		agentFinalChips: null,
		waiters: new Set(),
		createdAt: new Date().toISOString(),
	};

	game.worker = new Worker(new URL("./agentWorker.js", import.meta.url), { type: "module" });
	game.worker.onmessage = (event) => handleWorkerMessage(game, event.data);
	game.worker.onerror = (event) => {
		setGameError(game, `worker error: ${event.message ?? "unknown"}`);
	};
	game.worker.postMessage({
		type: "start",
		sab: sabBuffer,
		agentName: config.agentName,
		botCount: config.botCount,
		startingChips: config.startingChips,
		humanSeat: config.humanSeat,
		humanName: config.humanName,
	});

	games.set(gameId, game);
	return game;
}

function handleWorkerMessage(game, message) {
	console.log(
		`MSG game=${
			game.id.slice(0, 8)
		} rev=${message.revision} type=${message.type} yourTurn=${message.state?.yourTurn}`,
	);
	game.messages.push(message);
	if (game.messages.length > MAX_STREAM_MESSAGES) {
		// Bound memory on very long games; clients walking old revisions just resume from newer ones.
		game.messages.splice(0, game.messages.length - MAX_STREAM_MESSAGES);
	}
	if (message.type === "hand_result") {
		game.handResults.push(message);
		trackHandResult(game, message);
	}

	if (message.type === "turn") {
		// Remote seats (agent at 0, human at 1) create pending decisions; bot turns exist only for
		// the spectator stream.
		const pendingSeatIndex = message.state?.yourTurn === true
			? 0
			: message.state?.humanTurn === true
			? message.state.actorSeatIndex
			: null;
		if (pendingSeatIndex !== null && pendingSeatIndex !== undefined) {
			game.pendingTurn = {
				revision: message.revision,
				actionState: message.state?.actionState ?? null,
				seatIndex: pendingSeatIndex,
			};
			game.turnInFlight = false;
		}
	} else if (message.type === "hand_result") {
		game.pendingTurn = null;
		game.turnInFlight = false;
	} else if (message.type === "game_over") {
		game.pendingTurn = null;
		game.turnInFlight = false;
		game.status = "finished";
		game.champion = message.champion ?? null;
		trackGameOver(game, message);
	} else if (message.type === "error") {
		game.pendingTurn = null;
		game.turnInFlight = false;
		game.status = "error";
		game.errorMessage = message.message ?? "unknown worker error";
	} else if (message.type === "aborted") {
		game.pendingTurn = null;
		game.turnInFlight = false;
		game.status = "aborted";
	}

	notifyWaiters(game);
}

function notifyWaiters(game) {
	for (const waiter of game.waiters) {
		const matching = findMessageAfter(game, waiter.since);
		if (matching || game.status !== "running") {
			game.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve({ message: matching, timedOut: false });
		}
	}
}

function findMessageAfter(game, since) {
	// Sequential delivery: the first message after `since`, so long-poll consumers walking
	// revision by revision never miss intermediate messages (e.g. hand_result).
	for (const message of game.messages) {
		if (message.revision > since) {
			return message;
		}
	}
	return null;
}

function setGameError(game, message) {
	game.pendingTurn = null;
	game.turnInFlight = false;
	game.status = "error";
	game.errorMessage = message;
	notifyWaiters(game);
}

function getGame(gameId) {
	const game = games.get(gameId);
	if (!game) {
		throw new RequestError("Unknown game id", 404);
	}
	return game;
}

function requireToken(game, token) {
	if (!token || (token !== game.seatToken && token !== game.humanSeatToken)) {
		throw new RequestError("Invalid or missing seat token", 401);
	}
}

// Which seat a token controls: agent token → 0, human token → 1, anything else → null.
function resolveSeatForToken(game, token) {
	if (!token) {
		return null;
	}
	if (token === game.seatToken) {
		return 0;
	}
	if (game.humanSeatToken && token === game.humanSeatToken) {
		return HUMAN_SEAT_INDEX;
	}
	return null;
}

function getLatestState(game) {
	return game.messages[game.messages.length - 1]?.state ?? null;
}

function round1(value) {
	return Math.round(value * 10) / 10;
}

function trackHandResult(game, message) {
	const state = message.state ?? {};
	const busted = state.bustedPlayers ?? [];
	const me = (state.players ?? []).find((player) => player.seatIndex === 0);
	game.agentFinalChips = me ? (me.chips ?? 0) : 0;
	if (busted.some((player) => player.seatIndex === 0) && game.agentPlacement === null) {
		const bustedSeats = new Set(busted.map((player) => player.seatIndex));
		const remaining = (state.players ?? []).filter((player) =>
			!bustedSeats.has(player.seatIndex) && (player.chips ?? 0) > 0
		).length;
		game.agentPlacement = Math.max(1, remaining + 1);
	}
}

function trackGameOver(game, message) {
	if (message.champion?.seatIndex === 0) {
		game.agentPlacement = 1;
		const me = (message.state?.players ?? []).find((player) => player.seatIndex === 0);
		game.agentFinalChips = me ? (me.chips ?? 0) : null;
	}
}

function recordInsightsCall(game, seatIndex, payload) {
	const latest = game.messages[game.messages.length - 1];
	game.insightsCalls.push({
		at: new Date().toISOString(),
		// Revision of the newest state when the tool was called. A decision is "covered" when an
		// insights call exists at or after its turn snapshot.
		revision: latest?.revision ?? 0,
		seatIndex,
		handId: payload.handId ?? null,
		phase: payload.phase ?? null,
		equityPct: payload.equity?.equityPct ?? null,
		vsRangePct: payload.equity?.vsRangePct ?? null,
		callBreakevenEquityPct: payload.economics?.callBreakevenEquityPct ?? null,
		potOddsPct: payload.economics?.potOddsPct ?? null,
		mRatio: payload.economics?.mRatio ?? null,
		shoveRangeEquityPct: payload.shove?.rangeEquityPct ?? null,
		shoveBreakevenPct: payload.shove?.callBreakevenEquityPct ?? null,
		preflopSuggestedAction: payload.preflop?.suggestedAction ?? null,
	});
	if (game.insightsCalls.length > MAX_AUDIT_ENTRIES) {
		game.insightsCalls.splice(0, game.insightsCalls.length - MAX_AUDIT_ENTRIES);
	}
}

function findInsightsForTurn(game, seatIndex, turnRevision) {
	for (let index = game.insightsCalls.length - 1; index >= 0; index--) {
		const call = game.insightsCalls[index];
		if (call.seatIndex === seatIndex && call.revision >= turnRevision) {
			return call;
		}
	}
	return null;
}

function recordDecision(game, seatIndex, turn, request, submittedBody) {
	const matching = findInsightsForTurn(game, seatIndex, turn.revision);
	const state = getLatestState(game);
	game.decisionLog.push({
		at: new Date().toISOString(),
		revision: turn.revision,
		seatIndex,
		handId: state?.handId ?? null,
		phase: state?.phase ?? null,
		action: request.action,
		amount: request.amount ?? null,
		submittedAction: submittedBody.action ?? null,
		submittedAmount: submittedBody.amount ?? null,
		hadInsights: matching !== null,
		insights: matching
			? {
				equityPct: matching.equityPct,
				vsRangePct: matching.vsRangePct,
				callBreakevenEquityPct: matching.callBreakevenEquityPct,
				potOddsPct: matching.potOddsPct,
				mRatio: matching.mRatio,
				shoveRangeEquityPct: matching.shoveRangeEquityPct,
				shoveBreakevenPct: matching.shoveBreakevenPct,
				preflopSuggestedAction: matching.preflopSuggestedAction,
			}
			: null,
	});
	if (game.decisionLog.length > MAX_AUDIT_ENTRIES) {
		game.decisionLog.splice(0, game.decisionLog.length - MAX_AUDIT_ENTRIES);
	}
}

function auditDecision(entry) {
	const flags = [];
	const insights = entry.insights;
	if (!insights || entry.action !== "call") {
		return flags;
	}
	if (insights.shoveRangeEquityPct !== null && insights.shoveBreakevenPct !== null) {
		if (insights.shoveRangeEquityPct < insights.shoveBreakevenPct + 5) {
			flags.push("call_below_shove_range_rule");
		}
		return flags;
	}
	const equity = insights.vsRangePct ?? insights.equityPct;
	if (
		equity !== null &&
		insights.callBreakevenEquityPct !== null &&
		equity + 1 < insights.callBreakevenEquityPct
	) {
		flags.push("call_below_breakeven_equity");
	}
	return flags;
}

function buildReport(game, seatIndex) {
	const decisions = game.decisionLog.filter((entry) => entry.seatIndex === seatIndex);
	const insightsCalls = game.insightsCalls.filter((call) => call.seatIndex === seatIndex);
	const flagCounts = {};
	const violations = [];
	for (const decision of decisions) {
		const flags = auditDecision(decision);
		if (flags.length === 0) {
			continue;
		}
		for (const flag of flags) {
			flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
		}
		if (violations.length < 100) {
			violations.push({
				handId: decision.handId,
				phase: decision.phase,
				action: decision.action,
				amount: decision.amount,
				flags,
				insights: decision.insights,
			});
		}
	}

	const hands = [];
	let previousChips = game.config.startingChips;
	for (const hand of game.handResults) {
		const state = hand.state ?? {};
		const me = (state.players ?? []).find((player) => player.seatIndex === seatIndex);
		const busted = (state.bustedPlayers ?? []).some((player) => player.seatIndex === seatIndex);
		const chipsAfter = me ? (me.chips ?? 0) : 0;
		hands.push({
			handId: hand.handId ?? state.handId ?? null,
			board: state.communityCards ?? [],
			totalPot: state.totalPot ?? null,
			winners: (state.winners ?? []).map((winner) => winner.name),
			hadShowdown: state.hadShowdown === true,
			seatDelta: chipsAfter - previousChips,
			seatChipsAfter: chipsAfter,
			seatBusted: busted,
		});
		previousChips = chipsAfter;
	}

	const latestState = getLatestState(game);
	const latestPlayer = (latestState?.players ?? []).find((player) => player.seatIndex === seatIndex);
	const currentChips = latestPlayer ? (latestPlayer.chips ?? 0) : 0;
	const finalChips = seatIndex === 0 && game.agentFinalChips !== null ? game.agentFinalChips : currentChips;
	const placement = game.champion?.seatIndex === seatIndex ? 1 : seatIndex === 0 ? game.agentPlacement : null;
	const covered = decisions.filter((entry) => entry.hadInsights).length;

	return {
		ok: true,
		gameId: game.id,
		status: game.status,
		champion: game.champion,
		seatIndex,
		handsPlayed: game.handResults.length,
		startingChips: game.config.startingChips,
		finalChips,
		netChips: finalChips - game.config.startingChips,
		placement,
		decisions: {
			total: decisions.length,
			withInsights: covered,
			coveragePct: decisions.length > 0 ? round1((covered / decisions.length) * 100) : null,
		},
		insightsCalls: insightsCalls.length,
		flagCounts,
		violations,
		hands,
		// Compact decision trail for post-game review; the full stream remains available via
		// /history. Capped so a 1000-turn game cannot blow up the response.
		decisionLog: decisions.slice(-200).map((entry) => ({
			handId: entry.handId,
			phase: entry.phase,
			action: entry.action,
			amount: entry.amount,
			hadInsights: entry.hadInsights,
			equityPct: entry.insights?.equityPct ?? null,
			vsRangePct: entry.insights?.vsRangePct ?? null,
			callBreakevenEquityPct: entry.insights?.callBreakevenEquityPct ?? null,
			shoveRangeEquityPct: entry.insights?.shoveRangeEquityPct ?? null,
			shoveBreakevenPct: entry.insights?.shoveBreakevenPct ?? null,
		})),
	};
}

function buildStateResponse(game, deliveredMessage = null) {
	const latest = game.messages[game.messages.length - 1];
	// For long-poll deliveries the response must describe THE DELIVERED message: a bot turn in a
	// burst must not claim yourTurn just because the next agent turn is already pending. yourTurn
	// stays exclusive to the agent seat (seat 0); the human seat is signalled inside the state.
	const responseYourTurn = deliveredMessage
		? deliveredMessage.type === "turn" && deliveredMessage.state?.yourTurn === true
		: game.pendingTurn !== null && game.pendingTurn.seatIndex === 0 && game.status === "running";
	return {
		gameId: game.id,
		status: game.status,
		errorMessage: game.errorMessage,
		champion: game.champion,
		// Revision of the message this response describes; consumers pass it back as `since`.
		revision: deliveredMessage?.revision ?? latest?.revision ?? 0,
		messageType: deliveredMessage?.type ?? latest?.type ?? null,
		yourTurn: responseYourTurn,
		awaitingAction: game.turnInFlight === true,
		state: deliveredMessage?.state ?? getLatestState(game),
	};
}

// Token-scoped hole-card visibility for human-seat games. Showdown reveals are public; everything
// else hides each remote seat's cards from every viewer except that seat's own token. Regular
// games (no humanSeat) keep the historical behavior: the agent's cards are visible to its token
// and to the spectator page it was shared with.
function scopeStateForToken(state, game, token) {
	if (!state || !game.humanSeatToken || state.hadShowdown === true) {
		return state;
	}
	const viewerSeat = resolveSeatForToken(game, token);
	const hiddenSeats = new Set();
	if (viewerSeat !== 0) {
		hiddenSeats.add(0);
	}
	if (viewerSeat !== HUMAN_SEAT_INDEX) {
		hiddenSeats.add(HUMAN_SEAT_INDEX);
	}
	if (hiddenSeats.size === 0) {
		return state;
	}
	return {
		...state,
		players: state.players.map((player) =>
			hiddenSeats.has(player.seatIndex) ? { ...player, holeCards: undefined } : player
		),
	};
}

function waitForMessage(game, since, timeoutMs) {
	const existing = findMessageAfter(game, since);
	if (existing) {
		return Promise.resolve({ message: existing, timedOut: false });
	}
	// A game that is no longer running will never produce a new message; wake immediately.
	if (game.status !== "running") {
		return Promise.resolve({ message: null, timedOut: false });
	}

	return new Promise((resolve) => {
		const waiter = {
			since,
			resolve,
			timer: null,
		};
		waiter.timer = setTimeout(() => {
			game.waiters.delete(waiter);
			resolve({ message: null, timedOut: true });
		}, timeoutMs);
		game.waiters.add(waiter);
	});
}

function buildSubmittedAction(actionState, action, amount) {
	switch (action) {
		case "fold":
			return { request: { action: "fold" }, code: ACTION_FOLD };
		case "check":
			if (!actionState.canCheck) {
				throw new RequestError(
					`cannot check: needToCall is ${actionState.needToCall}, use call/raise/fold/allin`,
				);
			}
			return { request: { action: "check" }, code: ACTION_CHECK };
		case "call":
			if (actionState.canCheck) {
				// Checking is free; a call request with nothing to call is normalized to a check.
				return { request: { action: "check" }, code: ACTION_CHECK };
			}
			return {
				request: { action: "call", amount: actionState.needToCall },
				code: ACTION_CALL,
			};
		case "allin":
			return { request: { action: "allin" }, code: ACTION_ALLIN };
		case "raise": {
			const parsedAmount = Number.parseInt(amount, 10);
			if (Number.isNaN(parsedAmount)) {
				throw new RequestError(
					`raise requires an integer "amount" (additional chips beyond your current roundBet); ` +
						`legal range [${actionState.minRaise}, ${actionState.maxRaiseAmount}], ` +
						`amount >= ${actionState.maxAmount} means all-in`,
				);
			}
			const normalizedAmount = normalizeActionAmount(parsedAmount, actionState);
			const request = getActionRequestForAmount(normalizedAmount, actionState);
			if (request.action === "check") {
				return { request, code: ACTION_CHECK };
			}
			if (request.action === "call") {
				return { request, code: ACTION_CALL };
			}
			if (request.action === "allin") {
				return { request, code: ACTION_ALLIN };
			}
			return { request, code: ACTION_RAISE };
		}
		default:
			throw new RequestError(`unknown action "${action}"`);
	}
}

function submitAction(game, body, seatIndex) {
	if (game.status !== "running") {
		throw new RequestError(`game is ${game.status}, no action possible`, 409);
	}
	if (game.turnInFlight) {
		throw new RequestError("action already submitted for this turn", 409);
	}
	if (!game.pendingTurn) {
		throw new RequestError("it is not your turn", 409);
	}
	if (game.pendingTurn.seatIndex !== seatIndex) {
		throw new RequestError("it is not this seat's turn", 409);
	}
	// Optional optimistic-concurrency guard: the agent echoes the revision of the turn snapshot it
	// decided on. A mismatch means the turn was already acted on or has advanced.
	if (
		body.turnRevision !== undefined &&
		body.turnRevision !== game.pendingTurn.revision
	) {
		throw new RequestError(
			`turn revision mismatch: acting on ${body.turnRevision}, current turn is ${game.pendingTurn.revision}`,
			409,
		);
	}

	const actionState = game.pendingTurn.actionState;
	if (!actionState) {
		throw new RequestError("no action state available", 409);
	}

	const { request, code } = buildSubmittedAction(actionState, body.action, body.amount);
	// Audit before clearing pendingTurn: the turn revision links this decision to the insights call
	// that preceded it.
	recordDecision(game, seatIndex, game.pendingTurn, request, body);

	console.log(
		`ACT game=${game.id.slice(0, 8)} seat=${seatIndex} action=${body.action} amount=${
			body.amount ?? "-"
		} -> code=${code}`,
	);
	game.sab[SAB_ACTION_AMOUNT] = request.action === "raise" ? request.amount : 0;
	game.sab[SAB_ACTION_CODE] = code;
	game.sab[SAB_TURN_FLAG] = 2;
	Atomics.notify(game.sab, SAB_TURN_FLAG);
	game.pendingTurn = null;
	game.turnInFlight = true;

	return {
		accepted: true,
		submitted: { action: body.action, amount: body.amount ?? null },
		normalized: request,
		nextSince: game.messages[game.messages.length - 1]?.revision ?? 0,
	};
}

function abortGame(game) {
	if (game.status === "running") {
		game.sab[SAB_ABORT_FLAG] = 1;
		game.sab[SAB_ACTION_CODE] = 0;
		game.sab[SAB_TURN_FLAG] = 2;
		Atomics.notify(game.sab, SAB_TURN_FLAG);
		setGameError(game, null);
		game.status = "aborted";
	}
	try {
		game.worker?.terminate();
	} catch {
		// Worker may already be gone.
	}
}

function json_response(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function error_response(message, status) {
	return json_response({ error: message }, status);
}

function readJsonBody(request) {
	return request.json().catch(() => {
		throw new RequestError("request body must be valid JSON");
	});
}

function getQueryInt(url, name, fallback) {
	const raw = url.searchParams.get(name);
	if (raw === null) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

// Whitelisted static prefixes for the spectator page (original stylesheet + card/icon artwork).
// Only these asset directories are served; `js/` (engine and bot strategy) is never exposed.
const STATIC_PREFIXES = new Map([
	["/css/", "css/"],
	["/cards/", "cards/"],
	["/icons/", "icons/"],
]);
const STATIC_CONTENT_TYPES = new Map([
	[".css", "text/css; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
]);

function serveStaticAsset(pathname) {
	for (const [prefix, directory] of STATIC_PREFIXES) {
		if (!pathname.startsWith(prefix)) {
			continue;
		}
		const relative = pathname.slice(prefix.length);
		if (!relative || relative.includes("/") || relative.includes("\\") || relative.includes("..")) {
			return error_response("Not found", 404);
		}
		const contentType = STATIC_CONTENT_TYPES.get(relative.slice(relative.lastIndexOf(".")));
		if (!contentType) {
			return error_response("Not found", 404);
		}
		return Deno.readFile(new URL(`../${directory}${relative}`, import.meta.url))
			.then((bytes) =>
				new Response(bytes, {
					status: 200,
					headers: {
						"Content-Type": contentType,
						"Cache-Control": "public, max-age=3600",
					},
				})
			)
			.catch(() => error_response("Not found", 404));
	}
	return null;
}

async function handleRequest(request) {
	const url = new URL(request.url);
	const path = url.pathname;

	if (request.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			},
		});
	}

	if (path === "/health" && request.method === "GET") {
		return json_response({ ok: true, games: games.size });
	}

	if (request.method === "GET") {
		const staticResponse = serveStaticAsset(path);
		if (staticResponse) {
			return staticResponse;
		}
	}

	if (path === "/watch" && request.method === "GET") {
		const html = await Deno.readTextFile(
			new URL("./watch.html", import.meta.url),
		);
		return new Response(html, {
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
			},
		});
	}

	if (path === "/games" && request.method === "POST") {
		const body = request.headers.get("content-length") === "0" || !request.headers.get("content-type")
			? {}
			: await readJsonBody(request);
		const config = parseCreateGameBody(body ?? {});
		const game = createGame(config);
		return json_response({
			gameId: game.id,
			seatToken: game.seatToken,
			humanSeatToken: game.humanSeatToken,
			seatIndex: 0,
			config: game.config,
			revision: 0,
			state: getLatestState(game),
		});
	}

	if (path === "/games" && request.method === "GET") {
		return json_response({
			games: Array.from(games.values()).map((game) => ({
				gameId: game.id,
				status: game.status,
				createdAt: game.createdAt,
				config: game.config,
				champion: game.champion,
				seatToken: game.seatToken,
				humanSeatToken: game.humanSeatToken,
				watchUrl: `/watch?game=${game.id}&token=${game.seatToken}`,
				humanSeatUrl: game.humanSeatToken ? `/watch?game=${game.id}&token=${game.humanSeatToken}` : null,
			})),
		});
	}

	const gameMatch = path.match(/^\/games\/([0-9a-f-]+)(\/(state|action|history|insights|report))?$/);
	if (gameMatch) {
		const game = getGame(gameMatch[1]);
		const sub = gameMatch[3] ?? null;

		if (sub === null && request.method === "DELETE") {
			abortGame(game);
			return json_response({ aborted: true, gameId: game.id });
		}

		if (sub === "state" && request.method === "GET") {
			const token = url.searchParams.get("token");
			requireToken(game, token);
			const since = getQueryInt(url, "since", null);
			const wait = url.searchParams.get("wait") === "1";
			let deliveredMessage = null;
			let timedOut = false;
			if (wait && since !== null) {
				const timeoutMs = parseWaitNumber(
					url.searchParams.get("waitTimeout"),
					DEFAULT_WAIT_TIMEOUT_MS,
					MAX_WAIT_TIMEOUT_MS,
				);
				const waitResult = await waitForMessage(game, since, timeoutMs);
				deliveredMessage = waitResult.message;
				timedOut = waitResult.timedOut;
			}
			const response = buildStateResponse(game, deliveredMessage);
			if (wait && timedOut) {
				response.waitTimedOut = true;
			}
			response.state = scopeStateForToken(response.state, game, token);
			return json_response(response);
		}

		if (sub === "action" && request.method === "POST") {
			const body = await readJsonBody(request);
			const seatIndex = resolveSeatForToken(game, body?.token);
			if (seatIndex === null) {
				throw new RequestError("Invalid or missing seat token", 401);
			}
			const result = submitAction(game, body ?? {}, seatIndex);
			return json_response(result);
		}

		if (sub === "history" && request.method === "GET") {
			const token = url.searchParams.get("token");
			requireToken(game, token);
			return json_response({
				gameId: game.id,
				status: game.status,
				champion: game.champion,
				hands: game.handResults.map((hand) => ({
					...hand,
					state: scopeStateForToken(hand.state, game, token),
				})),
			});
		}

		if (sub === "insights" && request.method === "GET") {
			const token = url.searchParams.get("token");
			requireToken(game, token);
			const samples = clampInsightSamples(
				getQueryInt(url, "samples", DEFAULT_INSIGHT_SAMPLES),
			);
			const seatIndex = resolveSeatForToken(game, token) ?? 0;
			// Built exclusively from sanitized state views + the hand_result stream; the equity
			// estimator samples hypothetical hands from the public unseen pool and never touches
			// the engine deck or opponents' actual holdings. Both remote seats may call it — the
			// perspective (equity, reads) is always the CALLING seat's own public information.
			const insights = buildInsights({
				state: getLatestState(game),
				handResults: game.handResults,
				agentSeatIndex: seatIndex,
				samples,
			});
			recordInsightsCall(game, seatIndex, insights);
			return json_response(insights);
		}

		if (sub === "report" && request.method === "GET") {
			const token = url.searchParams.get("token");
			requireToken(game, token);
			const seatIndex = resolveSeatForToken(game, token) ?? 0;
			return json_response(buildReport(game, seatIndex));
		}

		throw new RequestError("Unsupported method or path", 405);
	}

	throw new RequestError("Not found", 404);
}

async function main() {
	const serverConfig = parseServerArgs(Deno.args);
	const server = Deno.serve({ port: serverConfig.port, hostname: serverConfig.host }, async (
		request,
	) => {
		try {
			return await handleRequest(request);
		} catch (error) {
			if (error instanceof RequestError) {
				return error_response(error.message, error.status);
			}
			console.error("unhandled request error:", error);
			return error_response("internal server error", 500);
		}
	});

	console.log(`Agent poker API listening on http://${serverConfig.host}:${serverConfig.port}`);
	console.log("POST /games to create a game. See server/README.md for the API.");

	await server.finished;
}

await main();
