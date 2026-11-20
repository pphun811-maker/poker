/* ==================================================================================================
MODULE BOUNDARY: Player Profile Overlay Rendering
================================================================================================== */

// CURRENT STATE: Renders the career stats overlay from a player profile: metric groups compared
// across Latest / L10 / Overall periods, plus the recent placements chart.
// TARGET STATE: Keep all layout and formatting here; strings come from the i18n profile namespace.
// PUT HERE: Metric group definitions, period formatting, DOM building from templates.
// DO NOT PUT HERE: Profile storage access, game state, or static overlay markup ownership.

import { getPlayerProfileComparison } from "../playerProfile.js";
import { getLang, t, tf } from "../i18n.js";

const METRIC_GROUPS = [
	{
		labelKey: "profile.group.results",
		metrics: [
			{ labelKey: "profile.metric.tournaments", kind: "tournaments", helpKey: "profile.help.tournaments" },
			{ labelKey: "profile.metric.winRate", kind: "winRate", helpKey: "profile.help.winRate" },
			{ labelKey: "profile.metric.placement", kind: "placement", helpKey: "profile.help.placement" },
			{ labelKey: "profile.metric.handsPerGame", kind: "handsPerGame", helpKey: "profile.help.handsPerGame" },
			{
				labelKey: "profile.metric.handsWon",
				numerator: "handsWon",
				denominator: "hands",
				helpKey: "profile.help.handsWon",
			},
			{
				labelKey: "profile.metric.nonShowdownWins",
				numerator: "handsWon",
				subtract: "showdownsWon",
				denominator: "handsWon",
				helpKey: "profile.help.nonShowdownWins",
			},
		],
	},
	{
		labelKey: "profile.group.preflop",
		metrics: [
			{ labelKey: "profile.metric.vpip", numerator: "vpip", denominator: "hands", helpKey: "profile.help.vpip" },
			{ labelKey: "profile.metric.pfr", numerator: "pfr", denominator: "hands", helpKey: "profile.help.pfr" },
			{
				labelKey: "profile.metric.vpipPfrGap",
				kind: "gap",
				numerator: "vpip",
				subtract: "pfr",
				denominator: "hands",
				helpKey: "profile.help.vpipPfrGap",
			},
			{
				labelKey: "profile.metric.preflopFold",
				numerator: "foldsPreflop",
				denominator: "hands",
				helpKey: "profile.help.preflopFold",
			},
			{ labelKey: "profile.metric.flopSeen", rate: "flopSeenPct", helpKey: "profile.help.flopSeen" },
		],
	},
	{
		labelKey: "profile.group.postflop",
		metrics: [
			{
				labelKey: "profile.metric.aggressionFactor",
				kind: "ratio",
				rate: "aggressionFactor",
				helpKey: "profile.help.aggressionFactor",
			},
			{ labelKey: "profile.metric.wtsd", rate: "wtsdPct", helpKey: "profile.help.wtsd" },
			{
				labelKey: "profile.metric.wsd",
				numerator: "showdownsWon",
				denominator: "showdowns",
				helpKey: "profile.help.wsd",
			},
			{
				labelKey: "profile.metric.wwsf",
				numerator: "handsWonAfterFlop",
				denominator: "flopsSeen",
				helpKey: "profile.help.wwsf",
			},
			{
				labelKey: "profile.metric.postflopFold",
				numerator: "foldsPostflop",
				denominator: "hands",
				helpKey: "profile.help.postflopFold",
			},
			{
				labelKey: "profile.metric.allin",
				numerator: "allins",
				denominator: "hands",
				helpKey: "profile.help.allin",
			},
		],
	},
];

function formatNumber(value) {
	return value.toLocaleString(getLang() === "zh" ? "zh-CN" : "en");
}

function formatDate(timestamp) {
	return new Date(timestamp).toLocaleDateString(
		getLang() === "zh" ? "zh-CN" : "en",
		{ day: "numeric", month: "short", year: "numeric" },
	);
}

