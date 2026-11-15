/* ==================================================================================================
MODULE BOUNDARY: Bot Equity Estimator
================================================================================================== */

// CURRENT STATE: Monte Carlo hand-equity estimation for bot decisions, using ONLY public
// information: the acting bot's hole cards and the community cards. Opponent hole cards and board
// runouts are sampled from the full set of unseen cards derived from those public cards alone, so
// an estimate can never leak the engine deck, the graveyard, or other players' actual holdings.
// TARGET STATE: Stay the single place where bot logic converts public cards into equity estimates.
// PUT HERE: Unseen-card derivation, sampling, hand solving, tie-aware equity counting, caching,
// and the enable/sample-count/rng configuration surface for tests and batch runs.
// DO NOT PUT HERE: Decision thresholds or blending weights (bot.js owns those), engine state access,
// deck/graveyard reads, or anything that receives a gameState.

import { Hand } from "./pokersolver.js";

const RANKS = "23456789TJQKA";
const SUITS = "CDHS";
const FULL_DECK = (() => {
	const deck = [];
	for (const rank of RANKS) {
		for (const suit of SUITS) {
			deck.push(rank + suit);
		}
	}
	return deck;
})();

const DEFAULT_SAMPLE_COUNT = 1000;
const DEFAULT_CACHE_CAPACITY = 256;
const MIN_VALID_SAMPLE_COUNT = 200;
const MAX_TOOL_SAMPLE_COUNT = 25000;

let enabled = true;
let sampleCount = DEFAULT_SAMPLE_COUNT;
let cacheCapacity = DEFAULT_CACHE_CAPACITY;
let rng = Math.random;
const equityCache = new Map();

export function setBotEquityConfig({
	enabled: enabledOverride,
	sampleCount: sampleCountOverride,
	cacheCapacity: cacheCapacityOverride,
	rng: rngOverride,
} = {}) {
	if (typeof enabledOverride === "boolean") {
		enabled = enabledOverride;
	}
	if (Number.isFinite(sampleCountOverride)) {
		sampleCount = Math.max(MIN_VALID_SAMPLE_COUNT, Math.floor(sampleCountOverride));
	}
	if (Number.isFinite(cacheCapacityOverride)) {
		cacheCapacity = Math.max(0, Math.floor(cacheCapacityOverride));
	}
	if (typeof rngOverride === "function") {
		rng = rngOverride;
	}
	equityCache.clear();
}

export function getBotEquityConfig() {
	return { enabled, sampleCount, cacheCapacity };
}

// The engine deals uppercase-suit codes ("2C", "AS"). Normalize defensively so a lowercase input
// can never leave a phantom duplicate in the sampled pool.
function normalizeCard(card) {
	return card.length === 2 ? card[0] + card[1].toUpperCase() : card;
}

function buildUnseenCards(holeCards, communityCards, fixedOpponentHoleCards) {
	const known = new Set([...holeCards, ...communityCards].map(normalizeCard));
	for (const hole of fixedOpponentHoleCards ?? []) {
		for (const card of hole) {
			known.add(normalizeCard(card));
		}
	}
	const unseen = [];
	for (const card of FULL_DECK) {
		if (!known.has(card)) {
			unseen.push(card);
		}
	}
	return unseen;
}

// Partial Fisher-Yates on the working array: only the first `count` slots become random, so each
// simulation pass is O(count) instead of a full shuffle.
function partialShuffle(cards, count) {
	for (let index = 0; index < count; index++) {
		const swapIndex = index + Math.floor(rng() * (cards.length - index));
		const temporary = cards[index];
		cards[index] = cards[swapIndex];
		cards[swapIndex] = temporary;
	}
	return cards;
}

function countHeroShare(heroHand, opponentHands) {
	const winners = Hand.winners([heroHand, ...opponentHands]);
	return winners.some((winner) => winner === heroHand) ? 1 / winners.length : 0;
}

