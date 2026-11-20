/* ==================================================================================================
MODULE BOUNDARY: Agent Insights Builder
================================================================================================== */

// CURRENT STATE: Decision-support numbers for the agent seat, computed from ALREADY-SANITIZED
// projections: the latest state view (agent hole cards included, opponent cards never present)
// plus the game's hand_result stream (showdown reveals are public information). Equity goes
// through js/botEquity.js, which by construction cannot see the engine deck or opponents' actual
// holdings: hypothetical opponent hands are sampled from the public unseen-card pool derived
// from the agent's hole cards plus the community cards — the same information a human player
// reasons from. No input to this module ever contains another player's hole cards.
// PUT HERE: Pot-odds/SPR/M-ratio economics, seat-position classification, per-opponent reads
// built from public action history, and equity assembly.
// DO NOT PUT HERE: gameState/worker access, deck or graveyard reads, HTTP routing, or any
// projection of hidden information.

import { estimatePublicEquity, estimateRangeEquity, getHandPercentile } from "../js/botEquity.js";
import { Hand } from "../js/pokersolver.js";

export const DEFAULT_INSIGHT_SAMPLES = 1000;
export const MIN_INSIGHT_SAMPLES = 200;
export const MAX_INSIGHT_SAMPLES = 25000;
const HANDS_PER_BLIND_LEVEL = 6;
// Range sampling is a second Monte Carlo pass. Cap it below the random-equity cap so an agent
// asking for 25000 samples does not pay for two full runs on every turn.
const MAX_RANGE_SAMPLES = 8000;
const FULL_DECK = (() => {
	const deck = [];
	for (const rank of "23456789TJQKA") {
		for (const suit of "CDHS") {
			deck.push(rank + suit);
		}
	}
	return deck;
})();

const OPEN_RANGE_BY_SEAT = {
	early: 15,
	middle: 19,
	cutoff: 26,
	button: 42,
	smallBlind: 38,
	bigBlind: 0,
};
const CALL_RANGE_BY_SEAT = {
	early: 5,
	middle: 7,
	cutoff: 10,
	button: 14,
	smallBlind: 8,
	bigBlind: 15,
};
const THREE_BET_RANGE_BY_SEAT = {
	early: 6,
	middle: 7,
	cutoff: 8,
	button: 9,
	smallBlind: 8,
	bigBlind: 7,
};
const FOUR_BET_RANGE_BY_SEAT = {
	early: 3,
	middle: 3,
	cutoff: 3.5,
	button: 4,
	smallBlind: 3.5,
	bigBlind: 3,
};
const CALL_THREE_BET_RANGE_BY_SEAT = {
	early: 2.5,
	middle: 3,
	cutoff: 4,
	button: 5,
	smallBlind: 4,
	bigBlind: 4,
};
const CALL_SHOVE_RANGE_BY_DEPTH = {
	deep: 10,
	medium: 15,
	short: 22,
	critical: 35,
};
const PUSH_RANGE_BY_DEPTH = {
	dead: { early: 30, middle: 36, cutoff: 44, button: 58, smallBlind: 52, bigBlind: 40 },
	short: { early: 20, middle: 24, cutoff: 30, button: 42, smallBlind: 38, bigBlind: 28 },
	medium: { early: 14, middle: 17, cutoff: 22, button: 32, smallBlind: 28, bigBlind: 20 },
};
const DRAW_CACHE_CAPACITY = 128;
const drawCache = new Map();
const percentileCache = new Map();

export function clampInsightSamples(value) {
	if (!Number.isInteger(value) || value <= 0) {
		return DEFAULT_INSIGHT_SAMPLES;
	}
	return Math.max(MIN_INSIGHT_SAMPLES, Math.min(MAX_INSIGHT_SAMPLES, value));
}

function round1(value) {
	return Math.round(value * 10) / 10;
}

function roundPct(value) {
	return Math.round(value * 1000) / 10;
}

function getAgentPlayer(state) {
	const agentSeatIndex = state.agentSeatIndex ?? 0;
	return (state.players ?? []).find((player) => player.seatIndex === agentSeatIndex) ?? null;
}

function normalizeCard(card) {
	return card.length === 2 ? card[0] + card[1].toUpperCase() : card;
}

function cardRank(card) {
	return "23456789TJQKA".indexOf(card[0].toUpperCase());
}

function cardSuit(card) {
	return card[1].toUpperCase();
}

function describeHoleCards(holeCards) {
	if (!Array.isArray(holeCards) || holeCards.length !== 2 || !holeCards.every(Boolean)) {
		return null;
	}
	const [first, second] = holeCards.map(normalizeCard);
	const order = "23456789TJQKA";
	const [high, low] = order.indexOf(first[0]) >= order.indexOf(second[0]) ? [first, second] : [second, first];
	if (high[0] === low[0]) {
		return `${high[0]}${low[0]}`;
	}
	return `${high[0]}${low[0]}${high[1] === low[1] ? "s" : "o"}`;
}

function getHandPercentileCached(holeCards) {
	const key = holeCards.map(normalizeCard).sort().join("");
	if (percentileCache.has(key)) {
		return percentileCache.get(key);
	}
	const value = getHandPercentile(holeCards);
	percentileCache.set(key, value);
	return value;
}

// Mirrors js/shared/actionModel.js getPlayerActionState, using the sanitized projection because
// insights never receives the engine gameState. When the turn snapshot carries actionState, that
// authoritative copy wins.
function buildActionState(state, agent) {
	if (state.actionState) {
		return { ...state.actionState };
	}
	const needToCall = Math.max(0, (state.currentBet ?? 0) - (agent.roundBet ?? 0));
	const minAmount = state.phase !== "preflop" && (state.currentBet ?? 0) === 0
		? 0
		: Math.min(needToCall, agent.chips ?? 0);
	const maxAmount = agent.chips ?? 0;
	const minRaise = needToCall + (state.lastRaise ?? state.bigBlind ?? 0);
	let maxOpponentTotal = 0;
	for (const player of state.players ?? []) {
		if (
			player.seatIndex === agent.seatIndex ||
			player.folded ||
			player.allIn ||
			(player.chips ?? 0) <= 0
		) {
			continue;
		}
		maxOpponentTotal = Math.max(maxOpponentTotal, (player.roundBet ?? 0) + (player.chips ?? 0));
	}
	const effectiveRaiseCap = Math.max(0, maxOpponentTotal - (agent.roundBet ?? 0));
	const maxRaiseAmount = Math.min(maxAmount, Math.max(minRaise, effectiveRaiseCap));
	return {
		needToCall,
		minAmount,
		maxAmount,
		minRaise,
		maxRaiseAmount,
		canCheck: needToCall === 0,
	};
}

