import {
	maxSpotlightSendBots,
	spotlightDeliverySucceeded,
	type SpotlightDeliveryResult,
	type SpotlightSendResult,
	type SpotlightTargetType,
} from "@bickr/shared/model";
import { api } from "../../api";

/**
 * A spotlight run, sent as consecutive batches.
 *
 * The server caps how many participants one request may reach, so a large
 * selection is delivered in several requests that share one run id. Splitting
 * it here rather than in the panel keeps the panel about rendering: the panel
 * reacts to each batch's outcome and never has to know the cap.
 */

/**
 * Comfortably above the server's own worst case for a batch (a plan build plus
 * one 30-second service call), so a request that hits this really has stopped
 * making progress.
 */
export const spotlightBatchTimeoutMs = 60_000;

export type SpotlightSendTarget = {
	worldHandle: string;
	forumHandle: string;
	targetType: SpotlightTargetType;
	threadIds: string[];
	threadId?: string;
	commentIds: string[];
	focusText: string;
	autoStartTick: boolean;
};

export type SpotlightDeliveryFailure = {
	botId: string;
	message: string;
};

export type SpotlightBatchUpdate = {
	spotlightId: string;
	/** Participants this batch finished with; a retry must exclude them. */
	completedBotIds: string[];
	failures: SpotlightDeliveryFailure[];
};

export type SpotlightRunResult =
	| { kind: "completed" }
	| { kind: "aborted" }
	/**
	 * A batch never produced per-participant results at all. Its own participants
	 * come back as failures — the ones from earlier batches were already reported
	 * through `onBatch` — and the run stops: whatever refused that request, a
	 * rejected continuation or a dead network, will refuse the next one too.
	 */
	| { kind: "request_failed"; message: string; failures: SpotlightDeliveryFailure[] };

export function spotlightBatches(botIds: string[]): string[][] {
	const batches: string[][] = [];
	for (let index = 0; index < botIds.length; index += maxSpotlightSendBots) {
		batches.push(botIds.slice(index, index + maxSpotlightSendBots));
	}
	return batches;
}

export async function sendSpotlightInBatches(input: {
	target: SpotlightSendTarget;
	botIds: string[];
	/** Reuses a run started earlier, which makes a retry idempotent per participant. */
	spotlightId?: string;
	signal: AbortSignal;
	onBatch: (update: SpotlightBatchUpdate) => void;
}): Promise<SpotlightRunResult> {
	let spotlightId = input.spotlightId;
	for (const batch of spotlightBatches(input.botIds)) {
		if (input.signal.aborted) {
			return { kind: "aborted" };
		}
		const result = await api<SpotlightSendResult>(
			`/api/worlds/${encodeURIComponent(input.target.worldHandle)}/forums/${encodeURIComponent(input.target.forumHandle)}/spotlight/send`,
			{
				method: "POST",
				body: spotlightSendBody(input.target, batch, spotlightId),
				signal: input.signal,
				timeoutMs: spotlightBatchTimeoutMs,
			},
		);
		if (!result.ok) {
			if (input.signal.aborted) {
				return { kind: "aborted" };
			}
			return {
				kind: "request_failed",
				message: result.message,
				failures: batch.map((botId) => ({ botId, message: result.message })),
			};
		}
		spotlightId = result.data.spotlightId;
		const batchFailures = result.data.deliveries.flatMap((delivery) => {
			const message = spotlightDeliveryFailureMessage(delivery);
			return message === null ? [] : [{ botId: delivery.botId, message }];
		});
		input.onBatch({
			spotlightId,
			completedBotIds: result.data.deliveries.filter(spotlightDeliverySucceeded).map((delivery) => delivery.botId),
			failures: batchFailures,
		});
	}
	return { kind: "completed" };
}

/**
 * The owner-facing reason a participant is still waiting, or `null` when it is
 * not. `injected_tick_failed` is a failure on purpose: the injection landed but
 * nothing will read it, which is exactly the case that used to look like
 * success.
 */
export function spotlightDeliveryFailureMessage(delivery: SpotlightDeliveryResult): string | null {
	switch (delivery.status) {
		case "not_injected":
		case "injected_tick_failed":
			return delivery.message;
		case "tick_started":
		case "tick_pending":
		case "already_delivered":
			return null;
		default:
			return assertNeverDelivery(delivery);
	}
}

function assertNeverDelivery(delivery: never): never {
	throw new Error(`Unhandled spotlight delivery result: ${JSON.stringify(delivery)}`);
}

function spotlightSendBody(target: SpotlightSendTarget, botIds: string[], spotlightId: string | undefined) {
	return {
		targetType: target.targetType,
		botIds,
		...(target.targetType === "threads" ?
			{ threadIds: target.threadIds }
		:	{ threadId: target.threadId, commentIds: target.commentIds }),
		...(target.focusText.trim() ? { focusText: target.focusText.trim() } : {}),
		autoStartTick: target.autoStartTick,
		...(spotlightId ? { spotlightId } : {}),
	};
}