function simulateEquity({
	holeCards,
	communityCards,
	opponentCount,
	fixedOpponentHoleCards,
	iterations,
}) {
	const missingBoardCount = 5 - communityCards.length;
	if (missingBoardCount < 0 || holeCards.length !== 2) {
		return null;
	}

	const fixedOpponents = Array.isArray(fixedOpponentHoleCards) ? fixedOpponentHoleCards : [];
	const unseen = buildUnseenCards(holeCards, communityCards, fixedOpponents);
	const sampledOpponentCount = Math.max(0, opponentCount - fixedOpponents.length);
	const cardsNeeded = sampledOpponentCount * 2 + missingBoardCount;
	if (cardsNeeded > unseen.length) {
		return null;
	}

	const boardCards = communityCards.concat();
	const working = unseen.slice();
	const heroPrefix = holeCards.concat();
	let equitySum = 0;

	for (let iteration = 0; iteration < iterations; iteration++) {
		partialShuffle(working, cardsNeeded);
		const fullBoard = missingBoardCount > 0
			? boardCards.concat(working.slice(sampledOpponentCount * 2, cardsNeeded))
			: boardCards;

		const heroHand = Hand.solve(heroPrefix.concat(fullBoard));
		const opponentHands = fixedOpponents.map((hole) => Hand.solve(hole.concat(fullBoard)));
		for (let opponent = 0; opponent < sampledOpponentCount; opponent++) {
			const base = opponent * 2;
			opponentHands.push(Hand.solve([working[base], working[base + 1], ...fullBoard]));
		}

		equitySum += countHeroShare(heroHand, opponentHands);
	}

	return equitySum / iterations;
}

function getCacheKey({ holeCards, communityCards, opponentCount, fixedOpponentHoleCards }) {
	const fixedKey = fixedOpponentHoleCards?.length
		? `#${fixedOpponentHoleCards.map((hole) => hole.join("")).join("#")}`
		: "";
	return `${holeCards.join("")}|${communityCards.join("")}|${opponentCount}${fixedKey}`;
}

function readCache(key) {
	const cached = equityCache.get(key);
	if (cached !== undefined) {
		// Refresh insertion order so hot spots survive the FIFO eviction cap.
		equityCache.delete(key);
		equityCache.set(key, cached);
	}
	return cached;
}

function writeCache(key, value) {
	if (cacheCapacity <= 0) {
		return;
	}
	if (equityCache.size >= cacheCapacity) {
		const oldestKey = equityCache.keys().next().value;
		equityCache.delete(oldestKey);
	}
	equityCache.set(key, value);
}

/**
 * Estimate the acting bot's hand equity against `opponentCount` uniformly random hands.
 * Only public information is consumed; opponents and board runouts are sampled from the unseen
 * card set derived from the bot's hole cards plus the community cards.
 * Returns { equity, samples, opponentCount } or null when inputs are degenerate.
 */
export function estimateBotEquity({ holeCards, communityCards, opponentCount }) {
	if (!enabled || !Array.isArray(holeCards) || holeCards.length !== 2) {
		return null;
	}
	const liveOpponentCount = Math.max(0, Math.floor(opponentCount ?? 0));
	if (liveOpponentCount === 0) {
		return { equity: 1, samples: 0, opponentCount: 0 };
	}
	const boardLength = Array.isArray(communityCards) ? communityCards.length : 0;
	if (boardLength < 3 || boardLength > 5) {
		// Postflop blending only; preflop stays on the tuned range system.
		return null;
	}

	const cacheKey = getCacheKey({ holeCards, communityCards, opponentCount: liveOpponentCount });
	const cached = readCache(cacheKey);
	if (cached !== undefined) {
		return { equity: cached, samples: sampleCount, opponentCount: liveOpponentCount, cached: true };
	}

	const equity = simulateEquity({
		holeCards,
		communityCards,
		opponentCount: liveOpponentCount,
		fixedOpponentHoleCards: null,
		iterations: sampleCount,
	});
	if (equity === null || !Number.isFinite(equity)) {
		return null;
	}

	writeCache(cacheKey, equity);
	return { equity, samples: sampleCount, opponentCount: liveOpponentCount };
}

/**
 * Test-focused variant: fixed opponent hole cards are held out of the sampled pool, and any
 * remaining opponents stay uniformly random. Exposed for known-matchup assertions.
 */
export function estimateEquityForTest({
	holeCards,
	communityCards,
	opponentCount,
	fixedOpponentHoleCards,
	iterations,
}) {
	return simulateEquity({
		holeCards,
		communityCards,
		opponentCount,
		fixedOpponentHoleCards: fixedOpponentHoleCards ?? null,
		iterations,
	});
}

