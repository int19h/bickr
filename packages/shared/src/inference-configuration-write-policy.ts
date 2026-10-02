import { legacyInferenceCompatibilityFieldMaskIsEmpty, type LegacyInferenceCompatibilityFieldMask } from "./inference-configuration-legacy";
import { InferenceGraphRepositoryError, inferenceGraphReadVersion } from "./inference-configuration-repository";
import type { D1DatabaseLike } from "./storage";

/** Refuse obsolete inputs before a document or avatar mutation starts. */
export async function assertLegacyInferenceWriteSupported(
	db: D1DatabaseLike,
	ownerUserId: string,
	mask: LegacyInferenceCompatibilityFieldMask,
): Promise<void> {
	if (legacyInferenceCompatibilityFieldMaskIsEmpty(mask)) return;
	const version = await inferenceGraphReadVersion(db, ownerUserId);
	if (version.cutoverVersion === 0) return;
	if (version.writerVersion === 1 && mask.translationFields.length === 0) {
		const projection = await db.prepare(
			"SELECT owner_user_id FROM inference_graph_legacy_projections WHERE owner_user_id = ? LIMIT 1",
		).bind(ownerUserId).first();
		if (projection) return;
	}
	throw new InferenceGraphRepositoryError(
		"legacy_write_disabled",
		"Use the inference configuration API to change provider configuration for this profile.",
	);
}