function formatMetric(period, metric) {
	if (metric.kind === "tournaments") {
		return formatNumber(period.tournaments);
	}
	if (metric.kind === "winRate") {
		return `${period.winPct.toFixed(1)}%`;
	}
	if (metric.kind === "placement") {
		if (period.placement !== undefined) {
			return `${period.placement} / ${period.participantCount}`;
		}
		const averagePlaceAtSix = 1 + (period.averageRelativePlacementPct / 100) * 5;
		return `${averagePlaceAtSix.toFixed(1)} / 6`;
	}
	if (metric.kind === "handsPerGame") {
		return (period.stats.hands / period.tournaments).toLocaleString(getLang() === "zh" ? "zh-CN" : "en", {
			maximumFractionDigits: 1,
		});
	}
	if (metric.kind === "ratio") {
		const ratio = period.rates[metric.rate];
		return ratio === null ? "—" : ratio.toFixed(2);
	}
	let rate;
	if (metric.rate) {
		rate = period.rates[metric.rate];
	} else {
		const numerator = period.stats[metric.numerator] - (metric.subtract ? period.stats[metric.subtract] : 0);
		const denominator = period.stats[metric.denominator];
		rate = denominator > 0 ? numerator / denominator * 100 : null;
	}
	return rate === null ? "—" : `${rate.toFixed(1)}${metric.kind === "gap" ? " pp" : "%"}`;
}

function buildPeriods(comparison) {
	const periods = [{ label: t("profile.period.latest"), ...comparison.latest }];
	if (comparison.last10) {
		periods.push({ label: t("profile.period.last10"), ...comparison.last10 });
	}
	periods.push({ label: t("profile.period.overall"), ...comparison.overall });
	return periods;
}

export function renderPlayerProfile(elements, profile) {
	const comparison = getPlayerProfileComparison(profile);
	const periods = buildPeriods(comparison);
	elements.groups.replaceChildren();
	for (const group of METRIC_GROUPS) {
		const section = elements.groupTemplate.content.firstElementChild.cloneNode(true);
		section.querySelector("h3").textContent = t(group.labelKey);
		const header = section.querySelector("thead tr");
		const body = section.querySelector("tbody");
		const explanations = section.querySelector("dl");
		for (const period of periods) {
			const heading = elements.headingTemplate.content.firstElementChild.cloneNode(true);
			heading.querySelector(".period-label").textContent = period.label;
			heading.querySelector(".period-detail").textContent = period.finishedAt
				? formatDate(period.finishedAt)
				: tf("profile.period.games", { count: formatNumber(period.tournaments) });
			header.appendChild(heading);
		}
		for (const metric of group.metrics) {
			const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
			row.querySelector("th").textContent = t(metric.labelKey);
			for (const period of periods) {
				const cell = elements.cellTemplate.content.firstElementChild.cloneNode(true);
				cell.querySelector(".metric-value").textContent = formatMetric(period, metric);
				row.appendChild(cell);
			}
			body.appendChild(row);
			const explanation = elements.helpTemplate.content.firstElementChild.cloneNode(true);
			explanation.querySelector("dt").textContent = t(metric.labelKey);
			explanation.querySelector("dd").textContent = t(metric.helpKey);
			explanations.appendChild(explanation);
		}
		elements.groups.appendChild(section);
	}
	elements.history.replaceChildren();
	elements.history.style.setProperty("--history-count", profile.recentTournaments.length);
	for (const tournament of profile.recentTournaments.slice().reverse()) {
		const item = elements.historyTemplate.content.firstElementChild.cloneNode(true);
		const position = (tournament.placement - 1) / (tournament.participantCount - 1) * 100;
		item.style.setProperty("--finish-position", `${position}%`);
		item.title = tf("profile.historyTitle", {
			date: formatDate(tournament.finishedAt),
			placement: tournament.placement,
			participantCount: tournament.participantCount,
		});
		item.querySelector(".history-place").textContent = `${tournament.placement}/${tournament.participantCount}`;
		elements.history.appendChild(item);
	}
}
