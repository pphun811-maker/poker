import { buildInsights } from "./insights.js";

function assertEquals(actual, expected, message = "") {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${message} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
	}
}

function assertTrue(value, message = "") {
	if (!value) {
		throw new Error(message || "expected truthy value");
	}
}

function between(value, low, high, message = "") {
	assertTrue(
		typeof value === "number" && value >= low && value <= high,
		`${message}: ${value} not in [${low}, ${high}]`,
	);
}

function hero(overrides = {}) {
	return {
		seatIndex: 0,
		name: "Agent",
		chips: 2000,
		roundBet: 0,
		totalBet: 0,
		folded: false,
		allIn: false,
		dealer: true,
		holeCards: ["AS", "AD"],
		...overrides,
	};
}

function actionState(overrides = {}) {
	return {
		needToCall: 20,
		minAmount: 20,
		maxAmount: 2000,
		minRaise: 40,
		maxRaiseAmount: 2000,
		canCheck: false,
		...overrides,
	};
}

function makeState(overrides = {}) {
	return {
		agentSeatIndex: 0,
		handId: 1,
		phase: "preflop",
		communityCards: [],
		pot: 30,
		currentBet: 20,
		lastRaise: 20,
		smallBlind: 10,
		bigBlind: 20,
		blindLevel: 0,
		gameFinished: false,
		players: [
			hero(),
			{
				seatIndex: 1,
				name: "Bot 1",
				chips: 2000,
				roundBet: 20,
				totalBet: 20,
				folded: false,
				allIn: false,
				bigBlind: true,
			},
		],
		actions: [],
		actionState: actionState(),
		...overrides,
	};
}

Deno.test("preflop: aces on the button are a raise, with no postflop sections", () => {
	const insights = buildInsights({ state: makeState(), handResults: [], samples: 400 });
	assertTrue(insights.preflop, "preflop table present");
	assertEquals(insights.preflop.handClass, "AA");
	assertTrue(insights.preflop.topPercent <= 1, "AA is in the top percentile");
	assertEquals(insights.preflop.seatClass, "button");
	assertEquals(insights.preflop.suggestedAction, "raise");
	assertTrue(insights.preflop.flags.inOpenRange, "AA is inside the button open range");
	assertTrue(insights.draws === null, "draws omitted preflop");
	assertTrue(insights.sizing.options.length > 0, "sizing options present");
	between(insights.equity.vsRangePct, 60, 90, "AA equity vs a wide range");
	assertTrue(insights.headline.length >= 2, "headline populated");
});

Deno.test("preflop: short-stack button enters push/fold mode", () => {
	const shortHero = hero({ chips: 100, holeCards: ["AS", "3S"] });
	const state = makeState({
		pot: 30,
		players: [
			shortHero,
			{
				seatIndex: 1,
				name: "Bot 1",
				chips: 2000,
				roundBet: 20,
				totalBet: 20,
				folded: false,
				allIn: false,
				bigBlind: true,
			},
		],
		actionState: actionState({ needToCall: 20, maxAmount: 100, maxRaiseAmount: 100 }),
	});
	const insights = buildInsights({ state, handResults: [], samples: 200 });
	assertTrue(insights.preflop.flags.pushFoldMode, "M under 8 activates push/fold");
	assertEquals(insights.preflop.suggestedAction, "allin");
	assertTrue(insights.preflop.rationale.includes("push/fold"), "rationale explains push/fold");
});

Deno.test("postflop: flush draw reports nine outs and completion, not win probability", () => {
	const state = makeState({
		handId: 2,
		phase: "flop",
		communityCards: ["QH", "7H", "2C"],
		pot: 500,
		currentBet: 100,
		lastRaise: 100,
		players: [
			hero({ chips: 1400, holeCards: ["AH", "KH"], dealer: true }),
			{
				seatIndex: 1,
				name: "Bot 1",
				chips: 1400,
				roundBet: 100,
				totalBet: 300,
				folded: false,
				allIn: false,
				bigBlind: true,
			},
		],
		actionState: actionState({
			needToCall: 100,
			minAmount: 100,
			maxAmount: 1400,
			minRaise: 200,
			maxRaiseAmount: 1400,
			canCheck: false,
		}),
	});
	const insights = buildInsights({ state, handResults: [], samples: 600 });
	assertEquals(insights.preflop, null, "preflop table omitted postflop");
	assertTrue(insights.draws.available, "draws available");
	assertEquals(insights.draws.flushDraw.suit, "H");
	assertEquals(insights.draws.flushDraw.outs, 9);
	assertEquals(insights.draws.straightDraw, null);
	assertEquals(insights.draws.outs.clean, 9);
	between(insights.draws.byRiverCompletionPct, 30, 40, "flush draw completes about 35% by river");
	between(insights.draws.nextCardCompletionPct, 15, 22, "one-card flush completion about 19%");
	assertTrue(insights.draws.note.includes("not win probability"), "note separates completion from win equity");
	assertTrue(insights.sizing.options.some((option) => option.label === "pot"), "pot sizing option present");
});

