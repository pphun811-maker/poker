/* ==================================================================================================
MODULE BOUNDARY: Multiplayer Sync Relay Tests
================================================================================================== */

// Focused tests for the transport contract the host, companion, and remote-table clients rely on:
// per-seat projection, token isolation, action hand-off, CORS, and cleanup.

import { createSyncHandler, MemoryStore } from "./sync.js";

const HOST_TOKEN = "host-token-cccccccccccc";
const SEAT_1_TOKEN = "seat-token-aaaaaaaaaaaa";
const SEAT_2_TOKEN = "seat-token-bbbbbbbbbbbb";
const TURN_1_TOKEN = "turn-token-dddddddddddd";
const ALLOWED_ORIGIN = "https://table.test";

function assertEquals(actual, expected, message = "") {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`${message} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
		);
	}
}

function assertTrue(value, message = "") {
	if (!value) {
		throw new Error(message || "expected truthy value");
	}
}

function makeView({ pot = 30, pendingAction = null } = {}) {
	return {
		table: {
			phase: "preflop",
			pot,
			activeSeatIndex: 1,
			communityCards: [],
			notifications: ["Test hand"],
			playersPublic: [
				{ seatIndex: 1, name: "Alice", chips: 1990 },
				{ seatIndex: 2, name: "Bob", chips: 1980 },
			],
			chipTransfer: null,
			pendingAction,
		},
		seatViews: [
			{ seatIndex: 1, name: "Alice", chips: 1990, holeCards: ["AS", "KS"] },
			{ seatIndex: 2, name: "Bob", chips: 1980, holeCards: ["2C", "3D"] },
		],
	};
}

function makeHumanSeats() {
	return [
		{ seatIndex: 1, token: SEAT_1_TOKEN },
		{ seatIndex: 2, token: SEAT_2_TOKEN },
	];
}

function makePendingAction(turnToken = TURN_1_TOKEN, seatIndex = 1) {
	return {
		seatIndex,
		turnToken,
		needToCall: 20,
		minAmount: 20,
		maxAmount: 1990,
		canCheck: false,
		buttonLabel: "Call",
	};
}

function makeHarness() {
	let clock = 1_700_000_000_000;
	const store = new MemoryStore({ now: () => clock });
	const handler = createSyncHandler({
		store,
		allowedOrigins: [ALLOWED_ORIGIN, "https://other.test"],
		now: () => clock,
		logger: { error: () => {}, warn: () => {} },
	});
	function request(path, { method = "GET", body = null, origin = null } = {}) {
		const headers = new Headers();
		if (body !== null) {
			headers.set("content-type", "application/json");
		}
		if (origin) {
			headers.set("origin", origin);
		}
		return new Request(`https://relay.test${path}`, {
			method,
			headers,
			body: body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
		});
	}
	async function call(path, options = {}) {
		return await handler(request(path, options));
	}
	return {
		store,
		call,
		advance(ms) {
			clock += ms;
		},
	};
}

async function postState(call, overrides = {}) {
	const body = {
		tableId: "table01",
		hostToken: HOST_TOKEN,
		humanSeats: makeHumanSeats(),
		view: makeView(),
		...overrides,
	};
	return await call("/state", { method: "POST", body, origin: ALLOWED_ORIGIN });
}

Deno.test("state round trip returns only the requested seat projection", async () => {
	const { call } = makeHarness();
	const posted = await postState(call);
	assertEquals(posted.status, 200);
	const postedBody = await posted.json();
	assertEquals(postedBody.version, 1);

	const response = await call(
		`/state?tableId=table01&seatIndex=1&token=${SEAT_1_TOKEN}&sinceVersion=0`,
		{ origin: ALLOWED_ORIGIN },
	);
	assertEquals(response.status, 200);
	const payload = await response.json();
	assertEquals(payload.version, 1);
	assertEquals(payload.seat.seatIndex, 1);
	assertEquals(payload.seat.holeCards, ["AS", "KS"]);
	assertEquals(payload.table.pot, 30);
	assertTrue(!("seatViews" in payload), "projection must not include the full seat list");
	const serialized = JSON.stringify(payload);
	assertTrue(!serialized.includes("2C"), "seat 1 must not receive seat 2 hole cards");
	assertTrue(!serialized.includes("3D"), "seat 1 must not receive seat 2 hole cards");

	const unchanged = await call(
		`/state?tableId=table01&seatIndex=1&token=${SEAT_1_TOKEN}&sinceVersion=1`,
	);
	assertEquals(unchanged.status, 204);

	const wrongToken = await call(
		`/state?tableId=table01&seatIndex=1&token=${SEAT_2_TOKEN}`,
	);
	assertEquals(wrongToken.status, 403);

	const botSeat = await call(
		`/state?tableId=table01&seatIndex=3&token=${SEAT_1_TOKEN}`,
	);
	assertEquals(botSeat.status, 403);
});