function countPreflopRaises(state) {
	return (state.actions ?? []).filter((action) =>
		action.phase === "preflop" &&
		(action.resolved?.action === "raise" || action.resolved?.action === "allin")
	).length;
}

function countPreflopCalls(state) {
	return (state.actions ?? []).filter((action) => action.phase === "preflop" && action.resolved?.action === "call")
		.length;
}

function hasLiveOpponentAllIn(state, agent) {
	return (state.players ?? []).some((player) =>
		player.seatIndex !== agent.seatIndex && player.folded !== true && player.allIn === true
	);
}

// Last public aggressive action this hand. Used to give the aggressor a tighter range than cold
// callers; no hidden information is involved.
function findLastAggressorSeat(state) {
	let aggressor = null;
	for (const action of state.actions ?? []) {
		if (action.resolved?.action === "raise" || action.resolved?.action === "allin") {
			aggressor = action.seatIndex;
		}
	}
	return aggressor;
}

function detectPreflopSpot(state, agent) {
	const needToCall = Math.max(0, (state.currentBet ?? 0) - (agent.roundBet ?? 0));
	const raises = countPreflopRaises(state);
	const calls = countPreflopCalls(state);
	if (hasLiveOpponentAllIn(state, agent) && needToCall > 0) {
		return "facingAllIn";
	}
	if (raises >= 2) {
		return "facing3Bet";
	}
	if (raises === 1) {
		return "facingRaise";
	}
	if (calls > 0) {
		return "facingLimp";
	}
	return needToCall === 0 ? "unopenedCheck" : "unopened";
}

function isShortStack(mRatio) {
	return Number.isFinite(mRatio) && mRatio <= 8;
}

function getPushRangePct(seatClass, mRatio) {
	if (mRatio <= 3) {
		return PUSH_RANGE_BY_DEPTH.dead[seatClass] ?? 20;
	}
	if (mRatio <= 5) {
		return PUSH_RANGE_BY_DEPTH.short[seatClass] ?? 18;
	}
	if (mRatio <= 8) {
		return PUSH_RANGE_BY_DEPTH.medium[seatClass] ?? 14;
	}
	return null;
}

function getCallShoveRangePct(mRatio) {
	if (mRatio <= 3) {
		return CALL_SHOVE_RANGE_BY_DEPTH.critical;
	}
	if (mRatio <= 6) {
		return CALL_SHOVE_RANGE_BY_DEPTH.short;
	}
	if (mRatio <= 12) {
		return CALL_SHOVE_RANGE_BY_DEPTH.medium;
	}
	return CALL_SHOVE_RANGE_BY_DEPTH.deep;
}

// Heads-up push/fold ranges are much wider than the 6-max table. Values are still heuristics:
// the goal is a coherent reference line, not a Nash chart.
function getHeadsUpPushRangePct(mRatio, isSmallBlind) {
	if (mRatio > 8) {
		return null;
	}
	if (isSmallBlind) {
		return mRatio <= 3 ? 90 : mRatio <= 5 ? 75 : 60;
	}
	return mRatio <= 3 ? 70 : mRatio <= 5 ? 55 : 45;
}

// Range widths for equity.vsRangePct. The base comes from the spot; public VPIP/PFR/AF reads and
// stack depth shift it, and the last aggressor gets a tighter range than cold callers.
function rangeBasePct(state, agent) {
	const needToCall = Math.max(0, (state.currentBet ?? 0) - (agent.roundBet ?? 0));
	if (state.phase === "preflop") {
		if (needToCall === 0) {
			return 50;
		}
		if (hasLiveOpponentAllIn(state, agent)) {
			return 18;
		}
		const raises = countPreflopRaises(state);
		if (raises >= 2) {
			return 12;
		}
		if (raises === 1) {
			return 22;
		}
		return 45;
	}
	if (needToCall === 0) {
		return 55;
	}
	const betRatio = needToCall / Math.max(1, state.pot ?? 0);
	if (betRatio <= 0.35) {
		return 38;
	}
	if (betRatio <= 0.7) {
		return 28;
	}
	if (betRatio <= 1.2) {
		return 20;
	}
	return 14;
}

function buildRangeProfile(state, agent, reads, { allIn = false } = {}) {
	const players = state.players ?? [];
	const active = players.filter((player) => player.seatIndex !== agent.seatIndex && player.folded !== true);
	if (active.length === 0) {
		return null;
	}
	const base = allIn ? 20 : rangeBasePct(state, agent);
	const aggressorSeat = findLastAggressorSeat(state);
	const readsBySeat = new Map((reads ?? []).map((record) => [record.seatIndex, record]));
	const opponents = active.map((player) => {
		let rangePct = base;
		const read = readsBySeat.get(player.seatIndex);
		if (read && read.hands >= 5) {
			if (read.pfrPct >= 25) {
				rangePct += 10;
			} else if (read.pfrPct <= 12) {
				rangePct -= 8;
			}
			if (read.vpipPct >= 45) {
				rangePct += 8;
			} else if (read.vpipPct <= 20) {
				rangePct -= 5;
			}
			if (read.aggressionFactor >= 2.5) {
				rangePct += 5;
			} else if (read.aggressionFactor <= 0.8) {
				rangePct -= 5;
			}
		}
		if (player.seatIndex === aggressorSeat) {
			rangePct -= 5;
		}
		const opponentM = (player.chips ?? 0) / Math.max(1, (state.smallBlind ?? 0) + (state.bigBlind ?? 0));
		if (opponentM <= 5) {
			rangePct += 8;
		}
		return {
			seatIndex: player.seatIndex,
			name: player.name,
			rangeTopPct: Math.max(6, Math.min(70, Math.round(rangePct))),
		};
	});
	return {
		basePct: base,
		allInAdjusted: allIn,
		aggressorSeat,
		opponents,
		percents: opponents.map((opponent) => opponent.rangeTopPct),
	};
}