/**
 * Leak-proof equity for agent-facing tools (HTTP insights endpoint). Accepts any street
 * (0..5 community cards) and an explicit sample count. Identical privacy contract to the bot
 * path: hypothetical opponents and runouts are sampled from the unseen card pool derived from
 * the agent's hole cards plus the public board; the engine deck and opponents' actual holdings
 * are never an input. Returns { equity, samples, opponentCount, stderr } or null.
 */
export function estimatePublicEquity({ holeCards, communityCards, opponentCount, sampleCount }) {
	if (!Array.isArray(holeCards) || holeCards.length !== 2) {
		return null;
	}
	const board = Array.isArray(communityCards) ? communityCards : [];
	if (board.length > 5) {
		return null;
	}
	const liveOpponentCount = Math.max(0, Math.floor(opponentCount ?? 0));
	if (liveOpponentCount === 0) {
		return { equity: 1, samples: 0, opponentCount: 0, stderr: 0 };
	}
	const iterations = Number.isFinite(sampleCount)
		? Math.max(
			MIN_VALID_SAMPLE_COUNT,
			Math.min(MAX_TOOL_SAMPLE_COUNT, Math.floor(sampleCount)),
		)
		: DEFAULT_SAMPLE_COUNT;

	const cacheKey = `T:${
		getCacheKey({ holeCards, communityCards: board, opponentCount: liveOpponentCount })
	}x${iterations}`;
	const cached = readCache(cacheKey);
	if (cached !== undefined) {
		return {
			equity: cached,
			samples: iterations,
			opponentCount: liveOpponentCount,
			stderr: equityStderr(cached, iterations),
		};
	}

	const equity = simulateEquity({
		holeCards,
		communityCards: board,
		opponentCount: liveOpponentCount,
		fixedOpponentHoleCards: null,
		iterations,
	});
	if (equity === null || !Number.isFinite(equity)) {
		return null;
	}

	writeCache(cacheKey, equity);
	return {
		equity,
		samples: iterations,
		opponentCount: liveOpponentCount,
		stderr: equityStderr(equity, iterations),
	};
}

function equityStderr(equity, iterations) {
	return Math.sqrt((equity * (1 - equity)) / Math.max(1, iterations));
}

/* -----------------------------
   Range-aware equity (all-in decisions)
----------------------------- */

// Chen-style preflop ranking kept local (bot.js imports this module; importing it back would be
// circular). Good enough as a proxy ordering for "top N% starting hands".
const CHEN_BASE = {
	A: 10,
	K: 8,
	Q: 7,
	J: 6,
	T: 5,
	"9": 4.5,
	"8": 4,
	"7": 3.5,
	"6": 3,
	"5": 2.5,
	"4": 2,
	"3": 1.5,
	"2": 1,
};

function chenComboScore(cardA, cardB) {
	let score = CHEN_BASE[cardA[0]] ?? 1;
	if (cardA[0] === cardB[0]) {
		score = Math.max(5, score * 2);
	} else {
		if (cardA[1] === cardB[1]) {
			score += 2;
		}
		const high = Math.max(RANKS.indexOf(cardA[0]), RANKS.indexOf(cardB[0]));
		const low = Math.min(RANKS.indexOf(cardA[0]), RANKS.indexOf(cardB[0]));
		const gap = high - low - 1;
		if (gap === 1) {
			score -= 1;
		} else if (gap === 2) {
			score -= 2;
		} else if (gap === 3) {
			score -= 4;
		} else if (gap >= 4) {
			score -= 5;
		}
		if (gap <= 1 && high < RANKS.indexOf("Q")) {
			score += 1;
		}
	}
	return Math.max(0, score);
}

const rangeComboCache = new Map();

// All 1326 hole-card combos sorted strongest-first, truncated to the requested percentile.
function getRangeCombos(rangePercent) {
	const clamped = Math.max(1, Math.min(100, Math.round(rangePercent)));
	const cached = rangeComboCache.get(clamped);
	if (cached) {
		return cached;
	}
	const scored = [];
	for (let i = 0; i < FULL_DECK.length; i++) {
		for (let j = i + 1; j < FULL_DECK.length; j++) {
			const cardA = FULL_DECK[i];
			const cardB = FULL_DECK[j];
			scored.push([cardA, cardB, chenComboScore(cardA, cardB)]);
		}
	}
	scored.sort((a, b) => b[2] - a[2]);
	const count = Math.max(1, Math.round((scored.length * clamped) / 100));
	const list = scored.slice(0, count).map(([cardA, cardB]) => [cardA, cardB]);
	rangeComboCache.set(clamped, list);
	return list;
}

