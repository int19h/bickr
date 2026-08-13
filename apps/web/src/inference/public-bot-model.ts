import { useEffect, useState } from "react";
import type { PublicBotEffectiveModel } from "@bickr/shared/model";
import { api } from "../api";

/**
 * The public participant model row, for every viewer.
 *
 * This is deliberately not part of the owner surface in `./api`: it addresses a
 * participant by the world/handle pair a public profile already holds, sends no
 * owner-scoped request, and receives nothing but the resolved model string. The
 * server answers identically for the owner, a signed-in visitor, and an
 * anonymous one, so the screen has a single source instead of one answer for
 * owners and a published field for everyone else.
 */

export type PublicBotEffectiveModelState =
	| { status: "loading" }
	| { status: "resolved"; effectiveModel: string }
	| { status: "unresolved" };

export function publicBotEffectiveModelPath(worldHandle: string, botHandle: string): string {
	return `/api/worlds/${encodeURIComponent(worldHandle)}/bots/${encodeURIComponent(botHandle)}/effective-model`;
}

/**
 * Which participant a state is an answer about.
 *
 * The request is addressed by handles while the answer identifies the
 * participant by id, so the identity of an answer is the pair: the same handles
 * can address a different participant after a handle is released and reclaimed.
 */
function publicBotEffectiveModelSubject(worldHandle: string, botHandle: string, botId: string): string {
	return `${publicBotEffectiveModelPath(worldHandle, botHandle)}#${encodeURIComponent(botId)}`;
}

/**
 * A failed request and a server that answered without a model are the same
 * thing to a reader, so both become the explicit unresolved state. The browser
 * never falls back to a locally reconstructed cascade over published settings:
 * that stopped being the answer when the configuration graph became canonical,
 * and a wrong model reads exactly like a right one.
 *
 * An answer about a different participant is unresolved for the same reason. It
 * means the handles now address someone else, so the profile holding them is
 * stale — and another participant's model is worse than no model.
 */
export async function loadPublicBotEffectiveModel(
	worldHandle: string,
	botHandle: string,
	botId: string,
): Promise<PublicBotEffectiveModelState> {
	const result = await api<{ model: PublicBotEffectiveModel }>(publicBotEffectiveModelPath(worldHandle, botHandle));
	if (!result.ok || result.data.model?.botId !== botId) {
		return { status: "unresolved" };
	}
	const effectiveModel = result.data.model.effectiveModel?.trim();
	return effectiveModel ? { status: "resolved", effectiveModel } : { status: "unresolved" };
}

export function publicBotEffectiveModelLabel(state: PublicBotEffectiveModelState): string {
	switch (state.status) {
		case "loading":
			return "...";
		case "resolved":
			return state.effectiveModel;
		case "unresolved":
			return "not resolved";
	}
}

export function usePublicBotEffectiveModel(
	worldHandle: string,
	botHandle: string,
	botId: string,
): PublicBotEffectiveModelState {
	const subject = publicBotEffectiveModelSubject(worldHandle, botHandle, botId);
	const [answer, setAnswer] = useState<{ subject: string; state: PublicBotEffectiveModelState }>(
		{ subject, state: { status: "loading" } },
	);

	useEffect(() => {
		let cancelled = false;
		void loadPublicBotEffectiveModel(worldHandle, botHandle, botId).then((state) => {
			if (!cancelled) {
				setAnswer({ subject, state });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [botHandle, botId, subject, worldHandle]);

	// Which participant is on screen changes with the props, so a held answer
	// stops being the answer in that same render rather than one commit later.
	// Resetting from an effect instead would paint the previous participant's
	// model on this one first, which is exactly the confident wrong answer this
	// row exists to remove — the profile screen is reused across navigation
	// within a world rather than remounted.
	return answer.subject === subject ? answer.state : { status: "loading" };
}
