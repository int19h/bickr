import {
	maxSpotlightSendBots,
	type SpotlightDeliveryResult,
	type SpotlightSendResult,
	type SpotlightTargetType,
} from "@bickr/shared/model";
import { ApiError, unwrap, type BickrClient } from "./client.ts";
import { parseBickrPath, type ResolvedRef } from "./ref.ts";

/**
 * A spotlight run driven from the CLI, sent as consecutive batches.
 *
 * The server caps how many participants one request may reach, so a large
 * selection becomes several requests sharing one run id — the same shape the
 * web panel uses, for the same reason: each response is the progress event, and
 * a participant one request already reached is never spotlighted twice.
 */

/**
 * Comfortably above the server's own worst case for a batch (a plan build plus
 * one 30-second service call), so a request that hits this really has stopped
 * making progress.
 */
export const defaultSpotlightTimeoutMs = 60_000;

export type SpotlightTarget = {
	worldHandle: string;
	forumHandle: string;
	targetType: SpotlightTargetType;
	threadIds: string[];
	threadId?: string;
	commentIds: string[];
};

/** Why the references given cannot name one spotlight. */
export type SpotlightTargetProblem =
	| "no_targets"
	/** A world, forum, or participant reference: not something to spotlight. */
	| "unsupported_ref"
	| "mixed_types"
	| "mixed_forums"
	| "mixed_threads";

export class SpotlightTargetError extends Error {
	readonly problem: SpotlightTargetProblem;

	constructor(problem: SpotlightTargetProblem, message: string) {
		super(message);
		this.name = "SpotlightTargetError";
		this.problem = problem;
	}
}

/**
 * What the given references spotlight: whole threads, or comments within one
 * thread.
 *
 * A spotlight is one act of attention with one content plan, so the references
 * have to agree on what is being pointed at. Anything else is rejected here
 * rather than half-honoured by the server.
 */
export function spotlightTargetFromRefs(refs: { ref: string; resolved: ResolvedRef }[]): SpotlightTarget {
	if (refs.length === 0) {
		throw new SpotlightTargetError("no_targets", "Spotlight requires at least one thread or comment reference.");
	}
	const unsupported = refs.find((entry) => entry.resolved.type !== "thread" && entry.resolved.type !== "comment");
	if (unsupported) {
		throw new SpotlightTargetError(
			"unsupported_ref",
			`Spotlight targets are threads or comments, but ${unsupported.ref} is a ${unsupported.resolved.type} reference.`,
		);
	}
	const targetType: SpotlightTargetType = refs[0]?.resolved.type === "comment" ? "comments" : "threads";
	const mixed = refs.find((entry) => (entry.resolved.type === "comment" ? "comments" : "threads") !== targetType);
	if (mixed) {
		throw new SpotlightTargetError(
			"mixed_types",
			`Spotlight targets must be all threads or all comments, but ${mixed.ref} is a ${mixed.resolved.type} reference.`,
		);
	}
	// Every resolution is checked, not just the one the rest are compared
	// against: a later reference missing a part would otherwise pass an empty
	// thread or comment id to the server as though the owner had asked for it.
	const parts = refs.map((entry) => {
		const parsed = parseBickrPath(entry.resolved.path);
		const commentId = parsed.commentId ?? entry.resolved.id;
		if (!parsed.worldHandle || !parsed.forumHandle || !parsed.threadId || (targetType === "comments" && !commentId)) {
			throw new SpotlightTargetError("unsupported_ref", `Resolved spotlight reference was incomplete: ${entry.ref}`);
		}
		return {
			ref: entry.ref,
			worldHandle: parsed.worldHandle,
			forumHandle: parsed.forumHandle,
			threadId: parsed.threadId,
			commentId,
		};
	});
	const first = parts[0];
	if (!first) {
		throw new SpotlightTargetError("no_targets", "Spotlight requires at least one thread or comment reference.");
	}
	const foreign = parts.find((entry) =>
		entry.worldHandle !== first.worldHandle || entry.forumHandle !== first.forumHandle);
	if (foreign) {
		throw new SpotlightTargetError(
			"mixed_forums",
			`Spotlight targets must all be in one forum, but ${foreign.ref} is in another.`,
		);
	}
	const target: SpotlightTarget = {
		worldHandle: first.worldHandle,
		forumHandle: first.forumHandle,
		targetType,
		threadIds: [],
		commentIds: [],
	};
	if (targetType === "threads") {
		target.threadIds = [...new Set(parts.map((entry) => entry.threadId))];
		return target;
	}
	const otherThread = parts.find((entry) => entry.threadId !== first.threadId);
	if (otherThread) {
		throw new SpotlightTargetError(
			"mixed_threads",
			`Spotlight comments must all be in one thread, but ${otherThread.ref} is in another.`,
		);
	}
	target.threadId = first.threadId;
	target.commentIds = [...new Set(parts.map((entry) => entry.commentId ?? ""))];
	return target;
}