Deno.test("state post rejects seat views for non-human seats", async () => {
	const { call } = makeHarness();
	const view = makeView();
	view.seatViews.push({
		seatIndex: 3,
		name: "Bot",
		chips: 2000,
		holeCards: ["AH", "AD"],
	});
	const response = await postState(call, { view });
	assertEquals(response.status, 400);
});

Deno.test("host token protects subsequent state writes", async () => {
	const { call } = makeHarness();
	assertEquals((await postState(call)).status, 200);

	const hijack = await postState(call, { hostToken: "host-token-eeeeeeeeeeee" });
	assertEquals(hijack.status, 403);

	const updated = await postState(call, {
		view: makeView({ pot: 90 }),
	});
	assertEquals(updated.status, 200);
	assertEquals((await updated.json()).version, 2);
	const state = await call(
		`/state?tableId=table01&seatIndex=2&token=${SEAT_2_TOKEN}`,
	);
	assertEquals((await state.json()).table.pot, 90);
});

Deno.test("identical state posts do not bump the version", async () => {
	const { call } = makeHarness();
	const first = await postState(call);
	assertEquals((await first.json()).version, 1);
	const second = await postState(call);
	assertEquals(second.status, 200);
	assertEquals((await second.json()).version, 1);
});

Deno.test("actions require the live turn token and the matching seat token", async () => {
	const { call } = makeHarness();
	await postState(call, {
		view: makeView({ pendingAction: makePendingAction() }),
	});

	const actionBody = {
		tableId: "table01",
		seatIndex: 1,
		token: SEAT_1_TOKEN,
		turnToken: TURN_1_TOKEN,
		action: "call",
		amount: 20,
	};

	assertEquals(
		(await call("/action", {
			method: "POST",
			body: { ...actionBody, token: SEAT_2_TOKEN },
			origin: ALLOWED_ORIGIN,
		})).status,
		403,
	);
	assertEquals(
		(await call("/action", {
			method: "POST",
			body: { ...actionBody, turnToken: "turn-token-ffffffffffff" },
		})).status,
		409,
	);

	const accepted = await call("/action", {
		method: "POST",
		body: actionBody,
		origin: ALLOWED_ORIGIN,
	});
	assertEquals(accepted.status, 200);
	const replaced = await call("/action", {
		method: "POST",
		body: { ...actionBody, action: "raise", amount: 60 },
	});
	assertEquals((await replaced.json()).replaced, true);

	const missingHostToken = await call(
		`/action?tableId=table01&turnToken=${TURN_1_TOKEN}`,
	);
	assertEquals(missingHostToken.status, 400);

	const wrongHostToken = await call(
		`/action?tableId=table01&turnToken=${TURN_1_TOKEN}&hostToken=host-token-ffffffffffff`,
	);
	assertEquals(wrongHostToken.status, 403);

	const fetched = await call(
		`/action?tableId=table01&turnToken=${TURN_1_TOKEN}&hostToken=${HOST_TOKEN}`,
	);
	assertEquals(fetched.status, 200);
	assertEquals(await fetched.json(), {
		seatIndex: 1,
		turnToken: TURN_1_TOKEN,
		action: "raise",
		amount: 60,
	});

	// A new turn invalidates the old action even before the host polls again.
	await postState(call, {
		view: makeView({ pendingAction: makePendingAction("turn-token-gggggggggggg") }),
	});
	const stale = await call(
		`/action?tableId=table01&turnToken=${TURN_1_TOKEN}&hostToken=${HOST_TOKEN}`,
	);
	assertEquals(stale.status, 204);
	const newTurnEmpty = await call(
		`/action?tableId=table01&turnToken=turn-token-gggggggggggg&hostToken=${HOST_TOKEN}`,
	);
	assertEquals(newTurnEmpty.status, 204);
});

