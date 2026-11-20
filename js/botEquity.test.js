import {
	estimateBotEquity,
	estimateEquityForTest,
	estimatePublicEquity,
	estimateRangeEquity,
	getBotEquityConfig,
	getHandPercentile,
	setBotEquityConfig,
} from "./botEquity.js";

function assertEquals(actual, expected, message = "") {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) {
		throw new Error(
			`${message}\nExpected: ${expectedJson}\nActual:   ${actualJson}`,
		);
	}
}

function assertAlmostEquals(actual, expected, tolerance, message = "") {
	if (!(Math.abs(actual - expected) <= tolerance)) {
		throw new Error(
			`${message}\nExpected ~${expected} (±${tolerance}), actual: ${actual}`,
		);
	}
}

function assertTrue(condition, message = "") {
	if (!condition) {
		throw new Error(message || "expected condition to hold");
	}
}

// Deterministic LCG so calibration tolerances are reproducible.
function createSeededRng(seed = 12345) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

function withEquityRng(seed, run) {
	setBotEquityConfig({ enabled: true, rng: createSeededRng(seed) });
	try {
		return run();
	} finally {
		setBotEquityConfig({ enabled: true, rng: Math.random });
	}
}

Deno.test("estimateBotEquity returns null when disabled", () => {
	setBotEquityConfig({ enabled: false });
	try {
		assertEquals(
			estimateBotEquity({
				holeCards: ["AS", "AD"],
				communityCards: ["KS", "7D", "2C"],
				opponentCount: 1,
			}),
			null,
		);
	} finally {
		setBotEquityConfig({ enabled: true, rng: Math.random });
	}
});

Deno.test("estimateBotEquity returns 1 for uncontested pots", () => {
	const result = estimateBotEquity({
		holeCards: ["AS", "AD"],
		communityCards: ["KS", "7D", "2C"],
		opponentCount: 0,
	});
	assertEquals(result.equity, 1);
	assertEquals(result.samples, 0);
});

Deno.test("estimateBotEquity rejects preflop and degenerate boards", () => {
	assertEquals(
		estimateBotEquity({
			holeCards: ["AS", "AD"],
			communityCards: [],
			opponentCount: 1,
		}),
		null,
	);
	assertEquals(
		estimateBotEquity({
			holeCards: ["AS", "AD"],
			communityCards: ["KS", "7D"],
			opponentCount: 1,
		}),
		null,
	);
});

Deno.test("ace-high flush on a five-spade river never loses or ties", () => {
	const result = withEquityRng(777, () =>
		estimateBotEquity({
			holeCards: ["AS", "KS"],
			communityCards: ["QS", "7S", "2S", "9S", "4S"],
			opponentCount: 1,
		}));
	assertAlmostEquals(result.equity, 1, 0.0001);
});

Deno.test("AA vs KK preflop matches the known matchup", () => {
	const equity = estimateEquityForTest({
		holeCards: ["AS", "AD"],
		communityCards: [],
		opponentCount: 1,
		fixedOpponentHoleCards: [["KS", "KH"]],
		iterations: 20000,
	});
	// Published all-in equity is ~81.9% (including chop paths via board double-pairings).
	assertAlmostEquals(equity, 0.819, 0.02);
});

Deno.test("flopped flush draw against one random hand lands near published equity", () => {
	const result = withEquityRng(4242, () =>
		estimateBotEquity({
			holeCards: ["5H", "3H"],
			communityCards: ["QH", "7D", "2C"],
			opponentCount: 1,
		}));
	// Nine clean outs by the river, but a 5-high flush loses to any higher heart: only ~22%
	// against a uniformly random hand (range-based figures quote ~35%).
	assertAlmostEquals(result.equity, 0.22, 0.05);
});

Deno.test("equity drops as the opponent count rises", () => {
	const { headsUp, fourWay } = withEquityRng(99, () => {
		const spot = {
			holeCards: ["AS", "AD"],
			communityCards: ["KS", "7D", "2C"],
		};
		return {
			headsUp: estimateBotEquity({ ...spot, opponentCount: 1 }),
			fourWay: estimateBotEquity({ ...spot, opponentCount: 4 }),
		};
	});
	assertTrue(fourWay.equity < headsUp.equity, "equity must fall with more opponents");
	assertTrue(fourWay.equity >= 0.5, "top set should stay ahead of four random hands");
});

Deno.test("sampling is deterministic for a fixed seed", () => {
	const spot = {
		holeCards: ["JC", "8C"],
		communityCards: ["9D", "6S", "2H"],
		opponentCount: 2,
		iterations: 4000,
	};
	const firstValue = withEquityRng(31337, () => estimateEquityForTest(spot));
	const secondValue = withEquityRng(31337, () => estimateEquityForTest(spot));
	assertEquals(firstValue, secondValue);
});

Deno.test("cache returns identical estimates for identical public inputs", () => {
	const spot = {
		holeCards: ["TC", "TD"],
		communityCards: ["4S", "8D", "KC"],
		opponentCount: 1,
	};
	const { first, second, config } = withEquityRng(808, () => {
		const first = estimateBotEquity(spot);
		const second = estimateBotEquity(spot);
		return { first, second, config: getBotEquityConfig() };
	});
	assertEquals(second.equity, first.equity);
	assertEquals(second.cached, true);
	assertEquals(config.enabled, true);
});

Deno.test("estimatePublicEquity supports preflop spots for the agent tool", () => {
	const equity = estimatePublicEquity({
		holeCards: ["AS", "AD"],
		communityCards: [],
		opponentCount: 1,
		sampleCount: 20000,
	});
	// Pocket aces against one uniformly random hand: ~85.2%.
	assertAlmostEquals(equity.equity, 0.852, 0.02);
	assertTrue(equity.stderr > 0 && equity.stderr < 0.01);
	assertTrue(equity.samples === 20000);
});

Deno.test("range equity: AA dominates the top-20% range but less than random", () => {
	const random = estimatePublicEquity({
		holeCards: ["AS", "AD"],
		communityCards: [],
		opponentCount: 1,
		sampleCount: 20000,
	});
	const range = estimateRangeEquity({
		holeCards: ["AS", "AD"],
		communityCards: [],
		opponentCount: 1,
		rangePercent: 20,
		sampleCount: 20000,
	});
	assertAlmostEquals(range.equity, 0.81, 0.05);
	assertTrue(range.equity < random.equity, "range equity must be below random equity");
});

Deno.test("range equity: K6o against a real jam range is a clear fold", () => {
	const equity = estimateRangeEquity({
		holeCards: ["KC", "6D"],
		communityCards: [],
		opponentCount: 1,
		rangePercent: 20,
		sampleCount: 20000,
	});
	// The game-1 fatal call: ~0.55 vs random but only ~0.43 vs a real shove range.
	assertAlmostEquals(equity.equity, 0.43, 0.05);
});

Deno.test("hand percentile is independent of hole-card order", () => {
	const ato = getHandPercentile(["AS", "TD"]);
	const tao = getHandPercentile(["TD", "AS"]);
	assertAlmostEquals(ato, tao, 0.01, "ATo must score the same in either dealt order");
	assertAlmostEquals(ato, 24.0, 1.0);

	const a9o = getHandPercentile(["9D", "AS"]);
	const a9oReversed = getHandPercentile(["AS", "9D"]);
	assertAlmostEquals(a9o, a9oReversed, 0.01, "A9o must score the same in either dealt order");
	assertAlmostEquals(a9o, 40.6, 1.0);
});
