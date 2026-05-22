export type TickSpreadInput = {
	botId: string;
	handle: string;
	intervalSeconds: number;
	nextDueAt?: string | null;
};

export type TickSpreadSchedule = {
	botId: string;
	nextDueAt: string;
	offsetSeconds: number;
	orderRelaxed: boolean;
};

export type TickSpreadPlan = {
	anchorBotId?: string;
	exactHyperperiodSeconds?: number;
	horizonSeconds: number;
	scheduled: TickSpreadSchedule[];
	usedApproximateHorizon: boolean;
};

type OrderedTickSpreadInput = TickSpreadInput & {
	dueSort: number;
};

type CandidateScore = {
	averageNearestDistance: number;
	minNearestDistance: number;
	targetDistance: number;
	value: number;
};

const maxExactHyperperiodSeconds = 7 * 24 * 60 * 60;
const maxSimulatedEvents = 50_000;
const maxGapCandidates = 16;

export function planBotTickSpread(rows: readonly TickSpreadInput[], now = new Date()): TickSpreadPlan {
	const nowMs = now.getTime();
	if (!Number.isFinite(nowMs)) {
		throw new Error("Spread tick planning requires a valid anchor time.");
	}
	const ordered = [...rows].map((row): OrderedTickSpreadInput => {
		const intervalSeconds = Math.floor(row.intervalSeconds);
		if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
			throw new Error(`Tick interval for ${row.botId} must be a positive integer.`);
		}
		return {
			...row,
			intervalSeconds,
			dueSort: dueSortValue(row.nextDueAt, nowMs),
		};
	}).sort(compareOrderedRows);

	if (ordered.length === 0) {
		return { horizonSeconds: 0, scheduled: [], usedApproximateHorizon: false };
	}

	const horizon = tickSpreadHorizon(ordered);
	if (ordered.every((row) => row.intervalSeconds === ordered[0]!.intervalSeconds)) {
		return equalIntervalTickSpreadPlan(ordered, nowMs, horizon);
	}
	const eventRate = ordered.reduce((total, row) => total + 1 / row.intervalSeconds, 0);
	const idealGapSeconds = eventRate > 0 ? 1 / eventRate : ordered[0]!.intervalSeconds;
	const anchor = ordered[0]!;
	let placedEvents = periodicEvents(0, anchor.intervalSeconds, horizon.seconds);
	const scheduled: TickSpreadSchedule[] = [{
		botId: anchor.botId,
		nextDueAt: dueAtForOffset(nowMs, 0),
		offsetSeconds: 0,
		orderRelaxed: false,
	}];

	for (let index = 1; index < ordered.length; index += 1) {
		const row = ordered[index]!;
		const targetOffset = Math.max(0, Math.round(index * idealGapSeconds));
		const previousOffset = scheduled[index - 1]!.offsetSeconds;
		const candidates = candidateOffsets(row.intervalSeconds, placedEvents, targetOffset);
		const orderedCandidates = candidates.filter((candidate) => candidate > previousOffset);
		const orderRelaxed = orderedCandidates.length === 0;
		const candidatePool = orderRelaxed ? candidates : orderedCandidates;
		const offsetSeconds = bestCandidateOffset(candidatePool, {
			existingEvents: placedEvents,
			horizonSeconds: horizon.seconds,
			intervalSeconds: row.intervalSeconds,
			targetOffset,
		});
		placedEvents = mergeSortedEvents(placedEvents, periodicEvents(offsetSeconds, row.intervalSeconds, horizon.seconds));
		scheduled.push({
			botId: row.botId,
			nextDueAt: dueAtForOffset(nowMs, offsetSeconds),
			offsetSeconds,
			orderRelaxed,
		});
	}

	return {
		anchorBotId: anchor.botId,
		...(horizon.exactHyperperiodSeconds !== undefined ? { exactHyperperiodSeconds: horizon.exactHyperperiodSeconds } : {}),
		horizonSeconds: horizon.seconds,
		scheduled,
		usedApproximateHorizon: horizon.usedApproximateHorizon,
	};
}