function buildEconomics(state, agent) {
	const pot = state.pot ?? 0;
	const needToCall = Math.max(0, (state.currentBet ?? 0) - (agent.roundBet ?? 0));
	const chips = agent.chips ?? 0;
	const potOdds = needToCall > 0 ? needToCall / (pot + needToCall) : 0;
	return {
		pot,
		needToCall,
		currentBet: state.currentBet ?? 0,
		roundBet: agent.roundBet ?? 0,
		chips,
		potOddsPct: roundPct(potOdds),
		// Minimum equity a call needs to break even; compare against equity.equityPct.
		callBreakevenEquityPct: roundPct(potOdds),
		spr: round1(chips / Math.max(1, pot + needToCall)),
		mRatio: round1(chips / Math.max(1, (state.smallBlind ?? 0) + (state.bigBlind ?? 0))),
		stackCallRatio: roundPct(chips > 0 ? needToCall / chips : 0),
		committedRatio: roundPct((agent.totalBet ?? 0) / Math.max(1, (agent.totalBet ?? 0) + chips)),
	};
}

// Circular next active seat after `referenceSeatIndex` in seat order.
function findNextActiveSeat(players, referenceSeatIndex) {
	const ordered = players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
	const start = ordered.findIndex((player) => player.seatIndex === referenceSeatIndex);
	if (start === -1) {
		return null;
	}
	for (let step = 1; step <= ordered.length; step++) {
		const candidate = ordered[(start + step) % ordered.length];
		if (!candidate.folded) {
			return candidate;
		}
	}
	return null;
}

function buildPosition(state, agent) {
	const players = state.players ?? [];
	const active = players.filter((player) => !player.folded);
	const liveOpponents = active.filter((player) => player !== agent);
	const reference = (state.phase === "preflop")
		? players.find((player) => player.bigBlind === true)
		: players.find((player) => player.dealer === true);
	const firstToAct = findNextActiveSeat(players, reference?.seatIndex ?? -1);
	const ordered = active.slice().sort((a, b) => a.seatIndex - b.seatIndex);
	const agentIndex = ordered.findIndex((player) => player === agent);
	const firstIndex = ordered.findIndex((player) => player === firstToAct);
	const positionFactor = ordered.length > 1 && agentIndex !== -1 && firstIndex !== -1
		? ((agentIndex - firstIndex + ordered.length) % ordered.length) / (ordered.length - 1)
		: 0;
	const playersBehind = ordered.length > 1 && agentIndex !== -1 && firstIndex !== -1
		? (((firstIndex - agentIndex + ordered.length) % ordered.length) + ordered.length - 1) %
			ordered.length
		: 0;

	let seatClass = "middle";
	if (agent.smallBlind === true) {
		seatClass = "smallBlind";
	} else if (agent.bigBlind === true) {
		seatClass = "bigBlind";
	} else if (agent.dealer === true) {
		seatClass = "button";
	} else if (positionFactor >= 0.6) {
		seatClass = "cutoff";
	} else if (positionFactor <= 0.15) {
		seatClass = "early";
	}

	return {
		seatClass,
		positionFactor: round1(positionFactor),
		playersBehind,
		activePlayerCount: active.length,
		liveOpponentCount: liveOpponents.length,
		headsUp: active.length === 2,
		actsLast: playersBehind === 0,
	};
}

