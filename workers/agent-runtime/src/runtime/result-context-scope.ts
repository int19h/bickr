export type ResultFacet = 'comment_body' | 'thread_body' | 'thread_title' | 'profile_display_name' | 'profile_bio' | 'forum_description';
export type FacetIdentity = { entityId: string; facet: ResultFacet };
export type ResultFacetValue = FacetIdentity & { shortened?: boolean } & (
	| { state: 'shown'; fingerprint: string; value: string }
	| { state: 'known'; fingerprint: string; value?: string }
);

/** A fingerprint is a hash of one value. The map holds values in the active context. */
export class ResultContextScope {
	private readonly fingerprints = new Map<string, string>();

	constructor(facets: Iterable<ResultFacetValue> = []) {
		this.include(facets);
	}

	clone(): ResultContextScope {
		const result = new ResultContextScope();
		for (const [key, fingerprint] of this.fingerprints) result.fingerprints.set(key, fingerprint);
		return result;
	}

	include(facets: Iterable<ResultFacetValue>): void {
		for (const facet of facets) {
			if (facet.state === 'shown') this.fingerprints.set(facetKey(facet), facet.fingerprint);
		}
	}

	knows(identity: FacetIdentity, fingerprint: string): boolean {
		return this.fingerprints.get(facetKey(identity)) === fingerprint;
	}

	async observe(identity: FacetIdentity, value: string): Promise<ResultFacetValue> {
		const fingerprint = await facetFingerprint(value);
		if (this.knows(identity, fingerprint)) return { entityId: identity.entityId, facet: identity.facet, state: 'known', fingerprint };
		this.fingerprints.set(facetKey(identity), fingerprint);
		return { entityId: identity.entityId, facet: identity.facet, state: 'shown', fingerprint, value };
	}
}

export function facetKey(identity: FacetIdentity): string {
	return JSON.stringify([identity.entityId, identity.facet]);
}

/**
 * Restore the newest matching reference only. A fingerprint binds a known
 * reference to the value it omitted, even when an entity changed later.
 */
export function hydrateResultFacets(removed: readonly ResultFacetValue[], kept: readonly ResultFacetValue[][]): number {
	const values = new Map<string, Extract<ResultFacetValue, { state: 'shown' }>>();
	for (const facet of removed) {
		if (facet.state === 'shown') values.set(JSON.stringify([facetKey(facet), facet.fingerprint]), facet);
	}
	// A kept shown value already supplies its matching known references.
	for (const facets of kept) {
		for (const facet of facets) {
			if (facet.state === 'shown') values.delete(JSON.stringify([facetKey(facet), facet.fingerprint]));
		}
	}
	let restored = 0;
	for (let row = kept.length - 1; row >= 0; row -= 1) {
		const facets = kept[row]!;
		for (let index = facets.length - 1; index >= 0; index -= 1) {
			const facet = facets[index]!;
			if (facet.state !== 'known') continue;
			const key = JSON.stringify([facetKey(facet), facet.fingerprint]);
			const shown = values.get(key);
			if (!shown) continue;
			facets[index] = { entityId: facet.entityId, facet: facet.facet, state: 'shown', fingerprint: facet.fingerprint, value: shown.value, ...(shown.shortened ? { shortened: true } : {}) };
			values.delete(key);
			restored += 1;
		}
	}
	return restored;
}

export async function facetFingerprint(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
