/* ==================================================================================================
MODULE BOUNDARY: Cheat Panel UI
================================================================================================== */

// CURRENT STATE: Debug overlay for the local single-player table. Live-peeks at every seat's hole
// cards and lets the local player swap single hole cards against the remaining deck.
// TARGET STATE: Stay a read-mostly debug UI on top of state APIs owned by app.js.
// PUT HERE: Panel DOM building, peek rendering, per-card swap picking, table-hover sync trigger.
// DO NOT PUT HERE: Game state access (injected via initCheatPanel), game-flow logic, or anything
// reachable from bot decision code — this module is loaded by index.html only.

import { INITIAL_DECK } from "./gameEngine.js";
import { onLangChange, registerStrings, t, tf } from "./i18n.js";

const CHEAT_POLL_INTERVAL = 800;

registerStrings("cheatPanel", {
	hoverPeek: { zh: "手电筒看牌", en: "Flashlight peek" },
	pickFirst: { zh: "先点击要换掉的那张手牌", en: "Click the hole card to swap out" },
	pickReplacement: { zh: "再从下面选一张新牌", en: "Now pick a replacement below" },
});

const cheatOverlay = document.querySelector("#cheat-overlay");
const peekEl = document.querySelector("#cheat-peek");
const hoverToggle = document.querySelector("#cheat-hover-toggle");
const seatSelect = document.querySelector("#cheat-seat-select");
const currentCardsEl = document.querySelector("#cheat-current-cards");
const cardGridEl = document.querySelector("#cheat-card-grid");
const statusEl = document.querySelector("#cheat-status");

let cheatApi = null;
let selectedCardCode = null;
let pollTimer = null;
let currentHandInProgress = false;
let lastSeatSignature = "";
let lastPeekSignature = "";
let lastPeekSeatsKey = "";
let peekTableRow = null;
const peekPlayerRows = new Map();

function preloadCardFaces() {
	INITIAL_DECK.forEach((cardCode) => {
		const img = new Image();
		img.src = `cards/${cardCode}.svg`;
	});
}

function createCardImage(cardCode) {
	const img = document.createElement("img");
	img.src = `cards/${cardCode}.svg`;
	img.alt = cardCode;
	img.className = "cheat-card-img";
	return img;
}

function createPeekPlayerRow(player) {
	const row = document.createElement("div");
	row.className = "cheat-peek-row";

	const nameEl = document.createElement("span");
	nameEl.className = "cheat-peek-name";
	const status = player.busted
		? `（${t("cheat.out")}）`
		: player.folded
		? `（${t("cheat.folded")}）`
		: player.allIn
		? `（${t("cheat.allin")}）`
		: "";
	nameEl.textContent = `${player.name}${status}`;

	const cardsEl = document.createElement("span");
	cardsEl.className = "cheat-peek-cards";
	if (player.holeCards.every(Boolean)) {
		player.holeCards.forEach((cardCode) => {
			cardsEl.appendChild(createCardImage(cardCode));
		});
	} else {
		const noCards = document.createElement("span");
		noCards.textContent = "—";
		cardsEl.appendChild(noCards);
	}

	row.appendChild(nameEl);
	row.appendChild(cardsEl);
	return row;
}

function getTableSignature(state) {
	return `deck:${state.deckCount}:board:${state.communityCards.join(",")}`;
}

function getPlayerRowSignature(player) {
	return `${player.name}:${player.holeCards.join(",")}:${player.busted}:${player.folded}:${player.allIn}`;
}

function getPeekSignature(state) {
	return [
		getTableSignature(state),
		state.players.map((player) =>
			`${player.seatIndex}:${getPlayerRowSignature(player)}`
		).join("|"),
	].join(":");
}

function createPeekTableRow(state) {
	const tableRow = document.createElement("div");
	tableRow.className = "cheat-peek-row cheat-peek-table";
	const tableLabel = document.createElement("span");
	tableLabel.textContent = tf("cheat.boardCards", { count: state.deckCount });
	const boardEl = document.createElement("span");
	boardEl.className = "cheat-peek-cards";
	if (state.communityCards.length > 0) {
		state.communityCards.forEach((cardCode) => {
			boardEl.appendChild(createCardImage(cardCode));
		});
	} else {
		const noBoard = document.createElement("span");
		noBoard.textContent = "—";
		boardEl.appendChild(noBoard);
	}
	tableRow.appendChild(tableLabel);
	tableRow.appendChild(boardEl);
	return tableRow;
}