Deno.test("postflop: open-ended straight draw reports eight outs", () => {
	const state = makeState({
		handId: 3,
		phase: "flop",
		communityCards: ["7H", "6C", "2D"],
		pot: 200,
		currentBet: 50,
		lastRaise: 50,
		players: [
			hero({ chips: 1600, holeCards: ["9S", "8S"] }),
			{ seatIndex: 1, name: "Bot 1", chips: 1600, roundBet: 50, totalBet: 100, folded: false, allIn: false },
		],
		actionState: actionState({ needToCall: 50, minRaise: 100, maxRaiseAmount: 1600, maxAmount: 1600 }),
	});
	const insights = buildInsights({ state, handResults: [], samples: 400 });
	assertEquals(insights.draws.straightDraw.type, "openEnded");
	assertEquals(insights.draws.straightDraw.outs, 8);
	assertEquals(insights.draws.flushDraw, null);
	assertEquals(insights.draws.outs.clean, 8);
});

Deno.test("sizing: amount is additional chips and raiseToTotal is street total", () => {
	const state = makeState({
		phase: "flop",
		communityCards: ["QH", "7H", "2C"],
		pot: 500,
		currentBet: 100,
		lastRaise: 100,
		players: [
			hero({ chips: 1400, roundBet: 25, holeCards: ["AH", "KH"] }),
			{ seatIndex: 1, name: "Bot 1", chips: 1400, roundBet: 100, totalBet: 300, folded: false, allIn: false },
		],
		actionState: actionState({
			needToCall: 75,
			minRaise: 175,
			maxRaiseAmount: 1375,
			maxAmount: 1400,
			canCheck: false,
		}),
	});
	const insights = buildInsights({ state, handResults: [], samples: 200 });
	const sizing = insights.sizing;
	assertTrue(sizing.amountSemantics.includes("additional chips"));
	for (const option of sizing.options) {
		assertEquals(option.raiseToTotal, sizing.roundBet + option.amount);
		assertTrue(option.amount >= sizing.legal.minRaise, `${option.label} respects min raise`);
		assertTrue(option.amount <= sizing.legal.maxRaiseAmount, `${option.label} respects max raise`);
	}
	assertTrue(sizing.options.some((option) => option.label === "pot"));
});

Deno.test("range equity: public reads widen a maniac's range", () => {
	const handResults = Array.from({ length: 6 }, (_, index) => ({
		handId: index + 1,
		state: {
			handId: index + 1,
			actions: [{
				phase: "preflop",
				seatIndex: 1,
				name: "Bot 1",
				request: { action: "raise", amount: 60 },
				resolved: { action: "raise", amount: 60 },
			}],
			potResults: [],
			winners: [],
			hadShowdown: false,
			players: [{ seatIndex: 1, name: "Bot 1" }],
		},
	}));
	const state = makeState({
		currentBet: 60,
		lastRaise: 40,
		actions: [{
			phase: "preflop",
			seatIndex: 1,
			name: "Bot 1",
			resolved: { action: "raise", amount: 60 },
		}],
		actionState: actionState({ needToCall: 60, minRaise: 100, maxRaiseAmount: 2000 }),
	});
	const insights = buildInsights({ state, handResults, samples: 400 });
	assertTrue(insights.equity.vsRangePct !== null, "range equity available");
	assertEquals(insights.equity.rangeOpponents.length, 1);
	assertTrue(
		insights.equity.rangeOpponents[0].rangeTopPct >= 30,
		`loose raiser modeled wide: ${insights.equity.rangeOpponents[0].rangeTopPct}`,
	);
});

Deno.test("preflop: heads-up small blind opens ATo instead of folding it", () => {
	const state = makeState({
		pot: 30,
		currentBet: 20,
		lastRaise: 20,
		players: [
			hero({ chips: 2000, holeCards: ["AS", "TD"], dealer: true, smallBlind: true, roundBet: 10 }),
			{
				seatIndex: 1,
				name: "Bot 1",
				chips: 2000,
				roundBet: 20,
				totalBet: 20,
				folded: false,
				allIn: false,
				bigBlind: true,
			},
		],
		actionState: actionState({
			needToCall: 10,
			minAmount: 10,
			maxAmount: 2000,
			minRaise: 30,
			maxRaiseAmount: 2000,
			canCheck: false,
		}),
	});
	const insights = buildInsights({ state, handResults: [], samples: 200 });
	assertTrue(insights.position.headsUp, "heads-up detected");
	assertTrue(insights.preflop.topPercent <= 30, "ATo is in the top third");
	assertEquals(insights.preflop.suggestedAction, "raise", "HU SB should open ATo");
});