// Preflop decision table. LLMs carry a fuzzy memory of opening/push-fold charts and apply it
// inconsistently; this section turns the hand into a percentile under the same Chen ordering used
// by the all-in range math, then compares it with position/depth thresholds. The thresholds are
// deliberately simple 6-max proxies, not a GTO solution.
function buildPreflopSection(state, agent, position, economics, shove, equity) {
	if (!agent || state.phase !== "preflop" || state.gameFinished === true) {
		return null;
	}
	const holeCards = agent.holeCards ?? [];
	const handClass = describeHoleCards(holeCards);
	const topPercent = holeCards.length === 2 ? getHandPercentileCached(holeCards) : null;
	if (!handClass || topPercent === null) {
		return null;
	}

	const seatClass = position?.seatClass ?? "middle";
	const activeCount = Math.max(2, position?.activePlayerCount ?? 2);
	const headsUp = position?.headsUp === true || activeCount === 2;
	const mRatio = economics?.mRatio ?? 0;
	const stackBB = (agent.chips ?? 0) / Math.max(1, state.bigBlind ?? 1);
	const spot = detectPreflopSpot(state, agent);
	// The static table can put a hand inside a call range while the modeled range equity is below
	// the pot-odds breakeven (h29 AJo). Prefer the honest number for call suggestions, using the
	// same 1pp tolerance as the server audit.
	const vsRangePct = equity?.available ? equity.vsRangePct : null;
	const callBreakevenPct = economics?.callBreakevenEquityPct ?? null;
	const callFailsRangeMath = vsRangePct !== null && callBreakevenPct !== null &&
		vsRangePct + 1 < callBreakevenPct;

	let openTopPct;
	let callTopPct;
	let threeBetTopPct;
	let fourBetTopPct;
	let callThreeBetTopPct;
	let isoTopPct;
	if (headsUp) {
		if (seatClass === "bigBlind") {
			openTopPct = 0;
			callTopPct = 55;
			threeBetTopPct = 15;
			fourBetTopPct = 6;
			callThreeBetTopPct = 10;
			isoTopPct = 45;
		} else {
			openTopPct = 80;
			callTopPct = 35;
			threeBetTopPct = 18;
			fourBetTopPct = 8;
			callThreeBetTopPct = 12;
			isoTopPct = 80;
		}
	} else {
		// 6-max is the baseline; fewer live players widen every range.
		const tableScale = activeCount >= 6 ? 1 : activeCount === 5 ? 1.05 : activeCount === 4 ? 1.15 : 1.3;
		const scaled = (value) => Math.min(100, Math.round(value * tableScale));
		openTopPct = scaled(OPEN_RANGE_BY_SEAT[seatClass] ?? 15);
		callTopPct = scaled(CALL_RANGE_BY_SEAT[seatClass] ?? 8);
		threeBetTopPct = scaled(THREE_BET_RANGE_BY_SEAT[seatClass] ?? 8);
		fourBetTopPct = scaled(FOUR_BET_RANGE_BY_SEAT[seatClass] ?? 3);
		callThreeBetTopPct = scaled(CALL_THREE_BET_RANGE_BY_SEAT[seatClass] ?? 3);
		isoTopPct = seatClass === "bigBlind" ? scaled(12) : openTopPct;
	}
	const pushTopPct = headsUp
		? getHeadsUpPushRangePct(mRatio, seatClass !== "bigBlind")
		: getPushRangePct(seatClass, mRatio);
	const callShoveTopPct = headsUp ? 45 : getCallShoveRangePct(mRatio);

	const flags = {
		inOpenRange: topPercent <= openTopPct,
		inCallRange: topPercent <= callTopPct,
		inThreeBetRange: topPercent <= threeBetTopPct,
		inFourBetRange: topPercent <= fourBetTopPct,
		inCallThreeBetRange: topPercent <= callThreeBetTopPct,
		inIsoRange: topPercent <= isoTopPct,
		inPushRange: pushTopPct !== null && topPercent <= pushTopPct,
		inShoveCallRange: topPercent <= callShoveTopPct,
		pushFoldMode: isShortStack(mRatio) && pushTopPct !== null &&
			(spot === "unopened" || spot === "facingLimp" || spot === "unopenedCheck"),
	};

	let suggestedAction = "fold";
	let rationale = "";
	if (spot === "facingAllIn") {
		const shoveRange = shove?.rangeEquityPct;
		const shoveBreakeven = shove?.callBreakevenEquityPct;
		if (
			shoveRange !== null && shoveRange !== undefined && shoveBreakeven !== null && shoveBreakeven !== undefined
		) {
			// Keep the preflop table consistent with the hard shove rule. A static "top N%"
			// threshold alone suggested calls that the dynamic range math rejected (h19 ATo).
			suggestedAction = shoveRange >= shoveBreakeven + 5 ? "call" : "fold";
			rationale = `${handClass} is top ${topPercent}%; facing all-in; ` +
				`shove range equity ${shoveRange}% vs breakeven ${shoveBreakeven}% (+5 rule) -> ${suggestedAction}.`;
		} else {
			suggestedAction = flags.inShoveCallRange ? "call" : "fold";
			rationale = `${handClass} is top ${topPercent}%; M ${round1(mRatio)}; ` +
				`call-shove threshold top ${callShoveTopPct}% -> ${suggestedAction}.`;
		}
	} else if (spot === "facing3Bet") {
		if (flags.inFourBetRange) {
			suggestedAction = "raise";
		} else if (flags.inCallThreeBetRange) {
			suggestedAction = callFailsRangeMath ? "fold" : "call";
		}
		rationale = `${handClass} is top ${topPercent}%; facing a 3-bet; ` +
			`4-bet top ${fourBetTopPct}%, call top ${callThreeBetTopPct}%` +
			(vsRangePct !== null && callBreakevenPct !== null
				? `, vsRange ${vsRangePct}% vs breakeven ${callBreakevenPct}%`
				: "") +
			` -> ${suggestedAction}.`;
	} else if (spot === "facingRaise") {
		if (flags.inThreeBetRange) {
			suggestedAction = "raise";
		} else if (flags.inCallRange) {
			suggestedAction = callFailsRangeMath ? "fold" : "call";
		}
		rationale = `${handClass} is top ${topPercent}%; facing a raise; ` +
			`3-bet top ${threeBetTopPct}%, call top ${callTopPct}%` +
			(vsRangePct !== null && callBreakevenPct !== null
				? `, vsRange ${vsRangePct}% vs breakeven ${callBreakevenPct}%`
				: "") +
			` -> ${suggestedAction}.`;
	} else if (spot === "facingLimp") {
		if (flags.pushFoldMode) {
			suggestedAction = flags.inPushRange ? "allin" : "fold";
			rationale = `${handClass} is top ${topPercent}%; M ${round1(mRatio)} push/fold; ` +
				`${seatClass} push top ${pushTopPct}% -> ${suggestedAction}.`;
		} else if (flags.inIsoRange) {
			suggestedAction = "raise";
			rationale = `${handClass} is top ${topPercent}%; limpers; ` +
				`${seatClass} iso-raise top ${isoTopPct}% -> raise.`;
		} else if (flags.inCallRange && seatClass !== "bigBlind") {
			suggestedAction = "call";
			rationale = `${handClass} is top ${topPercent}%; limpers; call range top ${callTopPct}%.`;
		} else if (seatClass === "bigBlind") {
			suggestedAction = "check";
			rationale = `${handClass} is top ${topPercent}%; big blind option -> check.`;
		}
		if (suggestedAction === "fold") {
			rationale = `${handClass} is top ${topPercent}%; outside the iso/call ranges -> fold.`;
		}
	} else if (spot === "unopenedCheck") {
		const bbRaiseTopPct = 10;
		if (topPercent <= bbRaiseTopPct) {
			suggestedAction = "raise";
			rationale = `${handClass} is top ${topPercent}%; big blind option, top ${bbRaiseTopPct}% -> raise.`;
		} else {
			suggestedAction = "check";
			rationale = `${handClass} is top ${topPercent}%; big blind option -> check.`;
		}
	} else { // unopened
		if (flags.pushFoldMode) {
			suggestedAction = flags.inPushRange ? "allin" : "fold";
			rationale = `${handClass} is top ${topPercent}%; M ${round1(mRatio)} push/fold; ` +
				`${seatClass} push top ${pushTopPct}% -> ${suggestedAction}.`;
		} else if (flags.inOpenRange) {
			suggestedAction = "raise";
			rationale = `${handClass} is top ${topPercent}%; ${seatClass} open top ${openTopPct}% -> raise.`;
		} else {
			rationale = `${handClass} is top ${topPercent}%; outside ${seatClass} open top ${openTopPct}% -> fold.`;
		}
	}

	return {
		handClass,
		topPercent,
		stackBB: round1(stackBB),
		mRatio: round1(mRatio),
		spot,
		seatClass,
		ranges: {
			openTopPct,
			isoTopPct,
			callTopPct,
			threeBetTopPct,
			fourBetTopPct,
			callThreeBetTopPct,
			pushTopPct,
			callShoveTopPct,
		},
		flags,
		suggestedAction,
		rationale,
	};
}

