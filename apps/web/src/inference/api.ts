import type { InferenceGraphErrorCause } from "@bickr/shared/model";
import type {
	InferenceConfigurationOverridePatch,
	InferenceConfigurationOverrides,
} from "@bickr/shared/inference-configuration";
import {
	type CredentialUpdate,
	type FixedInferenceConfigurationReference,
	type InferenceConfigurationPage,
	type InferenceDeleteImpact,
	type InferenceImmediateChildrenPage,
	type InferenceLibraryPage,
	type InferenceLibrarySection,
	type InferenceParentImpact,
	type ParentCandidatePage,
	type RedactedInferenceConfigurationDto,
	type TranslationSelection,
} from "@bickr/shared/inference-configuration-owner";
import { api, type ApiFailure, type ApiResult } from "../api";

/**
 * The whole owner surface the inference screens are allowed to touch. Every
 * call goes through the Phase-3 proxies, so the browser never resolves the
 * graph, never sees credential material, and never derives an effective value
 * that the server did not already compute.
 */

const configurationsPath = "/api/me/inference-configurations";
const translationPath = "/api/me/inference-translation";

export type InferenceListQuery = {
	query?: string;
	cursor?: string;
	limit?: number;
};

export function inferenceGraphErrorCause(failure: ApiFailure): InferenceGraphErrorCause | null {
	return failure.details?.inferenceGraphCause ?? null;
}

/** True when this owner has no graph yet, so the library cannot be shown. */
export function inferenceGraphUnavailable(failure: ApiFailure): boolean {
	return failure.error === "conflict" && inferenceGraphErrorCause(failure) === null;
}

export function librarySectionPath(section: InferenceLibrarySection, query: InferenceListQuery = {}): string {
	return `${configurationsPath}${listSearch({ section }, query)}`;
}

export function configurationPath(configurationId: string): string {
	return `${configurationsPath}/${encodeURIComponent(configurationId)}`;
}

export function parentCandidatesPath(configurationId: string, query: InferenceListQuery = {}): string {
	return `${configurationPath(configurationId)}/parent-candidates${listSearch({}, query)}`;
}

export function childrenPath(configurationId: string, query: InferenceListQuery = {}): string {
	return `${configurationPath(configurationId)}/children${listSearch({}, query)}`;
}

export function translationCandidatesPath(query: InferenceListQuery = {}): string {
	return `${translationPath}/candidates${listSearch({}, query)}`;
}

/**
 * Addresses a fixed entry by the entity it belongs to. The server authorizes
 * that entity against the owner and resolves the configuration; the browser
 * never derives a configuration id.
 */
export function fixedConfigurationPath(reference: FixedInferenceConfigurationReference): string {
	const suffix = reference.kind === "account_default"
		? ""
		: `/${encodeURIComponent(reference.kind === "world" ? reference.worldId : reference.botId)}`;
	return `${configurationsPath}/fixed/${reference.kind}${suffix}`;
}

export async function loadConfiguration(configurationId: string): Promise<ApiResult<RedactedInferenceConfigurationDto>> {
	return unwrap(await api<{ configuration: RedactedInferenceConfigurationDto }>(configurationPath(configurationId)), "configuration");
}

export async function createConfiguration(input: {
	name: string;
	parentId: string;
	overrides?: InferenceConfigurationOverrides;
	credential?: CredentialUpdate;
}): Promise<ApiResult<RedactedInferenceConfigurationDto>> {
	return unwrap(
		await api<{ configuration: RedactedInferenceConfigurationDto }>(configurationsPath, { method: "POST", body: input }),
		"configuration",
	);
}

export async function renameConfiguration(input: {
	configurationId: string;
	name: string;
	expectedRevision: number;
}): Promise<ApiResult<RedactedInferenceConfigurationDto>> {
	return unwrap(
		await api<{ configuration: RedactedInferenceConfigurationDto }>(`${configurationPath(input.configurationId)}/rename`, {
			method: "POST",
			body: { name: input.name, expectedRevision: input.expectedRevision },
		}),
		"configuration",
	);
}

export async function reparentConfiguration(input: {
	configurationId: string;
	parentId: string;
	expectedRevision: number;
}): Promise<ApiResult<RedactedInferenceConfigurationDto>> {
	return unwrap(
		await api<{ configuration: RedactedInferenceConfigurationDto }>(`${configurationPath(input.configurationId)}/reparent`, {
			method: "POST",
			body: { parentId: input.parentId, expectedRevision: input.expectedRevision },
		}),
		"configuration",
	);
}

export async function updateConfiguration(input: {
	configurationId: string;
	expectedRevision: number;
	overrides?: InferenceConfigurationOverridePatch;
	credential?: CredentialUpdate;
}): Promise<ApiResult<RedactedInferenceConfigurationDto>> {
	return unwrap(
		await api<{ configuration: RedactedInferenceConfigurationDto }>(configurationPath(input.configurationId), {
			method: "PATCH",
			body: {
				expectedRevision: input.expectedRevision,
				...(input.overrides ? { overrides: input.overrides } : {}),
				...(input.credential ? { credential: input.credential } : {}),
			},
		}),
		"configuration",
	);
}

export async function deleteConfiguration(input: {
	configurationId: string;
	expectedRevision: number;
}): Promise<ApiResult<InferenceDeleteImpact>> {
	return unwrap(
		await api<{ impact: InferenceDeleteImpact }>(configurationPath(input.configurationId), {
			method: "DELETE",
			body: { expectedRevision: input.expectedRevision },
		}),
		"impact",
	);
}

export async function loadParentImpact(
	configurationId: string,
	candidateParentId: string,
): Promise<ApiResult<InferenceParentImpact>> {
	const search = new URLSearchParams({ parentId: candidateParentId });
	return unwrap(
		await api<{ impact: InferenceParentImpact }>(`${configurationPath(configurationId)}/impact?${search.toString()}`),
		"impact",
	);
}

export async function loadDeleteImpact(configurationId: string): Promise<ApiResult<InferenceDeleteImpact>> {
	return unwrap(await api<{ impact: InferenceDeleteImpact }>(`${configurationPath(configurationId)}/impact`), "impact");
}

export async function updateTranslationSelection(input: {
	configurationId: string;
	expectedRevision: number;
}): Promise<ApiResult<TranslationSelectionResponse>> {
	const result = await api<TranslationSelectionResponse>(translationPath, { method: "PUT", body: input });
	return result.ok ? { ok: true, data: result.data } : result;
}

export type TranslationSelectionResponse = {
	selection: TranslationSelection;
	configuration: RedactedInferenceConfigurationDto;
};

export type LibraryPageResponse = { configurations: InferenceLibraryPage };
export type ParentCandidatesResponse = { candidates: ParentCandidatePage };
export type TranslationCandidatesResponse = { candidates: InferenceConfigurationPage };
export type ChildrenResponse = { children: InferenceImmediateChildrenPage };

function listSearch(base: { section?: InferenceLibrarySection }, query: InferenceListQuery): string {
	const params = new URLSearchParams();
	if (base.section) params.set("section", base.section);
	if (query.query?.trim()) params.set("q", query.query.trim());
	if (query.cursor) params.set("cursor", query.cursor);
	if (query.limit !== undefined) params.set("limit", String(query.limit));
	const search = params.toString();
	return search ? `?${search}` : "";
}

function unwrap<K extends string, T>(result: ApiResult<Record<K, T>>, key: K): ApiResult<T> {
	return result.ok ? { ok: true, data: result.data[key] } : result;
}

export { translationPath as inferenceTranslationPath };