Deno.test("CORS preflight and origin checks", async () => {
	const { call } = makeHarness();
	const preflight = await call("/state", {
		method: "OPTIONS",
		origin: ALLOWED_ORIGIN,
	});
	assertEquals(preflight.status, 204);
	assertEquals(preflight.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
	assertTrue(
		(preflight.headers.get("access-control-allow-methods") ?? "").includes("POST"),
		"preflight must allow POST",
	);

	const disallowed = await call("/state", {
		method: "POST",
		origin: "https://evil.test",
		body: {
			tableId: "table01",
			hostToken: HOST_TOKEN,
			humanSeats: makeHumanSeats(),
			view: makeView(),
		},
	});
	assertEquals(disallowed.status, 403);
	assertEquals(disallowed.headers.get("access-control-allow-origin"), null);

	const localhost = await call("/health", { origin: "http://localhost:5173" });
	assertEquals(localhost.status, 200);
	assertEquals(localhost.headers.get("access-control-allow-origin"), "http://localhost:5173");
});

Deno.test("delete removes the table and its stored action", async () => {
	const { call } = makeHarness();
	await postState(call, {
		view: makeView({ pendingAction: makePendingAction() }),
	});
	await call("/action", {
		method: "POST",
		body: {
			tableId: "table01",
			seatIndex: 1,
			token: SEAT_1_TOKEN,
			turnToken: TURN_1_TOKEN,
			action: "fold",
			amount: null,
		},
	});

	const wrongHost = await call(
		`/state?tableId=table01&hostToken=host-token-ffffffffffff`,
		{ method: "DELETE" },
	);
	assertEquals(wrongHost.status, 403);

	const deleted = await call(
		`/state?tableId=table01&hostToken=${HOST_TOKEN}`,
		{ method: "DELETE" },
	);
	assertEquals(deleted.status, 204);
	const gone = await call(
		`/state?tableId=table01&seatIndex=1&token=${SEAT_1_TOKEN}`,
	);
	assertEquals(gone.status, 404);
	assertEquals(
		(await call(
			`/action?tableId=table01&turnToken=${TURN_1_TOKEN}&hostToken=${HOST_TOKEN}`,
		)).status,
		404,
	);
});

Deno.test("request validation rejects malformed and oversized payloads", async () => {
	const { call } = makeHarness();
	assertEquals(
		(await call("/state", {
			method: "POST",
			body: { tableId: "x", hostToken: HOST_TOKEN, humanSeats: [], view: {} },
		})).status,
		400,
	);
	assertEquals(
		(await call("/state", {
			method: "POST",
			body: "{not json",
		})).status,
		400,
	);
	const oversized = await call("/state", {
		method: "POST",
		body: JSON.stringify({ padding: "x".repeat(600 * 1024) }),
	});
	assertEquals(oversized.status, 413);
	assertEquals((await call("/unknown")).status, 404);
	assertEquals(
		(await call("/state", { method: "PUT", body: { tableId: "table01" } })).status,
		405,
	);
});

Deno.test("memory store expires tables and actions", async () => {
	let clock = 0;
	const store = new MemoryStore({ now: () => clock });
	await store.setTable("table01", { version: 1 });
	await store.setAction("table01", { turnToken: TURN_1_TOKEN });
	assertTrue((await store.getTable("table01")) !== null, "table should exist");
	clock = 15 * 60 * 1000 + 1;
	assertEquals(await store.getAction("table01"), null);
	assertTrue((await store.getTable("table01")) !== null, "table should outlive actions");
	clock = 8 * 60 * 60 * 1000 + 1;
	assertEquals(await store.getTable("table01"), null);
});