// Legal raise sizes in the API's "additional chips" units. The agent routinely confuses "raise to
// X" with "add X"; spelling out raiseToTotal removes that class of error.
function buildSizingSection(state, agent) {
	if (!agent || state.gameFinished === true) {
		return null;
	}
	const actionState = buildActionState(state, agent);
	const needToCall = Math.max(0, actionState.needToCall ?? 0);
	const pot = state.pot ?? 0;
	const potAfterCall = pot + needToCall;
	const maxAmount = Math.max(0, actionState.maxAmount ?? agent.chips ?? 0);
	const maxRaiseAmount = Math.max(0, actionState.maxRaiseAmount ?? 0);
	const minRaise = Math.max(0, actionState.minRaise ?? 0);
	const legalMin = Math.min(minRaise, maxRaiseAmount);
	const roundBet = agent.roundBet ?? 0;

	const rawOptions = [{ label: "min", desired: legalMin }];
	for (const [label, fraction] of [["1/3 pot", 1 / 3], ["1/2 pot", 1 / 2], ["2/3 pot", 2 / 3], ["pot", 1]]) {
		rawOptions.push({
			label,
			desired: needToCall + Math.round(fraction * potAfterCall),
		});
	}
	// "Cover shortest" makes the common short-stack value raise explicit: the amount needed to
	// put the shortest live opponent all-in, instead of sending the all-in action and overbetting
	// your whole stack (the h64 6634-vs-1130 mistake from the 2026-11-18 session).
	let coverTarget = null;
	for (const opponent of state.players ?? []) {
		if (
			opponent.seatIndex === agent.seatIndex ||
			opponent.folded ||
			(opponent.chips ?? 0) <= 0
		) {
			continue;
		}
		const total = (opponent.roundBet ?? 0) + (opponent.chips ?? 0);
		if (coverTarget === null || total < coverTarget.total) {
			coverTarget = { seatIndex: opponent.seatIndex, name: opponent.name, total };
		}
	}
	if (coverTarget) {
		const coverDesired = Math.max(0, coverTarget.total - roundBet);
		if (coverDesired > 0) {
			rawOptions.push({
				label: "cover shortest",
				desired: coverDesired,
				targetSeatIndex: coverTarget.seatIndex,
				targetName: coverTarget.name,
			});
		}
	}

	const options = [];
	const seenAmounts = new Set();
	for (const option of rawOptions) {
		const amount = Math.min(maxRaiseAmount, Math.max(legalMin, option.desired));
		if (amount <= 0 || seenAmounts.has(amount)) {
			continue;
		}
		seenAmounts.add(amount);
		options.push({
			label: option.label,
			amount,
			raiseToTotal: roundBet + amount,
			allIn: amount >= maxAmount,
			clampedToMinRaise: option.desired < legalMin,
			clampedToMax: option.desired > maxRaiseAmount,
			targetSeatIndex: option.targetSeatIndex ?? null,
			targetName: option.targetName ?? null,
		});
	}

	return {
		amountSemantics: "amount is additional chips beyond your current roundBet; raiseToTotal = roundBet + amount",
		roundBet,
		potAfterCall,
		legal: {
			canCheck: actionState.canCheck === true,
			needToCall,
			minRaise,
			maxRaiseAmount,
			maxAmount,
		},
		canRaise: maxRaiseAmount > 0,
		allInAmount: maxAmount,
		options,
	};
}

function countSuit(cards, suit) {
	return cards.reduce((count, card) => count + (cardSuit(card) === suit ? 1 : 0), 0);
}

function handRankOf(cards) {
	try {
		return Hand.solve(cards).rank;
	} catch {
		return null;
	}
}

// Detects a 5-card straight by rank only, ignoring suits. pokersolver reports the best hand, so a
// flush can hide a simultaneous straight from `rank >= 5`; draw outs need the rank pattern itself.
function hasStraightByRanks(cards) {
	const ranks = new Set(cards.map((card) => card[0].toUpperCase()));
	const order = "23456789TJQKA";
	for (let start = 0; start + 5 <= order.length; start++) {
		if ([...order.slice(start, start + 5)].every((rank) => ranks.has(rank))) {
			return true;
		}
	}
	return ["A", "2", "3", "4", "5"].every((rank) => ranks.has(rank));
}

