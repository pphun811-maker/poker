/* ==================================================================================================
MODULE BOUNDARY: Multiplayer Sync Relay
================================================================================================== */

// CURRENT STATE: Small stateless-ish HTTP relay for the browser table. The host posts the full
// synchronized view plus a private token per human seat; each seat polls only its own projection,
// so no visitor can read another seat's hole cards by changing the seat index. Actions are stored
// per turn token and handed back to the host; the host remains the only game engine.
// TARGET STATE: Stay a transport + projection service. Never evaluate poker rules and never expose
// a full view response to a seat token.
// PUT HERE: Relay storage (Deno KV or in-memory for local development), request validation, CORS,
// per-seat projections, and action hand-off.
// DO NOT PUT HERE: Poker rules, bot decisions, UI rendering, or game-state mutation logic.

const DEFAULT_PORT = 8787;
const DEPLOY_PORT = 8000;
const DEFAULT_HOST = "0.0.0.0";
const TABLE_TTL_MS = 8 * 60 * 60 * 1000;
const ACTION_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SEATS = 9;
const MAX_HOLE_CARDS = 2;
const SYNC_VIEW_SCHEMA_VERSION = 7;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{12,128}$/;
const ALLOWED_ACTIONS = new Set(["fold", "check", "call", "raise", "allin"]);

const DEFAULT_ALLOWED_ORIGINS = [
	"https://pphun811-maker.github.io",
	"http://localhost:8000",
	"http://127.0.0.1:8000",
];

const CORS_BASE_HEADERS = {
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "86400",
	"vary": "Origin",
};

/* --------------------------------------------------------------------------------------------------
Errors And Validation
---------------------------------------------------------------------------------------------------*/

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireTableId(value) {
	if (typeof value !== "string" || !TABLE_ID_PATTERN.test(value)) {
		throw new HttpError(400, "invalid tableId");
	}
	return value;
}

function requireToken(value, label = "token") {
	if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
		throw new HttpError(400, `invalid ${label}`);
	}
	return value;
}

function parseSeatIndex(value) {
	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed >= MAX_SEATS) {
		throw new HttpError(400, "invalid seatIndex");
	}
	return parsed;
}

function parseSinceVersion(value) {
	if (value === null || value === undefined || value === "") {
		return 0;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new HttpError(400, "invalid sinceVersion");
	}
	return parsed;
}

function parseHumanSeats(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEATS) {
		throw new HttpError(400, "invalid humanSeats");
	}
	const seats = [];
	const seen = new Set();
	for (const entry of value) {
		if (!isRecord(entry)) {
			throw new HttpError(400, "invalid humanSeats entry");
		}
		const seatIndex = parseSeatIndex(entry.seatIndex);
		if (seen.has(seatIndex)) {
			throw new HttpError(400, "duplicate human seat");
		}
		seen.add(seatIndex);
		seats.push({ seatIndex, token: requireToken(entry.token, "seat token") });
	}
	return seats;
}

function parseSeatView(value, humanSeatsByIndex) {
	if (!isRecord(value)) {
		throw new HttpError(400, "invalid seatView");
	}
	const seatIndex = parseSeatIndex(value.seatIndex);
	if (!humanSeatsByIndex.has(seatIndex)) {
		throw new HttpError(400, "seatView for a non-human seat");
	}
	if (!Array.isArray(value.holeCards) || value.holeCards.length > MAX_HOLE_CARDS) {
		throw new HttpError(400, "invalid seat holeCards");
	}
	return value;
}

function parseView(value) {
	if (!isRecord(value) || !isRecord(value.table) || !Array.isArray(value.seatViews)) {
		throw new HttpError(400, "invalid view");
	}
	if (value.seatViews.length > MAX_SEATS) {
		throw new HttpError(400, "too many seatViews");
	}
	return value;
}

// The view may only contain private data for declared human seats. Bot seats must never be
// addressable through a seat token.
function validateHumanView(view, humanSeats) {
	const byIndex = new Map(humanSeats.map((seat) => [seat.seatIndex, seat]));
	const seatViews = view.seatViews.map((seatView) => parseSeatView(seatView, byIndex));
	const viewIndexes = new Set(seatViews.map((seatView) => seatView.seatIndex));
	if (viewIndexes.size !== humanSeats.length) {
		throw new HttpError(400, "humanSeats and seatViews do not match");
	}
	return seatViews;
}

async function readJsonBody(req) {
	const declaredLength = Number.parseInt(req.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		throw new HttpError(413, "payload too large");
	}
	const text = await req.text();
	if (text.length > MAX_BODY_BYTES) {
		throw new HttpError(413, "payload too large");
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid json");
	}
	if (!isRecord(parsed)) {
		throw new HttpError(400, "invalid payload");
	}
	return parsed;
}

