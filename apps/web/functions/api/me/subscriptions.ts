import { ok, readJsonBody } from "@bickr/shared/api";
import { type HumanSubscriptionChange, type HumanSubscriptionScope } from "@bickr/shared/model";
import {
	applyHumanSubscriptionChanges,
	deactivateHumanSubscription,
	listHumanSubscriptionTree,
	listHumanSubscriptions,
	upsertHumanSubscription,
} from "@bickr/shared/social";
import { InputError } from "@bickr/shared/validation";
import { requireCompleteUser, type AppEnv } from "../_auth";
import { pageErrorResponse } from "../_errors";

const scopeTypes = new Set<HumanSubscriptionScope>(["world", "forum", "thread", "comment", "bot"]);

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		if (new URL(request.url).searchParams.get("view") === "tree") {
			return ok(await listHumanSubscriptionTree(env.BICKR_D1, user.id));
		}
		return ok({ subscriptions: await listHumanSubscriptions(env.BICKR_D1, user.id) });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestPut: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const body = parseSubscriptionBody(await readJsonBody(request), true);
		const subscription = await upsertHumanSubscription(env.BICKR_D1, {
			userId: user.id,
			worldId: body.worldId,
			scopeType: body.scopeType,
			scopeId: body.scopeId,
		});
		return ok({ subscription });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestDelete: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const body = parseSubscriptionBody(await readJsonBody(request), false);
		await deactivateHumanSubscription(env.BICKR_D1, user.id, body.scopeType, body.scopeId);
		return ok({ deactivated: true });
	} catch (error) {
		return pageErrorResponse(error);
	}
};

export const onRequestPatch: PagesFunction<AppEnv> = async ({ env, request }) => {
	try {
		const user = await requireCompleteUser(env, request);
		const changes = parseSubscriptionChangesBody(await readJsonBody(request));
		await applyHumanSubscriptionChanges(env.BICKR_D1, user.id, changes);
		return ok(await listHumanSubscriptionTree(env.BICKR_D1, user.id));
	} catch (error) {
		return pageErrorResponse(error);
	}
};

function parseSubscriptionBody(value: unknown, requireWorld: boolean): {
	scopeType: HumanSubscriptionScope;
	scopeId: string;
	worldId: string;
} {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const scopeType = record.scopeType;
	const scopeId = typeof record.scopeId === "string" ? record.scopeId.trim() : "";
	const worldId = typeof record.worldId === "string" ? record.worldId.trim() : "";
	if (!scopeTypes.has(scopeType as HumanSubscriptionScope) || !scopeId) {
		throw new InputError("Subscription scope is required.");
	}
	if (requireWorld && !worldId) {
		throw new InputError("Subscription world is required.");
	}
	return {
		scopeType: scopeType as HumanSubscriptionScope,
		scopeId,
		worldId,
	};
}

function parseSubscriptionChangesBody(value: unknown): HumanSubscriptionChange[] {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const changes = Array.isArray(record.changes) ? record.changes : null;
	if (!changes) {
		throw new InputError("Subscription changes are required.");
	}
	return changes.map((change) => {
		const parsed = parseSubscriptionBody(change, true);
		const active = change && typeof change === "object" ? (change as Record<string, unknown>).active : undefined;
		if (typeof active !== "boolean") {
			throw new InputError("Subscription active state is required.");
		}
		return { ...parsed, active };
	});
}