// Static draw facts for one hole+board combination. Cached because exact runner-runner
// enumeration is the most expensive part of an insights call and repeats across samples/requests.
function computeDrawFacts(holeCards, board) {
	const normalizedHole = holeCards.map(normalizeCard);
	const normalizedBoard = board.map(normalizeCard);
	const allKnown = [...normalizedHole, ...normalizedBoard];
	// Hole/board membership matters for overcards and shared-board-flush notes, so the cache key
	// keeps the two groups separate rather than sorting all seven cards together.
	const cacheKey = `${normalizedHole.slice().sort().join("")}|${normalizedBoard.slice().sort().join("")}`;
	if (drawCache.has(cacheKey)) {
		return drawCache.get(cacheKey);
	}

	const currentRank = handRankOf(allKnown);
	if (currentRank === null) {
		return null;
	}
	const known = new Set(allKnown);
	const unseen = FULL_DECK.filter((card) => !known.has(card));
	const boardMaxRank = normalizedBoard.reduce((max, card) => Math.max(max, cardRank(card)), -1);

	let flushSuit = null;
	let sharedBoardFlushSuit = null;
	if (currentRank < 6) {
		for (const suit of "CDHS") {
			if (countSuit(allKnown, suit) === 4) {
				const heroSuitCards = countSuit(normalizedHole, suit);
				const boardSuitCards = countSuit(normalizedBoard, suit);
				// Four suited board cards with none in your hand is a shared board flush, not your
				// draw: every opponent improves on the same card. Count it as zero clean outs.
				if (heroSuitCards === 0 && boardSuitCards === 4) {
					sharedBoardFlushSuit = suit;
				} else {
					flushSuit = suit;
				}
				break;
			}
		}
	}
	const hasStraightDraw = currentRank < 5;

	const flushOutCards = [];
	const straightOutCards = [];
	const cleanOutCards = [];
	const overcardOutCards = [];
	const otherOutCards = [];
	for (const card of unseen) {
		const nextCards = [...allKnown, card];
		const nextRank = handRankOf(nextCards);
		if (nextRank === null) {
			continue;
		}
		const completesFlush = flushSuit !== null && countSuit(nextCards, flushSuit) >= 5;
		const completesStraight = hasStraightDraw && hasStraightByRanks(nextCards);
		if (completesFlush) {
			flushOutCards.push(card);
		}
		if (completesStraight) {
			straightOutCards.push(card);
		}
		if (completesFlush || completesStraight) {
			cleanOutCards.push(card);
			continue;
		}
		const isOvercard = normalizedHole.some((hole) =>
			cardRank(hole) > boardMaxRank && cardRank(card) === cardRank(hole)
		);
		if (currentRank === 1 && nextRank === 2 && isOvercard) {
			overcardOutCards.push(card);
		} else if (nextRank > currentRank) {
			otherOutCards.push(card);
		}
	}

	const drawMade = (cards) => {
		const flushMade = flushSuit !== null && countSuit(cards, flushSuit) >= 5;
		const straightMade = hasStraightDraw && hasStraightByRanks(cards);
		return flushMade || straightMade;
	};

	let byRiverCount = 0;
	let byRiverTotal = 0;
	if (flushSuit !== null || hasStraightDraw) {
		if (board.length === 4) {
			byRiverTotal = unseen.length;
			for (const card of unseen) {
				if (drawMade([...allKnown, card])) {
					byRiverCount += 1;
				}
			}
		} else if (board.length === 3) {
			for (let first = 0; first < unseen.length; first++) {
				for (let second = first + 1; second < unseen.length; second++) {
					byRiverTotal += 1;
					if (drawMade([...allKnown, unseen[first], unseen[second]])) {
						byRiverCount += 1;
					}
				}
			}
		}
	}

	const heroSuitCards = countSuit(normalizedHole, flushSuit ?? "");
	const boardSuitCards = countSuit(normalizedBoard, flushSuit ?? "");
	const straightOuts = straightOutCards.length;
	const facts = {
		currentHand: Hand.solve(allKnown).name,
		currentRank,
		flushDraw: flushSuit === null ? null : {
			suit: flushSuit,
			outs: flushOutCards.length,
			sharedBoardFlush: heroSuitCards === 0 && boardSuitCards === 4,
		},
		// Present when the board has four suited cards and your hand has none. The flush is shared,
		// so flush outs are deliberately excluded from clean outs.
		sharedBoardFlushSuit,
		straightDraw: straightOuts === 0 ? null : {
			type: straightOuts >= 8 ? "openEnded" : "gutshot",
			outs: straightOuts,
		},
		outs: {
			clean: cleanOutCards.length,
			flush: flushOutCards.length,
			straight: straightOuts,
			overcards: overcardOutCards.length,
			other: otherOutCards.length,
		},
		nextCardCompletionPct: unseen.length > 0 ? roundPct(cleanOutCards.length / unseen.length) : 0,
		byRiverCompletionPct: byRiverTotal > 0 ? roundPct(byRiverCount / byRiverTotal) : 0,
		unknownCardCount: unseen.length,
	};
	if (drawCache.size >= DRAW_CACHE_CAPACITY) {
		drawCache.delete(drawCache.keys().next().value);
	}
	drawCache.set(cacheKey, facts);
	return facts;
}

// Draw detection fills the gap `equity.yourHand` leaves open: it names the made hand but cannot
// say "you have a flush draw with 9 outs". Completion percentages are probabilities of improving
// to the draw, NOT win probability against an opponent; the note says so.
function buildDrawSection(state, agent, economics) {
	if (!agent || state.gameFinished === true) {
		return null;
	}
	const holeCards = agent.holeCards ?? [];
	const board = state.communityCards ?? [];
	if (holeCards.length !== 2 || board.length < 3 || board.length > 5) {
		return null;
	}
	const facts = computeDrawFacts(holeCards, board);
	if (!facts) {
		return { available: false, reason: "draw_evaluation_failed" };
	}

	const needToCall = Math.max(0, economics?.needToCall ?? 0);
	const potOdds = Math.max(0, economics?.potOddsPct ?? 0) / 100;
	const breakevenOuts = needToCall > 0 ? Math.ceil(potOdds * facts.unknownCardCount) : null;
	const hasDraw = facts.flushDraw !== null || facts.straightDraw !== null;
	const callProfitableByPotOdds = needToCall <= 0 || !hasDraw ? null : facts.outs.clean >= breakevenOuts;

	let note;
	if (board.length === 5) {
		note = "river: no future cards, draw completion is 0";
	} else if (facts.flushDraw && facts.straightDraw) {
		note = "flush draw plus straight draw; completion is improving to flush or straight, not win probability";
	} else if (facts.flushDraw) {
		note = "flush draw; completion is improving to a flush, not win probability";
	} else if (facts.straightDraw) {
		note = "straight draw; completion is improving to a straight, not win probability";
	} else {
		note = "no flush or straight draw";
	}
	if (facts.sharedBoardFlushSuit) {
		note += "; board has four suited cards, your flush outs are shared by every opponent and count as 0";
	}

	return {
		available: true,
		currentHand: facts.currentHand,
		flushDraw: facts.flushDraw,
		sharedBoardFlushSuit: facts.sharedBoardFlushSuit,
		straightDraw: facts.straightDraw,
		outs: facts.outs,
		unknownCardCount: facts.unknownCardCount,
		breakevenOuts,
		nextCardCompletionPct: facts.nextCardCompletionPct,
		byRiverCompletionPct: facts.byRiverCompletionPct,
		callProfitableByPotOdds,
		note,
	};
}

function ensureRead(records, seatIndex, name) {
	let record = records.get(seatIndex);
	if (!record) {
		record = {
			seatIndex,
			name,
			hands: 0,
			vpip: 0,
			pfr: 0,
			calls: 0,
			aggressiveActs: 0,
			raises: 0,
			allins: 0,
			folds: 0,
			foldsPreflop: 0,
			foldsPostflop: 0,
			showdowns: 0,
			showdownsWon: 0,
		};
		records.set(seatIndex, record);
	}
	return record;
}

function seatNameToSeatIndex(state) {
	const map = new Map();
	for (const player of state.players ?? []) {
		map.set(player.name, player.seatIndex);
	}
	return map;
}