/** Consecutive slices of the selection, none larger than the server's cap. */
export function spotlightBatches(botIds: string[], batchSize: number): string[][] {
	const size = Math.max(1, Math.min(maxSpotlightSendBots, Math.trunc(batchSize)));
	const batches: string[][] = [];
	for (let index = 0; index < botIds.length; index += size) {
		batches.push(botIds.slice(index, index + size));
	}
	return batches;
}

export type SpotlightBatchProgress = {
	batch: number;
	batchCount: number;
	deliveries: SpotlightDeliveryResult[];
};

/**
 * Why a run stopped early. Carries the typed code from the client or the API
 * envelope, so a caller can tell a timeout from a refused continuation without
 * reading the sentence.
 */
export type SpotlightRunFailure = {
	code: string;
	message: string;
	/** Participants of the batch that failed; the server said nothing about them. */
	botIds: string[];
};

export type SpotlightRunResult = {
	spotlightId: string;
	deliveries: SpotlightDeliveryResult[];
	failure: SpotlightRunFailure | null;
};

/** A participant the run left out before sending, and why. */
export type SpotlightSkippedParticipant = {
	botId: string;
	ref: string;
	reason: "paused";
};

/**
 * Everything one `spotlight send` did, as the single document the command
 * writes to stdout.
 *
 * Every ending produces one — including the ones that send nothing, such as a
 * selection whose participants are all paused. A caller reading `--json` should
 * never have to tell "the run failed" apart from "the program died" by finding
 * stdout empty.
 */
export type SpotlightDocument = {
	spotlightId: string;
	deliveries: SpotlightDeliveryResult[];
	skipped: SpotlightSkippedParticipant[];
	failure: SpotlightRunFailure | null;
};

export async function sendSpotlightInBatches(input: {
	client: BickrClient;
	target: SpotlightTarget;
	botIds: string[];
	focusText: string;
	autoStartTick: boolean;
	/**
	 * Names the run, including its very first batch. The id has to exist before
	 * the first request does: if that request's response is lost after the
	 * server injected, only a retry under the same id can be recognised as the
	 * same run, and the server's dedupe has nothing else to key on.
	 */
	spotlightId: string;
	batchSize: number;
	timeoutMs: number;
	onBatch?: (progress: SpotlightBatchProgress) => void;
}): Promise<SpotlightRunResult> {
	const batches = spotlightBatches(input.botIds, input.batchSize);
	const deliveries: SpotlightDeliveryResult[] = [];
	const path = `/worlds/${encodeURIComponent(input.target.worldHandle)}/forums/${encodeURIComponent(input.target.forumHandle)}/spotlight/send`;
	for (const [index, batch] of batches.entries()) {
		let result: SpotlightSendResult;
		try {
			result = unwrap(await input.client.request<SpotlightSendResult>(path, {
				body: spotlightSendBody(input.target, batch, input.spotlightId, input.focusText, input.autoStartTick),
				method: "POST",
				timeoutMs: input.timeoutMs,
			}));
		} catch (error) {
			// Whatever refused this request — a rejected continuation, a dead
			// network, a deadline — will refuse the next one too, so the run stops
			// here rather than spending the remaining batches to say so again.
			return {
				spotlightId: input.spotlightId,
				deliveries,
				failure: {
					code: error instanceof ApiError ? error.code : "server_error",
					message: error instanceof Error ? error.message : "The spotlight batch failed.",
					botIds: batch,
				},
			};
		}
		deliveries.push(...result.deliveries);
		input.onBatch?.({ batch: index + 1, batchCount: batches.length, deliveries: result.deliveries });
	}
	return { spotlightId: input.spotlightId, deliveries, failure: null };
}

function spotlightSendBody(
	target: SpotlightTarget,
	botIds: string[],
	spotlightId: string,
	focusText: string,
	autoStartTick: boolean,
): Record<string, unknown> {
	return {
		targetType: target.targetType,
		botIds,
		...(target.targetType === "threads" ?
			{ threadIds: target.threadIds }
		:	{ threadId: target.threadId, commentIds: target.commentIds }),
		...(focusText.trim() ? { focusText: focusText.trim() } : {}),
		autoStartTick,
		spotlightId,
	};
}
