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
	const rankA = cardA[0];
	const rankB = cardB[0];
	const indexA = RANKS.indexOf(rankA);
	const indexB = RANKS.indexOf(rankB);
	// Base score must come from the HIGHER card regardless of argument order. The engine deals
	// hole cards in arbitrary order, so using cardA blindly made ATo score like T-high when the
	// ten came first (top 45% instead of top 13%).
	const highRank = indexA >= indexB ? rankA : rankB;
	const highIndex = Math.max(indexA, indexB);
	const lowIndex = Math.min(indexA, indexB);
	let score = CHEN_BASE[highRank] ?? 1;
	if (rankA === rankB) {
		score = Math.max(5, score * 2);
	} else {
		if (cardA[1] === cardB[1]) {
			score += 2;
		}
		const gap = highIndex - lowIndex - 1;
		if (gap === 1) {
			score -= 1;
		} else if (gap === 2) {
			score -= 2;
		} else if (gap === 3) {
			score -= 4;
		} else if (gap >= 4) {
			score -= 5;
		}
		if (gap <= 1 && highIndex < RANKS.indexOf("Q")) {
			score += 1;
		}
	}
	return Math.max(0, score);
}

const rangeComboCache = new Map();
let allComboScores = null;

// Chen score for every one of the 1326 hole-card combos, strongest first. Built lazily once so
// `getHandPercentile` can compare a specific hand against the whole space.
function getAllComboScores() {
	if (allComboScores) {
		return allComboScores;
	}
	allComboScores = [];
	for (let i = 0; i < FULL_DECK.length; i++) {
		for (let j = i + 1; j < FULL_DECK.length; j++) {
			allComboScores.push(chenComboScore(FULL_DECK[i], FULL_DECK[j]));
		}
	}
	allComboScores.sort((a, b) => b - a);
	return allComboScores;
}

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
 * Percentile of a specific starting hand under the same Chen-style ordering used by
 * `estimateRangeEquity`. Returns a number in [0.1, 100]: 0.5 means "top 0.5% of all combos".
 * Ties share the rank of the first combo at that score, so the value is conservative.
 */
export function getHandPercentile(holeCards) {
	if (!Array.isArray(holeCards) || holeCards.length !== 2 || !holeCards.every(Boolean)) {
		return null;
	}
	const normalized = holeCards.map(normalizeCard);
	if (normalized[0] === normalized[1]) {
		return null;
	}
	const score = chenComboScore(normalized[0], normalized[1]);
	const scores = getAllComboScores();
	// Count combos at least as strong as this hand. The first combo weaker than `score` marks the
	// boundary; all tied combos above it count toward the percentile.
	let strongerOrEqual = 0;
	for (const candidate of scores) {
		if (candidate < score) {
			break;
		}
		strongerOrEqual += 1;
	}
	const percent = (strongerOrEqual / scores.length) * 100;
	return Math.max(0.1, Math.round(percent * 10) / 10);
}

/**
 * Equity against opponents holding hands from the top `rangePercent` of starting hands
 * (Chen-ranked). This is the honest number for all-in decisions: a jam range is far tighter
 * than uniform random, so random-equity overstates calling equity. Privacy contract unchanged:
 * the range is public math, opponents are still hypothetical, and no engine state is read.
 *
 * `rangePercents` (optional) gives each opponent its own range width, e.g. the player who jammed
 * gets a tight range while a cold caller keeps a wider one. Values are clamped to [1, 100].
 */
export function estimateRangeEquity({
	holeCards,
	communityCards,
	opponentCount,
	rangePercent = 20,
	rangePercents,
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
		return {
			equity: 1,
			samples: 0,
			opponentCount: 0,
			stderr: 0,
			rangePercent: null,
			rangePercents: [],
		};
	}
	const iterations = Number.isFinite(sampleCount)
		? Math.max(
			MIN_VALID_SAMPLE_COUNT,
			Math.min(MAX_TOOL_SAMPLE_COUNT, Math.floor(sampleCount)),
		)
		: DEFAULT_SAMPLE_COUNT;

	const perPercents = Array.from({ length: liveOpponentCount }, (_, index) => {
		const raw = Array.isArray(rangePercents) && Number.isFinite(rangePercents[index])
			? rangePercents[index]
			: rangePercent;
		return Math.max(1, Math.min(100, Math.round(raw)));
	});

	const normalizedHole = holeCards.map(normalizeCard);
	const normalizedBoard = board.map(normalizeCard);
	const known = new Set([...normalizedHole, ...normalizedBoard]);
	const unseen = [];
	for (const card of FULL_DECK) {
		if (!known.has(card)) {
			unseen.push(card);
		}
	}
	// Range combos that remain possible given the public cards. Cache the filtered list per width
	// so several opponents with the same range do not refilter 1326 combos each.
	const rangeListByPercent = new Map();
	for (const percent of perPercents) {
		if (!rangeListByPercent.has(percent)) {
			rangeListByPercent.set(
				percent,
				getRangeCombos(percent).filter(([a, b]) => !known.has(a) && !known.has(b)),
			);
		}
	}
	const availableRanges = perPercents.map((percent) => rangeListByPercent.get(percent));
	if (availableRanges.some((list) => list.length === 0)) {
		return null;
	}
	const missingBoardCount = 5 - normalizedBoard.length;
	if (unseen.length < missingBoardCount) {
		return null;
	}

	const unseenWorking = unseen.slice();
	const heroPrefix = normalizedHole.concat();
	const boardPrefix = normalizedBoard.concat();
	let equitySum = 0;

	for (let iteration = 0; iteration < iterations; iteration++) {
		const taken = new Set();
		const opponentHoles = [];
		for (const list of availableRanges) {
			const combo = pickRangeCombo(list, taken);
			if (!combo) {
				break;
			}
			opponentHoles.push(combo);
			taken.add(combo[0]);
			taken.add(combo[1]);
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
	const uniformPercent = perPercents.every((percent) => percent === perPercents[0]) ? perPercents[0] : null;
	return {
		equity,
		samples: iterations,
		opponentCount: liveOpponentCount,
		stderr: equityStderr(equity, iterations),
		rangePercent: uniformPercent,
		rangePercents: perPercents,
	};
}

// Uniformly picks a starting combo from `list` while avoiding card conflicts with hands already
// assigned this iteration. Falls back to scanning forward from a random offset.
function pickRangeCombo(list, taken) {
	const start = Math.floor(rng() * list.length);
	for (let step = 0; step < list.length; step++) {
		const combo = list[(start + step) % list.length];
		if (!taken.has(combo[0]) && !taken.has(combo[1])) {
			return combo;
		}
	}
	return null;
}
