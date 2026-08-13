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
 * A failed request and a server that answered without a model are the same
 * thing to a reader, so both become the explicit unresolved state. The browser
 * never falls back to a locally reconstructed cascade over published settings:
 * that stopped being the answer when the configuration graph became canonical,
 * and a wrong model reads exactly like a right one.
 */
export async function loadPublicBotEffectiveModel(
	worldHandle: string,
	botHandle: string,
): Promise<PublicBotEffectiveModelState> {
	const result = await api<{ model: PublicBotEffectiveModel }>(publicBotEffectiveModelPath(worldHandle, botHandle));
	const effectiveModel = result.ok ? result.data.model?.effectiveModel?.trim() : "";
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

export function usePublicBotEffectiveModel(worldHandle: string, botHandle: string): PublicBotEffectiveModelState {
	const [state, setState] = useState<PublicBotEffectiveModelState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		void loadPublicBotEffectiveModel(worldHandle, botHandle).then((next) => {
			if (!cancelled) {
				setState(next);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [botHandle, worldHandle]);

	return state;
}