/* --------------------------------------------------------------------------------------------------
Storage - Deno KV In Production, In-Memory For Local Development Or Tests
---------------------------------------------------------------------------------------------------*/

const TABLE_KEY = (tableId) => ["poker-sync", "table", tableId];
const ACTION_KEY = (tableId) => ["poker-sync", "action", tableId];

export class MemoryStore {
	constructor({ now = Date.now } = {}) {
		this.now = now;
		this.kind = "memory";
		this.tables = new Map();
		this.actions = new Map();
	}

	async getTable(tableId) {
		const entry = this.tables.get(tableId);
		if (!entry) {
			return null;
		}
		if (entry.expiresAt <= this.now()) {
			this.tables.delete(tableId);
			return null;
		}
		return structuredClone(entry.value);
	}

	async setTable(tableId, record) {
		this.tables.set(tableId, {
			value: structuredClone(record),
			expiresAt: this.now() + TABLE_TTL_MS,
		});
	}

	async deleteTable(tableId) {
		this.tables.delete(tableId);
		this.actions.delete(tableId);
	}

	async getAction(tableId) {
		const entry = this.actions.get(tableId);
		if (!entry) {
			return null;
		}
		if (entry.expiresAt <= this.now()) {
			this.actions.delete(tableId);
			return null;
		}
		return structuredClone(entry.value);
	}

	async setAction(tableId, action) {
		this.actions.set(tableId, {
			value: structuredClone(action),
			expiresAt: this.now() + ACTION_TTL_MS,
		});
	}
}

export class KvStore {
	constructor(kv, { now = Date.now } = {}) {
		this.kv = kv;
		this.now = now;
		this.kind = "kv";
	}

	async getTable(tableId) {
		const entry = await this.kv.get(TABLE_KEY(tableId));
		const record = entry.value ?? null;
		if (!record) {
			return null;
		}
		// expireIn is the primary cleanup mechanism; this guard also covers deployments or browser
		// mocks where KV TTL is not honored.
		if ((record.updatedAt ?? 0) + TABLE_TTL_MS <= this.now()) {
			await this.kv.delete(TABLE_KEY(tableId));
			return null;
		}
		return record;
	}

	async setTable(tableId, record) {
		try {
			await this.kv.set(TABLE_KEY(tableId), record, { expireIn: TABLE_TTL_MS });
		} catch {
			// Some KV backends do not implement TTL options; the record-level expiry guard above
			// still keeps reads correct.
			await this.kv.set(TABLE_KEY(tableId), record);
		}
	}

	async deleteTable(tableId) {
		await this.kv.delete(TABLE_KEY(tableId));
		await this.kv.delete(ACTION_KEY(tableId));
	}

	async getAction(tableId) {
		const entry = await this.kv.get(ACTION_KEY(tableId));
		const action = entry.value ?? null;
		if (!action) {
			return null;
		}
		if ((action.receivedAt ?? 0) + ACTION_TTL_MS <= this.now()) {
			await this.kv.delete(ACTION_KEY(tableId));
			return null;
		}
		return action;
	}

	async setAction(tableId, action) {
		try {
			await this.kv.set(ACTION_KEY(tableId), action, { expireIn: ACTION_TTL_MS });
		} catch {
			await this.kv.set(ACTION_KEY(tableId), action);
		}
	}
}

export async function openDefaultStore({ logger = console } = {}) {
	const mode = Deno.env.get("SYNC_STORAGE");
	if (mode === "memory") {
		logger.log("SYNC_STORAGE=memory: using in-process storage (state resets on restart).");
		return new MemoryStore();
	}
	try {
		const kv = await Deno.openKv();
		return new KvStore(kv);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(
			`Deno KV unavailable (${message}); falling back to in-memory storage. ` +
				"Use this for local development only.",
		);
		return new MemoryStore();
	}
}

/* --------------------------------------------------------------------------------------------------
HTTP Helpers
---------------------------------------------------------------------------------------------------*/

function buildCorsHeaders(origin, allowedOrigins) {
	const headers = { ...CORS_BASE_HEADERS };
	if (origin && isAllowedOrigin(origin, allowedOrigins)) {
		headers["access-control-allow-origin"] = origin;
	}
	return headers;
}

function isAllowedOrigin(origin, allowedOrigins) {
	if (!origin || allowedOrigins.has("*")) {
		return true;
	}
	if (allowedOrigins.has(origin)) {
		return true;
	}
	try {
		const url = new URL(origin);
		const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
			url.hostname === "::1";
		return isLocal && (url.protocol === "http:" || url.protocol === "https:");
	} catch {
		return false;
	}
}

function jsonResponse(body, status, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		},
	});
}

function emptyResponse(status, headers = {}) {
	return new Response(null, { status, headers });
}

function methodNotAllowed(headers) {
	return jsonResponse({ error: "method not allowed" }, 405, headers);
}

