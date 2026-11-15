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

import { estimatePublicEquity } from "../js/botEquity.js";

export const DEFAULT_INSIGHT_SAMPLES = 1000;
export const MIN_INSIGHT_SAMPLES = 200;
export const MAX_INSIGHT_SAMPLES = 25000;
const HANDS_PER_BLIND_LEVEL = 6;

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

function buildEquitySection(state, agent, samples) {
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

	return {
		available: true,
		equityPct: roundPct(estimate.equity),
		stderrPct: roundPct(estimate.stderr ?? 0),
		samples: estimate.samples,
		opponentCount: estimate.opponentCount,
		boardCardCount: board.length,
		// Privacy contract: opponent hands here are hypothetical samples from the public unseen-card
		// pool (52 minus your hole cards minus the board). The engine deck and opponents' actual
		// hole cards are never read; live opponent count is the only opponent-derived input.
		sampling: "hypothetical hands from public unseen-card pool",
	};
}

// Random-equity overstates calling equity against real shove ranges. Surfaces as a top-level
// warning whenever the agent faces an all-in or a stack-heavy commitment, so the payload itself
// tells the agent when the naive comparison (equityPct vs callBreakevenEquityPct) breaks down.
function buildShoveWarning(state, agent, economics) {
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
	return "[WARN] 对手全下或你需要投入超过 1/3 筹码：equityPct 是对均匀随机手牌的胜率，" +
		"会显著高估你对真实全下范围的胜率（全下范围通常只有牌谱顶部 15-25%）。" +
		"除非 equityPct 比 callBreakevenEquityPct 高出至少 15 个百分点且你的手牌是 premium" +
		"（99+/AQ+/AK 一类），否则弃牌；死 zone（mRatio < 3）按 push/fold 处理除外。";
}

export function buildInsights({ state, handResults, agentSeatIndex = 0, samples = DEFAULT_INSIGHT_SAMPLES }) {
	if (!state) {
		return { ok: false, reason: "no_state_yet", economics: null, position: null, equity: null, reads: [] };
	}

	const agent = getAgentPlayer(state) ?? (state.players ?? [])[0] ?? null;
	const effectiveAgentSeatIndex = agent?.seatIndex ?? agentSeatIndex;
	const economics = agent ? buildEconomics(state, agent) : null;

	return {
		ok: true,
		handId: state.handId ?? 0,
		phase: state.phase ?? null,
		gameFinished: state.gameFinished === true,
		blinds: {
			smallBlind: state.smallBlind ?? null,
			bigBlind: state.bigBlind ?? null,
			blindLevel: state.blindLevel ?? 0,
			handsUntilBlindIncrease: HANDS_PER_BLIND_LEVEL -
				((state.handId ?? 0) % HANDS_PER_BLIND_LEVEL),
		},
		economics,
		position: agent ? buildPosition(state, agent) : null,
		equity: agent ? buildEquitySection(state, agent, clampInsightSamples(samples)) : {
			available: false,
			reason: "no_agent_seat",
		},
		shoveWarning: buildShoveWarning(state, agent, economics),
		// Per-opponent tendencies from public actions and showdown outcomes only.
		reads: buildReads(handResults, effectiveAgentSeatIndex),
	};
}