function equalIntervalTickSpreadPlan(
	ordered: readonly OrderedTickSpreadInput[],
	nowMs: number,
	horizon: {
		exactHyperperiodSeconds?: number;
		seconds: number;
		usedApproximateHorizon: boolean;
	},
): TickSpreadPlan {
	const intervalSeconds = ordered[0]!.intervalSeconds;
	let previousOffset = -1;
	const scheduled = ordered.map((row, index): TickSpreadSchedule => {
		const offsetSeconds = Math.min(intervalSeconds - 1, Math.round(index * intervalSeconds / ordered.length));
		const orderRelaxed = offsetSeconds <= previousOffset;
		previousOffset = offsetSeconds;
		return {
			botId: row.botId,
			nextDueAt: dueAtForOffset(nowMs, offsetSeconds),
			offsetSeconds,
			orderRelaxed,
		};
	});
	return {
		anchorBotId: ordered[0]!.botId,
		...(horizon.exactHyperperiodSeconds !== undefined ? { exactHyperperiodSeconds: horizon.exactHyperperiodSeconds } : {}),
		horizonSeconds: horizon.seconds,
		scheduled,
		usedApproximateHorizon: horizon.usedApproximateHorizon,
	};
}

function dueSortValue(value: string | null | undefined, nowMs: number): number {
	if (!value) {
		return nowMs;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : nowMs;
}

function compareOrderedRows(left: OrderedTickSpreadInput, right: OrderedTickSpreadInput): number {
	return (
		left.dueSort - right.dueSort ||
		left.handle.localeCompare(right.handle, undefined, { sensitivity: "base" }) ||
		left.botId.localeCompare(right.botId)
	);
}

function dueAtForOffset(nowMs: number, offsetSeconds: number): string {
	return new Date(nowMs + offsetSeconds * 1000).toISOString();
}

function tickSpreadHorizon(rows: readonly OrderedTickSpreadInput[]): {
	exactHyperperiodSeconds?: number;
	seconds: number;
	usedApproximateHorizon: boolean;
} {
	const intervals = rows.map((row) => row.intervalSeconds);
	const hyperperiod = lcmSecondsWithinCap(intervals, maxExactHyperperiodSeconds);
	if (hyperperiod !== null && approximateEventCount(rows, hyperperiod) <= maxSimulatedEvents) {
		return {
			exactHyperperiodSeconds: hyperperiod,
			seconds: hyperperiod,
			usedApproximateHorizon: false,
		};
	}

	return {
		seconds: boundedApproximationHorizon(rows),
		usedApproximateHorizon: true,
	};
}

function lcmSecondsWithinCap(intervals: readonly number[], cap: number): number | null {
	let current = 1n;
	const capBigInt = BigInt(cap);
	for (const interval of intervals) {
		current = lcmBigInt(current, BigInt(interval));
		if (current > capBigInt) {
			return null;
		}
	}
	return Number(current);
}

function lcmBigInt(left: bigint, right: bigint): bigint {
	return left / gcdBigInt(left, right) * right;
}

function gcdBigInt(left: bigint, right: bigint): bigint {
	let a = left < 0n ? -left : left;
	let b = right < 0n ? -right : right;
	while (b !== 0n) {
		const next = a % b;
		a = b;
		b = next;
	}
	return a;
}

function boundedApproximationHorizon(rows: readonly OrderedTickSpreadInput[]): number {
	let low = 1;
	let high = maxExactHyperperiodSeconds;
	let best = 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (approximateEventCount(rows, mid) <= maxSimulatedEvents) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

function approximateEventCount(rows: readonly OrderedTickSpreadInput[], horizonSeconds: number): number {
	let count = 0;
	for (const row of rows) {
		count += Math.ceil(horizonSeconds / row.intervalSeconds);
		if (count > maxSimulatedEvents) {
			return count;
		}
	}
	return count;
}

function candidateOffsets(intervalSeconds: number, existingEvents: readonly number[], targetOffset: number): number[] {
	const candidates = new Set<number>();
	addCandidate(candidates, 0, intervalSeconds);
	addCandidate(candidates, targetOffset, intervalSeconds);
	addCandidate(candidates, targetOffset - 1, intervalSeconds);
	addCandidate(candidates, targetOffset + 1, intervalSeconds);
	const residues = [...new Set(existingEvents.map((event) => event % intervalSeconds))].sort((left, right) => left - right);
	if (residues.length === 0) {
		return [...candidates].sort((left, right) => left - right);
	}

	const gaps = residues.map((residue, index) => {
		const next = residues[(index + 1) % residues.length]!;
		const gap = index === residues.length - 1 ? next + intervalSeconds - residue : next - residue;
		return { gap, residue };
	}).sort((left, right) => right.gap - left.gap || left.residue - right.residue);

	for (const gap of gaps.slice(0, maxGapCandidates)) {
		addCandidate(candidates, gap.residue + Math.round(gap.gap / 2), intervalSeconds);
		addCandidate(candidates, gap.residue + Math.floor(gap.gap / 2), intervalSeconds);
	}

	const slotCount = Math.min(maxGapCandidates, Math.max(1, Math.ceil(intervalSeconds / Math.max(1, targetOffset || intervalSeconds))));
	for (let slot = 1; slot < slotCount; slot += 1) {
		addCandidate(candidates, Math.round(slot * intervalSeconds / slotCount), intervalSeconds);
	}

	return [...candidates].sort((left, right) => left - right);
}

function addCandidate(candidates: Set<number>, value: number, intervalSeconds: number): void {
	if (!Number.isFinite(value)) {
		return;
	}
	const normalized = ((Math.round(value) % intervalSeconds) + intervalSeconds) % intervalSeconds;
	candidates.add(normalized);
}

function bestCandidateOffset(
	candidates: readonly number[],
	options: {
		existingEvents: readonly number[];
		horizonSeconds: number;
		intervalSeconds: number;
		targetOffset: number;
	},
): number {
	let bestValue = candidates[0] ?? 0;
	let bestScore: CandidateScore | null = null;
	for (const candidate of candidates) {
		const score = scoreCandidateOffset(candidate, options);
		if (!bestScore || compareCandidateScores(score, bestScore) < 0) {
			bestScore = score;
			bestValue = candidate;
		}
	}
	return bestValue;
}

function scoreCandidateOffset(
	candidate: number,
	options: {
		existingEvents: readonly number[];
		horizonSeconds: number;
		intervalSeconds: number;
		targetOffset: number;
	},
): CandidateScore {
	const candidateEvents = periodicEvents(candidate, options.intervalSeconds, options.horizonSeconds);
	const events = candidateEvents.length > 0 ? candidateEvents : [Math.min(candidate, Math.max(0, options.horizonSeconds - 1))];
	let minNearestDistance = Number.POSITIVE_INFINITY;
	let totalNearestDistance = 0;
	for (const event of events) {
		const distance = nearestCircularDistance(options.existingEvents, options.horizonSeconds, event);
		minNearestDistance = Math.min(minNearestDistance, distance);
		totalNearestDistance += distance;
	}
	return {
		averageNearestDistance: totalNearestDistance / events.length,
		minNearestDistance,
		targetDistance: Math.abs(candidate - Math.min(options.targetOffset, options.intervalSeconds - 1)),
		value: candidate,
	};
}

function compareCandidateScores(left: CandidateScore, right: CandidateScore): number {
	return (
		right.minNearestDistance - left.minNearestDistance ||
		right.averageNearestDistance - left.averageNearestDistance ||
		left.targetDistance - right.targetDistance ||
		left.value - right.value
	);
}

function periodicEvents(offsetSeconds: number, intervalSeconds: number, horizonSeconds: number): number[] {
	if (horizonSeconds <= 0 || offsetSeconds >= horizonSeconds) {
		return [];
	}
	const events: number[] = [];
	for (let event = offsetSeconds; event < horizonSeconds; event += intervalSeconds) {
		events.push(event);
	}
	return events;
}

function mergeSortedEvents(left: readonly number[], right: readonly number[]): number[] {
	const merged: number[] = [];
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length || rightIndex < right.length) {
		if (rightIndex >= right.length || (leftIndex < left.length && left[leftIndex]! <= right[rightIndex]!)) {
			merged.push(left[leftIndex]!);
			leftIndex += 1;
		} else {
			merged.push(right[rightIndex]!);
			rightIndex += 1;
		}
	}
	return merged;
}

function nearestCircularDistance(sortedEvents: readonly number[], horizonSeconds: number, event: number): number {
	if (sortedEvents.length === 0 || horizonSeconds <= 0) {
		return horizonSeconds;
	}
	const insertionIndex = lowerBound(sortedEvents, event);
	const next = sortedEvents[insertionIndex % sortedEvents.length]!;
	const previous = sortedEvents[(insertionIndex - 1 + sortedEvents.length) % sortedEvents.length]!;
	return Math.min(circularDistance(event, next, horizonSeconds), circularDistance(event, previous, horizonSeconds));
}

function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (values[mid]! < target) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function circularDistance(left: number, right: number, horizonSeconds: number): number {
	const direct = Math.abs(left - right);
	return Math.min(direct, horizonSeconds - direct);
}