/* --------------------------------------------------------------------------------------------------
Handlers
---------------------------------------------------------------------------------------------------*/

export function createSyncHandler({
	store,
	allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
	now = Date.now,
	logger = console,
} = {}) {
	if (!store) {
		throw new Error("createSyncHandler requires a store");
	}
	const allowed = new Set(allowedOrigins);

	async function handlePostState(req, corsHeaders) {
		const body = await readJsonBody(req);
		const tableId = requireTableId(body.tableId);
		const hostToken = requireToken(body.hostToken, "hostToken");
		const humanSeats = parseHumanSeats(body.humanSeats);
		const view = parseView(body.view);
		const seatViews = validateHumanView(view, humanSeats);

		const existing = await store.getTable(tableId);
		if (existing && existing.hostToken !== hostToken) {
			throw new HttpError(403, "host token mismatch");
		}

		const normalizedView = { ...view, seatViews };
		const sameView = existing &&
			JSON.stringify(existing.view) === JSON.stringify(normalizedView) &&
			JSON.stringify(existing.humanSeats) === JSON.stringify(humanSeats);
		if (sameView) {
			return jsonResponse(
				{ version: existing.version, updatedAt: existing.updatedAt },
				200,
				corsHeaders,
			);
		}

		const record = {
			tableId,
			hostToken,
			humanSeats,
			view: normalizedView,
			version: (existing?.version ?? 0) + 1,
			createdAt: existing?.createdAt ?? now(),
			updatedAt: now(),
			schemaVersion: typeof body.schemaVersion === "number" ? body.schemaVersion : SYNC_VIEW_SCHEMA_VERSION,
		};
		await store.setTable(tableId, record);
		return jsonResponse({ version: record.version, updatedAt: record.updatedAt }, 200, corsHeaders);
	}

	async function handleGetState(url, corsHeaders) {
		const tableId = requireTableId(url.searchParams.get("tableId"));
		const seatIndex = parseSeatIndex(url.searchParams.get("seatIndex"));
		const token = requireToken(url.searchParams.get("token"));
		const sinceVersion = parseSinceVersion(url.searchParams.get("sinceVersion"));

		const record = await store.getTable(tableId);
		if (!record) {
			throw new HttpError(404, "table not found");
		}
		const humanSeat = record.humanSeats.find((seat) => seat.seatIndex === seatIndex);
		if (!humanSeat || humanSeat.token !== token) {
			throw new HttpError(403, "seat not available");
		}
		const seatView = record.view.seatViews.find((seat) => seat.seatIndex === seatIndex);
		if (!seatView) {
			throw new HttpError(403, "seat not available");
		}
		if (record.version <= sinceVersion) {
			return emptyResponse(204, corsHeaders);
		}
		return jsonResponse(
			{
				table: record.view.table,
				seat: seatView,
				version: record.version,
				updatedAt: record.updatedAt,
				schemaVersion: record.schemaVersion ?? SYNC_VIEW_SCHEMA_VERSION,
			},
			200,
			corsHeaders,
		);
	}

	async function handlePostAction(req, corsHeaders) {
		const body = await readJsonBody(req);
		const tableId = requireTableId(body.tableId);
		const seatIndex = parseSeatIndex(body.seatIndex);
		const token = requireToken(body.token);
		const turnToken = requireToken(body.turnToken, "turnToken");
		if (typeof body.action !== "string" || !ALLOWED_ACTIONS.has(body.action)) {
			throw new HttpError(400, "invalid action");
		}
		let amount = null;
		if (body.amount !== null && body.amount !== undefined) {
			amount = Number.parseInt(body.amount, 10);
			if (!Number.isInteger(amount) || amount < 0) {
				throw new HttpError(400, "invalid action amount");
			}
		}

		const record = await store.getTable(tableId);
		if (!record) {
			throw new HttpError(404, "table not found");
		}
		const humanSeat = record.humanSeats.find((seat) => seat.seatIndex === seatIndex);
		if (!humanSeat || humanSeat.token !== token) {
			throw new HttpError(403, "seat not available");
		}
		const pendingAction = record.view.table?.pendingAction ?? null;
		if (
			!isRecord(pendingAction) ||
			pendingAction.turnToken !== turnToken ||
			pendingAction.seatIndex !== seatIndex
		) {
			throw new HttpError(409, "turn is no longer active");
		}

		const existingAction = await store.getAction(tableId);
		if (existingAction?.turnToken === turnToken) {
			// Let a seat correct an action that the host rejected (for example a stale raise) until
			// the turn itself changes. The host only consumes the latest value once per poll.
			await store.setAction(tableId, {
				tableId,
				seatIndex,
				turnToken,
				action: body.action,
				amount,
				receivedAt: now(),
			});
			return jsonResponse({ ok: true, replaced: true }, 200, corsHeaders);
		}

		await store.setAction(tableId, {
			tableId,
			seatIndex,
			turnToken,
			action: body.action,
			amount,
			receivedAt: now(),
		});
		return jsonResponse({ ok: true }, 200, corsHeaders);
	}

	async function handleGetAction(url, corsHeaders) {
		const tableId = requireTableId(url.searchParams.get("tableId"));
		const turnToken = requireToken(url.searchParams.get("turnToken"), "turnToken");
		const hostToken = requireToken(url.searchParams.get("hostToken"), "hostToken");

		const record = await store.getTable(tableId);
		if (!record) {
			throw new HttpError(404, "table not found");
		}
		if (record.hostToken !== hostToken) {
			throw new HttpError(403, "host token mismatch");
		}
		const pendingAction = record.view.table?.pendingAction ?? null;
		if (!isRecord(pendingAction) || pendingAction.turnToken !== turnToken) {
			return emptyResponse(204, corsHeaders);
		}
		const action = await store.getAction(tableId);
		if (!action || action.turnToken !== turnToken) {
			return emptyResponse(204, corsHeaders);
		}
		return jsonResponse(
			{
				seatIndex: action.seatIndex,
				turnToken: action.turnToken,
				action: action.action,
				amount: action.amount,
			},
			200,
			corsHeaders,
		);
	}

	async function handleDeleteState(url, corsHeaders) {
		const tableId = requireTableId(url.searchParams.get("tableId"));
		const hostToken = requireToken(url.searchParams.get("hostToken"), "hostToken");
		const record = await store.getTable(tableId);
		if (!record) {
			return emptyResponse(204, corsHeaders);
		}
		if (record.hostToken !== hostToken) {
			throw new HttpError(403, "host token mismatch");
		}
		await store.deleteTable(tableId);
		return emptyResponse(204, corsHeaders);
	}

	return async function handleSyncRequest(req) {
		const url = new URL(req.url);
		const origin = req.headers.get("origin");
		const corsHeaders = buildCorsHeaders(origin, allowed);

		if (origin && !isAllowedOrigin(origin, allowed)) {
			return jsonResponse({ error: "origin not allowed" }, 403);
		}
		if (req.method === "OPTIONS") {
			return emptyResponse(204, corsHeaders);
		}

		try {
			if (url.pathname === "/" && req.method === "GET") {
				return new Response("Poker sync relay is running.\n", {
					status: 200,
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"cache-control": "no-store",
						...corsHeaders,
					},
				});
			}
			if (url.pathname === "/health" && req.method === "GET") {
				return jsonResponse(
					{ ok: true, storage: store.kind, now: now() },
					200,
					corsHeaders,
				);
			}
			if (url.pathname === "/state") {
				switch (req.method) {
					case "POST":
						return await handlePostState(req, corsHeaders);
					case "GET":
						return await handleGetState(url, corsHeaders);
					case "DELETE":
						return await handleDeleteState(url, corsHeaders);
					default:
						return methodNotAllowed(corsHeaders);
				}
			}
			if (url.pathname === "/action") {
				switch (req.method) {
					case "POST":
						return await handlePostAction(req, corsHeaders);
					case "GET":
						return await handleGetAction(url, corsHeaders);
					default:
						return methodNotAllowed(corsHeaders);
				}
			}
			return jsonResponse({ error: "not found" }, 404, corsHeaders);
		} catch (error) {
			if (error instanceof HttpError) {
				return jsonResponse({ error: error.message }, error.status, corsHeaders);
			}
			logger.error("sync relay request failed", error);
			return jsonResponse({ error: "internal server error" }, 500, corsHeaders);
		}
	};
}

function parseServerArgs(args) {
	const envPort = Number.parseInt(Deno.env.get("PORT") ?? "", 10);
	const isDeployed = Boolean(
		Deno.env.get("DENO_DEPLOYMENT_ID") || Deno.env.get("DENO_DEPLOY_REGION"),
	);
	const defaultPort = isDeployed ? DEPLOY_PORT : DEFAULT_PORT;
	const config = {
		port: Number.isInteger(envPort) && envPort > 0 ? envPort : defaultPort,
		host: Deno.env.get("HOST") || DEFAULT_HOST,
	};
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

function getAllowedOriginsFromEnv() {
	const raw = Deno.env.get("ALLOWED_ORIGINS");
	if (!raw) {
		return DEFAULT_ALLOWED_ORIGINS;
	}
	return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

if (import.meta.main) {
	const config = parseServerArgs(Deno.args);
	const store = await openDefaultStore();
	const handler = createSyncHandler({
		store,
		allowedOrigins: getAllowedOriginsFromEnv(),
	});
	Deno.serve({ port: config.port, hostname: config.host }, handler);
	console.log(
		`Poker sync relay listening on http://${config.host}:${config.port} (${store.kind} storage)`,
	);
}