Deno.test("preflop: facing all-in suggestion follows the shove rule", () => {
	const state = makeState({
		pot: 100,
		currentBet: 900,
		lastRaise: 900,
		players: [
			hero({ chips: 1000, holeCards: ["AS", "TD"], roundBet: 0 }),
			{ seatIndex: 1, name: "Bot 1", chips: 0, roundBet: 900, totalBet: 900, folded: false, allIn: true },
		],
		actionState: actionState({
			needToCall: 900,
			minAmount: 900,
			maxAmount: 1000,
			minRaise: 1800,
			maxRaiseAmount: 1000,
			canCheck: false,
		}),
	});
	const insights = buildInsights({ state, handResults: [], samples: 400 });
	assertTrue(insights.shoveWarning, "shove warning present");
	assertTrue(insights.shove.rangeEquityPct !== null, "shove range equity available");
	assertTrue(
		insights.shove.rangeEquityPct < insights.shove.callBreakevenEquityPct + 5,
		"range equity below the call threshold",
	);
	assertEquals(insights.preflop.suggestedAction, "fold", "suggestion must match the shove rule");
});

Deno.test("draws: four suited board cards are shared, not clean flush outs", () => {
	const state = makeState({
		handId: 4,
		phase: "turn",
		communityCards: ["QH", "7H", "2H", "9H"],
		pot: 300,
		currentBet: 100,
		lastRaise: 100,
		players: [
			hero({ chips: 1000, holeCards: ["AS", "KD"] }),
			{ seatIndex: 1, name: "Bot 1", chips: 1000, roundBet: 100, totalBet: 200, folded: false, allIn: false },
		],
		actionState: actionState({ needToCall: 100, minRaise: 200, maxRaiseAmount: 1000, maxAmount: 1000 }),
	});
	const insights = buildInsights({ state, handResults: [], samples: 200 });
	assertEquals(insights.draws.flushDraw, null, "board flush is not your draw");
	assertEquals(insights.draws.sharedBoardFlushSuit, "H");
	assertEquals(insights.draws.outs.flush, 0, "shared flush contributes zero outs");
	assertEquals(insights.draws.outs.clean, 0, "no clean flush outs from a four-suited board");
	assertTrue(insights.draws.note.includes("shared"), "note explains the shared board flush");
});

Deno.test("sizing: cover-shortest names the amount that puts a short stack all-in", () => {
	const state = makeState({
		handId: 64,
		phase: "river",
		communityCards: ["6H", "2C", "2D", "3H", "2S"],
		pot: 4200,
		currentBet: 0,
		lastRaise: 100,
		players: [
			hero({ chips: 6634, roundBet: 0, holeCards: ["AS", "TD"] }),
			{ seatIndex: 1, name: "Bot 1", chips: 1130, roundBet: 0, totalBet: 0, folded: false, allIn: false },
		],
		actionState: actionState({
			needToCall: 0,
			minAmount: 0,
			maxAmount: 6634,
			minRaise: 100,
			maxRaiseAmount: 6634,
			canCheck: true,
		}),
	});
	const insights = buildInsights({ state, handResults: [], samples: 200 });
	const cover = insights.sizing.options.find((option) => option.label === "cover shortest");
	assertTrue(cover, "cover-shortest option present");
	assertEquals(cover.amount, 1130, "amount covers the short stack exactly");
	assertEquals(cover.raiseToTotal, 1130);
	assertEquals(cover.targetSeatIndex, 1);
	assertTrue(cover.amount < insights.sizing.allInAmount, "does not turn into a full-stack all-in");
});

Deno.test("preflop: a call-range hand folds when vsRange is below breakeven", () => {
	const state = makeState({
		handId: 29,
		pot: 540,
		currentBet: 320,
		lastRaise: 220,
		smallBlind: 50,
		bigBlind: 100,
		players: [
			hero({ chips: 5225, holeCards: ["QS", "JD"], dealer: true }),
			{ seatIndex: 1, name: "Bot 1", chips: 3000, folded: true },
			{ seatIndex: 2, name: "Bot 2", chips: 3000, folded: true },
			{
				seatIndex: 3,
				name: "Bot 3",
				chips: 3000,
				roundBet: 320,
				totalBet: 320,
				folded: false,
				allIn: false,
				bigBlind: true,
			},
			{ seatIndex: 4, name: "Bot 4", chips: 3000, folded: false, allIn: false, smallBlind: true },
		],
		actions: [{
			phase: "preflop",
			seatIndex: 3,
			name: "Bot 3",
			resolved: { action: "raise", amount: 320 },
		}],
		actionState: actionState({
			needToCall: 320,
			minAmount: 320,
			maxAmount: 5225,
			minRaise: 540,
			maxRaiseAmount: 5225,
			canCheck: false,
		}),
	});
	const insights = buildInsights({ state, handResults: [], samples: 800 });
	assertTrue(insights.preflop.flags.inCallRange, "static table puts QJo in the call range");
	assertTrue(
		insights.equity.vsRangePct + 1 < insights.economics.callBreakevenEquityPct,
		"range equity is below breakeven",
	);
	assertEquals(insights.preflop.suggestedAction, "fold", "suggestion must not contradict vsRange");
	assertTrue(insights.preflop.rationale.includes("vsRange"), "rationale names the range number");
});