/**
 * Equity against opponents holding hands from the top `rangePercent` of starting hands
 * (Chen-ranked). This is the honest number for all-in decisions: a jam range is far tighter
 * than uniform random, so random-equity overstates calling equity. Privacy contract unchanged:
 * the range is public math, opponents are still hypothetical, and no engine state is read.
 */
export function estimateRangeEquity({
	holeCards,
	communityCards,
	opponentCount,
	rangePercent = 20,
	sampleCount,
}) {
	if (!Array.isArray(holeCards) || holeCards.length !== 2) {
		return null;
	}
	const board = Array.isArray(communityCards) ? communityCards : [];
	if (board.length > 5) {
		return null;
	}
	const liveOpponentCount = Math.max(0, Math.floor(opponentCount ?? 0));
	if (liveOpponentCount === 0) {
		return { equity: 1, samples: 0, opponentCount: 0, stderr: 0, rangePercent };
	}
	const iterations = Number.isFinite(sampleCount)
		? Math.max(
			MIN_VALID_SAMPLE_COUNT,
			Math.min(MAX_TOOL_SAMPLE_COUNT, Math.floor(sampleCount)),
		)
		: DEFAULT_SAMPLE_COUNT;

	const normalizedHole = holeCards.map(normalizeCard);
	const normalizedBoard = board.map(normalizeCard);
	const known = new Set([...normalizedHole, ...normalizedBoard]);
	const unseen = [];
	for (const card of FULL_DECK) {
		if (!known.has(card)) {
			unseen.push(card);
		}
	}
	// Range combos that remain possible given the public cards.
	const availableRange = getRangeCombos(rangePercent).filter(([a, b]) => !known.has(a) && !known.has(b));
	const missingBoardCount = 5 - normalizedBoard.length;
	if (availableRange.length < liveOpponentCount || unseen.length < missingBoardCount) {
		return null;
	}

	const rangeWorking = availableRange.slice();
	const unseenWorking = unseen.slice();
	const heroPrefix = normalizedHole.concat();
	const boardPrefix = normalizedBoard.concat();
	let equitySum = 0;

	for (let iteration = 0; iteration < iterations; iteration++) {
		// Full shuffle: combos deeper in the list are needed to skip card conflicts.
		partialShuffle(rangeWorking, rangeWorking.length);
		const opponentHoles = [];
		const taken = new Set();
		for (const [cardA, cardB] of rangeWorking) {
			if (opponentHoles.length === liveOpponentCount) {
				break;
			}
			if (taken.has(cardA) || taken.has(cardB)) {
				continue;
			}
			opponentHoles.push([cardA, cardB]);
			taken.add(cardA);
			taken.add(cardB);
		}
		if (opponentHoles.length < liveOpponentCount) {
			continue;
		}
		// Board stays uniformly random over remaining cards (opponent ranges constrain only hands).
		partialShuffle(unseenWorking, unseenWorking.length);
		const runout = [];
		for (const card of unseenWorking) {
			if (runout.length === missingBoardCount) {
				break;
			}
			if (!taken.has(card)) {
				runout.push(card);
				taken.add(card);
			}
		}
		const fullBoard = missingBoardCount > 0 ? boardPrefix.concat(runout) : boardPrefix;

		const heroHand = Hand.solve(heroPrefix.concat(fullBoard));
		const opponentHands = [];
		for (const hole of opponentHoles) {
			opponentHands.push(Hand.solve(hole.concat(fullBoard)));
		}
		equitySum += countHeroShare(heroHand, opponentHands);
	}

	const equity = equitySum / iterations;
	if (!Number.isFinite(equity)) {
		return null;
	}
	return {
		equity,
		samples: iterations,
		opponentCount: liveOpponentCount,
		stderr: equityStderr(equity, iterations),
		rangePercent: Math.max(1, Math.min(100, Math.round(rangePercent))),
	};
}