// Reads derive ONLY from public per-hand action streams and showdown outcomes. A hand's actions
// list contains every public decision; showdown winners/pot results are announced at the table.
function buildReads(handResults, agentSeatIndex) {
	const records = new Map();

	for (const handResult of handResults ?? []) {
		const handState = handResult?.state ?? {};
		const actions = handState.actions ?? [];
		const nameToSeat = seatNameToSeatIndex(handState);
		const seatsThisHand = new Set();
		// VPIP/PFR are per-hand flags: a player raising twice in a preflop war still counts once.
		const preflopEntered = new Set();
		const preflopRaised = new Set();

		for (const action of actions) {
			const seatIndex = action.seatIndex;
			if (seatIndex === null || seatIndex === undefined || seatIndex === agentSeatIndex) {
				continue;
			}
			seatsThisHand.add(seatIndex);
			const record = ensureRead(records, seatIndex, action.name);
			const resolved = action.resolved?.action ?? null;
			const phase = action.phase;
			if (resolved === "fold") {
				record.folds += 1;
				if (phase === "preflop") {
					record.foldsPreflop += 1;
				} else {
					record.foldsPostflop += 1;
				}
			} else if (resolved === "call") {
				record.calls += 1;
			} else if (resolved === "raise") {
				record.raises += 1;
				record.aggressiveActs += 1;
			} else if (resolved === "allin") {
				record.allins += 1;
				record.aggressiveActs += 1;
			}
			if (phase === "preflop" && (resolved === "call" || resolved === "raise" || resolved === "allin")) {
				preflopEntered.add(seatIndex);
			}
			if (phase === "preflop" && (resolved === "raise" || resolved === "allin")) {
				preflopRaised.add(seatIndex);
			}
		}
		for (const seatIndex of preflopEntered) {
			records.get(seatIndex).vpip += 1;
		}
		for (const seatIndex of preflopRaised) {
			records.get(seatIndex).pfr += 1;
		}

		for (const potResult of handState.potResults ?? []) {
			for (const winnerName of potResult.players ?? []) {
				const seatIndex = nameToSeat.get(winnerName);
				if (seatIndex !== undefined && seatIndex !== agentSeatIndex) {
					seatsThisHand.add(seatIndex);
					if (handState.hadShowdown === true) {
						ensureRead(records, seatIndex, winnerName).showdowns += 1;
					}
				}
			}
		}

		if (handState.hadShowdown === true) {
			for (const winner of handState.winners ?? []) {
				if (winner.seatIndex !== agentSeatIndex) {
					const record = ensureRead(records, winner.seatIndex, winner.name);
					record.showdownsWon += 1;
				}
			}
		}

		for (const seatIndex of seatsThisHand) {
			const record = records.get(seatIndex);
			if (record) {
				record.hands += 1;
			}
		}
	}

	return Array.from(records.values())
		.sort((a, b) => a.seatIndex - b.seatIndex)
		.map((record) => {
			const hands = Math.max(1, record.hands);
			const vpipPct = roundPct(record.vpip / hands);
			const pfrPct = roundPct(record.pfr / hands);
			const aggressionFactor = round1(record.aggressiveActs / Math.max(1, record.calls));
			const showdownWinRatePct = record.showdowns > 0 ? roundPct(record.showdownsWon / record.showdowns) : null;
			const hints = [];
			if (record.hands >= 5) {
				if (vpipPct <= 20) {
					hints.push("tight");
				} else if (vpipPct >= 40) {
					hints.push("loose");
				}
				if (aggressionFactor >= 2) {
					hints.push("aggressive");
				} else if (aggressionFactor <= 1) {
					hints.push("passive");
				}
			}
			return {
				seatIndex: record.seatIndex,
				name: record.name,
				hands: record.hands,
				vpipPct,
				pfrPct,
				aggressionFactor,
				raises: record.raises,
				allins: record.allins,
				folds: record.folds,
				foldsPreflop: record.foldsPreflop,
				foldsPostflop: record.foldsPostflop,
				showdowns: record.showdowns,
				showdownWinRatePct,
				hints,
			};
		});
}

function buildEquitySection(state, agent, samples, reads) {
	const holeCards = agent.holeCards ?? [];
	const board = state.communityCards ?? [];
	const handInProgress = (state.handId ?? 0) > 0 &&
		state.gameFinished !== true &&
		agent.folded !== true &&
		holeCards.length === 2 &&
		holeCards.every(Boolean);

	if (!handInProgress) {
		return {
			available: false,
			reason: state.gameFinished === true
				? "game_finished"
				: agent.folded === true
				? "agent_folded"
				: "hole_cards_not_dealt_yet",
		};
	}

	const players = state.players ?? [];
	const agentSeatIndex = state.agentSeatIndex ?? 0;
	const liveOpponents =
		players.filter((player) => player.seatIndex !== agentSeatIndex && player.folded !== true).length;

	const estimate = estimatePublicEquity({
		holeCards,
		communityCards: board,
		opponentCount: liveOpponents,
		sampleCount: samples,
	});
	if (!estimate) {
		return { available: false, reason: "equity_estimation_failed" };
	}

	const rangeProfile = buildRangeProfile(state, agent, reads);
	const rangeSamples = Math.min(samples, MAX_RANGE_SAMPLES);
	const rangeEstimate = rangeProfile && rangeProfile.percents.length > 0
		? estimateRangeEquity({
			holeCards,
			communityCards: board,
			opponentCount: liveOpponents,
			rangePercents: rangeProfile.percents,
			sampleCount: rangeSamples,
		})
		: null;

	return {
		available: true,
		equityPct: roundPct(estimate.equity),
		stderrPct: roundPct(estimate.stderr ?? 0),
		samples: estimate.samples,
		opponentCount: estimate.opponentCount,
		boardCardCount: board.length,
		// Engine-evaluated made hand for the current board. The LLM misreads its own cards
		// occasionally; this field is authoritative — trust it over any self-read.
		yourHand: board.length >= 3 ? Hand.solve([...holeCards, ...board]).name : null,
		// Random-hand equity answers "how often am I ahead of any two cards"; vsRangePct narrows
		// opponents using only public actions plus VPIP/PFR reads. Use vsRangePct for calls.
		vsRangePct: rangeEstimate ? roundPct(rangeEstimate.equity) : null,
		vsRangeStderrPct: rangeEstimate ? roundPct(rangeEstimate.stderr ?? 0) : null,
		rangeSamples: rangeEstimate?.samples ?? null,
		rangeAssumption: rangeProfile
			? `opponents' ranges modeled at top ${rangeProfile.percents.join("/")}% ` +
				`(VPIP/PFR adjusted; hypothetical hands from public unseen-card pool)`
			: null,
		rangeOpponents: rangeProfile?.opponents ?? [],
		// Privacy contract: opponent hands here are hypothetical samples from the public unseen-card
		// pool (52 minus your hole cards minus the board). The engine deck and opponents' actual
		// hole cards are never read; live opponent count is the only opponent-derived input.
		sampling: "hypothetical hands from public unseen-card pool",
	};
}