// Rows whose data did not change keep their exact DOM nodes; only genuinely
// changed rows are replaced, which keeps polling cheap.
function renderPeek(state) {
	const signature = getPeekSignature(state);
	if (signature === lastPeekSignature) {
		return;
	}
	lastPeekSignature = signature;

	const seatsKey = state.players.map((player) => player.seatIndex).join("|");
	if (seatsKey !== lastPeekSeatsKey) {
		rebuildPeekRows(state, seatsKey);
		return;
	}

	const tableSignature = getTableSignature(state);
	if (peekTableRow.signature !== tableSignature) {
		const row = createPeekTableRow(state);
		peekTableRow.el.replaceWith(row);
		peekTableRow = { signature: tableSignature, el: row };
	}
	state.players.forEach((player) => {
		const rowSignature = getPlayerRowSignature(player);
		const cached = peekPlayerRows.get(player.seatIndex);
		if (cached.signature === rowSignature) {
			return;
		}
		const row = createPeekPlayerRow(player);
		cached.el.replaceWith(row);
		peekPlayerRows.set(player.seatIndex, { signature: rowSignature, el: row });
	});
}

function rebuildPeekRows(state, seatsKey) {
	lastPeekSeatsKey = seatsKey;
	const fragment = document.createDocumentFragment();
	const tableSignature = getTableSignature(state);
	peekTableRow = { signature: tableSignature, el: createPeekTableRow(state) };
	fragment.appendChild(peekTableRow.el);
	state.players.forEach((player) => {
		const rowSignature = getPlayerRowSignature(player);
		const row = createPeekPlayerRow(player);
		peekPlayerRows.set(player.seatIndex, { signature: rowSignature, el: row });
		fragment.appendChild(row);
	});
	peekEl.replaceChildren(fragment);
}

function resetPeekCache() {
	lastPeekSignature = "";
	lastPeekSeatsKey = "";
	peekTableRow = null;
	peekPlayerRows.clear();
}

function getStatusText(player) {
	if (player.busted) {
		return t("cheat.out");
	}
	if (player.folded) {
		return t("cheat.folded");
	}
	return `${player.chips}`;
}

function renderSeatSelect(state) {
	const signature = state.players.map((player) =>
		`${player.seatIndex}:${player.name}:${player.busted ? 0 : 1}`
	).join("|");
	if (signature === lastSeatSignature) {
		return;
	}
	lastSeatSignature = signature;
	const previousValue = seatSelect.value;
	seatSelect.replaceChildren();
	state.players.forEach((player) => {
		const option = document.createElement("option");
		option.value = String(player.seatIndex);
		option.textContent = player.busted
			? `${player.name}（${getStatusText(player)}）`
			: `${player.name}（${player.isBot ? t("cheat.bot") : t("cheat.human")}）`;
		seatSelect.appendChild(option);
	});
	const stillValid = [...seatSelect.options].some((option) =>
		option.value === previousValue
	);
	seatSelect.value = stillValid ? previousValue : String(
		getDefaultSeatIndex(state),
	);
}

function getDefaultSeatIndex(state) {
	const human = state.players.find((player) =>
		!player.isBot && !player.busted && player.holeCards.every(Boolean)
	);
	if (human) {
		return human.seatIndex;
	}
	const firstWithCards = state.players.find((player) =>
		!player.busted && player.holeCards.every(Boolean)
	);
	return firstWithCards ? firstWithCards.seatIndex : null;
}

function getSelectedPlayer(state) {
	const seatIndex = Number(seatSelect.value);
	return state.players.find((player) => player.seatIndex === seatIndex) ??
		null;
}

function canChangeCards(player) {
	return Boolean(
		currentHandInProgress && player && !player.busted && !player.folded &&
			player.holeCards.every(Boolean),
	);
}

// Current hole cards are the pick source: clicking one selects it for the swap.
function renderCurrentCards(player) {
	currentCardsEl.replaceChildren();
	if (!player || !player.holeCards.every(Boolean)) {
		const empty = document.createElement("span");
		empty.textContent = t("cheat.noCards");
		currentCardsEl.appendChild(empty);
		return;
	}
	player.holeCards.forEach((cardCode) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "cheat-current-card";
		button.dataset.code = cardCode;
		button.appendChild(createCardImage(cardCode));
		button.classList.toggle(
			"cheat-current-selected",
			selectedCardCode === cardCode,
		);
		button.disabled = !canChangeCards(player);
		currentCardsEl.appendChild(button);
	});
}

function getCardAvailability(state, player) {
	const unavailable = new Set();
	state.communityCards.forEach((cardCode) => unavailable.add(cardCode));
	(state.graveyardCards ?? []).forEach((cardCode) => unavailable.add(cardCode));
	state.players.forEach((entry) => {
		if (entry.seatIndex === player?.seatIndex) {
			return;
		}
		entry.holeCards.forEach((cardCode) => cardCode && unavailable.add(cardCode));
	});
	return unavailable;
}

