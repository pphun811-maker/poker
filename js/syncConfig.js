/* ==================================================================================================
MODULE BOUNDARY: Sync Endpoint Configuration
================================================================================================== */

// CURRENT STATE: Single place that resolves which relay the browser table talks to. A deployed
// default is used for normal visitors; `?sync=` and localStorage allow local or self-hosted relays
// without rebuilding, and join links copy the resolved relay to every guest device.
// TARGET STATE: Stay a tiny, side-effect-free resolver plus link helper.
// PUT HERE: Base URL normalization, query/localStorage overrides, and endpoint construction.
// DO NOT PUT HERE: Fetching, game logic, tokens, or UI rendering.

const STORAGE_KEY = "poker:sync-base-url";
const QUERY_KEY = "sync";

// Set after deploying server/sync.js (for example https://poker-sync.example.deno.net).
// Leaving it empty keeps online seats disabled until a relay is configured.
const DEFAULT_SYNC_BASE_URL = "";

function normalizeBaseUrl(value) {
	if (typeof value !== "string" || value.trim() === "") {
		return "";
	}
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return "";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return "";
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path === "/" ? "" : path}`;
}

function readStoredBaseUrl() {
	try {
		return globalThis.localStorage?.getItem(STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

function readQueryBaseUrl() {
	try {
		const search = globalThis.location?.search ?? "";
		return new URLSearchParams(search).get(QUERY_KEY) ?? "";
	} catch {
		return "";
	}
}

export function getSyncBaseUrl() {
	return normalizeBaseUrl(readQueryBaseUrl()) ||
		normalizeBaseUrl(readStoredBaseUrl()) ||
		normalizeBaseUrl(globalThis.POKER_SYNC_BASE_URL) ||
		normalizeBaseUrl(DEFAULT_SYNC_BASE_URL);
}

// Guests receive the relay URL on their join link. Remembering it keeps companion/full-table
// switching working even after the query string is dropped.
export function rememberSyncBaseUrl() {
	const fromQuery = normalizeBaseUrl(readQueryBaseUrl());
	if (fromQuery) {
		try {
			globalThis.localStorage?.setItem(STORAGE_KEY, fromQuery);
		} catch {
			// Private browsing can reject writes; the query parameter still carries the URL.
		}
		return fromQuery;
	}
	return getSyncBaseUrl();
}

export function isSyncConfigured() {
	return getSyncBaseUrl() !== "";
}

export function getSyncEndpoints() {
	const base = getSyncBaseUrl();
	return {
		base,
		state: base ? `${base}/state` : "",
		action: base ? `${base}/action` : "",
	};
}

export function appendSyncParam(url) {
	const base = getSyncBaseUrl();
	if (base) {
		url.searchParams.set(QUERY_KEY, base);
	}
	return url;
}