// Random-equity overstates calling equity against real shove ranges, so when the agent faces an
// all-in or a stack-heavy commitment this section provides the honest math: equity vs an
// opponent-specific range. Public VPIP/PFR/AF reads and stack depth set each opponent's width; a
// fixed top-20% is too wide against a nit and too tight against a maniac.
function buildShoveSection(state, agent, economics, samples, reads) {
	if (!agent || state.gameFinished === true) {
		return null;
	}
	const needToCall = economics?.needToCall ?? 0;
	const chips = agent.chips ?? 0;
	if (needToCall <= 0 || chips <= 0) {
		return null;
	}
	const agentSeatIndex = state.agentSeatIndex ?? 0;
	const opponentAllIn = (state.players ?? []).some((player) =>
		player.seatIndex !== agentSeatIndex && player.folded !== true && player.allIn === true
	);
	const stackHeavyCall = needToCall >= chips * 0.33;
	if (!opponentAllIn && !stackHeavyCall) {
		return null;
	}

	const profile = buildRangeProfile(state, agent, reads, { allIn: true });
	const estimate = profile && profile.percents.length > 0
		? estimateRangeEquity({
			holeCards: agent.holeCards ?? [],
			communityCards: state.communityCards ?? [],
			opponentCount: (state.players ?? []).filter((player) =>
				player.seatIndex !== agentSeatIndex && player.folded !== true
			).length,
			rangePercents: profile.percents,
			sampleCount: Math.min(samples, MAX_RANGE_SAMPLES),
		})
		: null;
	const rangeEquityPct = estimate ? roundPct(estimate.equity) : null;

	const warning = "[WARN] 对手全下或你需要投入超过 1/3 筹码：equityPct 是对均匀随机手牌的胜率，" +
		"对真实全下范围严重偏高，不要用它做跟注判断。以 shove.rangeEquityPct 为准：" +
		"rangeEquityPct >= callBreakevenEquityPct + 5 才考虑跟注，否则弃牌" +
		"（死 zone（mRatio < 3）按 push/fold 处理除外）。";

	return {
		warning,
		rangeEquityPct,
		rangeAssumption: profile
			? `opponents' all-in ranges modeled at top ${profile.percents.join("/")}% ` +
				`(VPIP/PFR adjusted; hypothetical hands from public unseen-card pool)`
			: null,
		rangeOpponents: profile?.opponents ?? [],
		callBreakevenEquityPct: economics?.callBreakevenEquityPct ?? null,
	};
}

function buildHeadline({ economics, position, equity, preflop, draws, shove }) {
	const lines = [];
	if (preflop) {
		lines.push(
			`Preflop ${preflop.handClass} top ${preflop.topPercent}% ${preflop.spot} ` +
				`${preflop.seatClass} -> ${preflop.suggestedAction}`,
		);
	}
	if (equity?.available) {
		lines.push(
			`Equity ${equity.equityPct}% random / ${equity.vsRangePct ?? "n/a"}% vs range; ` +
				`pot odds ${economics?.potOddsPct ?? 0}%`,
		);
	}
	if (draws?.available && (draws.outs?.clean ?? 0) > 0) {
		lines.push(
			`Draws ${draws.outs.clean} clean outs; by river ${draws.byRiverCompletionPct}%`,
		);
	}
	if (shove) {
		lines.push(
			`Shove math ${shove.rangeEquityPct}% vs breakeven ${shove.callBreakevenEquityPct}%`,
		);
	}
	if (position) {
		const playerWord = position.playersBehind === 1 ? "player" : "players";
		lines.push(`Position ${position.seatClass}; ${position.playersBehind} ${playerWord} behind`);
	}
	return lines;
}

export function buildInsights({ state, handResults, agentSeatIndex = 0, samples = DEFAULT_INSIGHT_SAMPLES }) {
	if (!state) {
		return { ok: false, reason: "no_state_yet", economics: null, position: null, equity: null, reads: [] };
	}

	// After the agent busts, the engine drops its seat from state.players entirely. Never guess an
	// identity from array order (the engine rotates seat order every hand — players[0] can be any
	// seat); fall back to the passed-in agentSeatIndex so reads keep excluding the agent seat.
	const agent = getAgentPlayer(state);
	const agentPresent = agent !== null;
	const effectiveAgentSeatIndex = agent?.seatIndex ?? agentSeatIndex;
	const economics = agent ? buildEconomics(state, agent) : null;
	const position = agent ? buildPosition(state, agent) : null;
	const clampedSamples = clampInsightSamples(samples);
	// Reads must exist before the range profiles: dynamic range widths consume VPIP/PFR/AF.
	const reads = buildReads(handResults, effectiveAgentSeatIndex);
	// Shove math and the normal range equity are built before the preflop table so a call
	// suggestion can use the same honest numbers instead of a static top-N% threshold.
	const shove = agent ? buildShoveSection(state, agent, economics, clampedSamples, reads) : null;
	const equity = agentPresent ? buildEquitySection(state, agent, clampedSamples, reads) : {
		available: false,
		reason: "agent_busted_or_absent",
	};
	const preflop = agent ? buildPreflopSection(state, agent, position, economics, shove, equity) : null;
	const draws = agent ? buildDrawSection(state, agent, economics) : null;
	const sizing = agent ? buildSizingSection(state, agent) : null;

	return {
		ok: true,
		handId: state.handId ?? 0,
		phase: state.phase ?? null,
		gameFinished: state.gameFinished === true,
		headline: buildHeadline({ economics, position, equity, preflop, draws, shove }),
		blinds: {
			smallBlind: state.smallBlind ?? null,
			bigBlind: state.bigBlind ?? null,
			blindLevel: state.blindLevel ?? 0,
			handsUntilBlindIncrease: HANDS_PER_BLIND_LEVEL -
				((state.handId ?? 0) % HANDS_PER_BLIND_LEVEL),
		},
		economics: agentPresent ? economics : null,
		position: agentPresent ? position : null,
		preflop,
		draws,
		sizing,
		equity,
		shoveWarning: shove?.warning ?? null,
		shove: shove
			? {
				rangeEquityPct: shove.rangeEquityPct,
				rangeAssumption: shove.rangeAssumption,
				rangeOpponents: shove.rangeOpponents,
				callBreakevenEquityPct: shove.callBreakevenEquityPct,
			}
			: null,
		// Per-opponent tendencies from public actions and showdown outcomes only.
		reads,
	};
}