// Only deck cards are pickable replacements; cards already in the target hand
// are held and shown with an outline but cannot be chosen again.
function renderCardGrid(state, player) {
	const unavailable = getCardAvailability(state, player);
	const heldCards = new Set(player?.holeCards.filter(Boolean) ?? []);
	[...cardGridEl.children].forEach((button) => {
		const cardCode = button.dataset.code;
		const isHeld = heldCards.has(cardCode);
		button.disabled = canChangeCards(player) &&
			!isHeld && unavailable.has(cardCode);
		button.classList.toggle("cheat-card-held", isHeld);
	});
}

function updateSwapHint(player) {
	if (!canChangeCards(player)) {
		setStatus("");
		return;
	}
	setStatus(selectedCardCode
		? t("cheatPanel.pickReplacement")
		: t("cheatPanel.pickFirst"));
}

function setStatus(message, ok) {
	statusEl.textContent = message;
	statusEl.classList.toggle("cheat-status-error", ok === false);
}

function buildCardGrid() {
	INITIAL_DECK.forEach((cardCode) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "cheat-card";
		button.dataset.code = cardCode;
		button.appendChild(createCardImage(cardCode));
		cardGridEl.appendChild(button);
	});
}

function refresh() {
	if (!cheatApi || cheatOverlay.classList.contains("hidden")) {
		return;
	}
	const state = cheatApi.getTableState();
	currentHandInProgress = state.handInProgress === true;
	if (!state.gameStarted) {
		peekEl.replaceChildren();
		const hint = document.createElement("p");
		hint.textContent = t("cheat.startFirst");
		peekEl.appendChild(hint);
		seatSelect.replaceChildren();
		renderCurrentCards(null);
		selectedCardCode = null;
		lastSeatSignature = "";
		resetPeekCache();
		return;
	}
	renderPeek(state);
	renderSeatSelect(state);
	const player = getSelectedPlayer(state);
	renderCurrentCards(player);
	renderCardGrid(state, player);
	updateSwapHint(player);
}

function ensurePolling() {
	if (pollTimer !== null) {
		return;
	}
	pollTimer = setInterval(() => {
		cheatApi?.syncTableCardHover?.(hoverToggle.checked);
		if (!cheatOverlay.classList.contains("hidden")) {
			refresh();
		}
	}, CHEAT_POLL_INTERVAL);
}

export function initCheatPanel(api) {
	cheatApi = api;
	buildCardGrid();
	applyHoverPeekLabel();
	syncTableCardHoverNow();

	hoverToggle.addEventListener("change", () => {
		const enabled = hoverToggle.checked;
		cheatApi?.syncTableCardHover?.(enabled);
		if (enabled) {
			preloadCardFaces();
		}
	});

	seatSelect.addEventListener("change", () => {
		selectedCardCode = null;
		refresh();
	});
	currentCardsEl.addEventListener("click", (ev) => {
		const button = ev.target.closest("button[data-code]");
		if (!button || button.disabled) {
			return;
		}
		selectedCardCode = selectedCardCode === button.dataset.code
			? null
			: button.dataset.code;
		refresh();
	});
	cardGridEl.addEventListener("click", (ev) => {
		const button = ev.target.closest("button[data-code]");
		if (!button || button.disabled || !selectedCardCode) {
			return;
		}
		const result = cheatApi.swapCard(
			Number(seatSelect.value),
			selectedCardCode,
			button.dataset.code,
		);
		if (result.ok) {
			selectedCardCode = null;
		}
		refresh();
		// refresh() rewrites the hint; the swap outcome wins so failures stay visible.
		setStatus(result.message, result.ok);
	});

	ensurePolling();

	// Cached peek rows keep stale translations until rebuilt; drop the cache so
	// the next refresh rerenders them in the new language.
	onLangChange(() => {
		resetPeekCache();
		applyHoverPeekLabel();
	});
}

// The toggle lives in static HTML with a data-i18n key registered in this
// module, so its label is translated here instead of through applyStaticTranslations.
function applyHoverPeekLabel() {
	const label = document.querySelector('[data-i18n="cheatPanel.hoverPeek"]');
	if (label) {
		label.textContent = t("cheatPanel.hoverPeek");
	}
}

function syncTableCardHoverNow() {
	cheatApi?.syncTableCardHover?.(hoverToggle.checked);
}

export function refreshCheatPanel() {
	refresh();
}
