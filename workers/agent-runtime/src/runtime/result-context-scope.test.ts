import { describe, expect, it } from 'vitest';
import { ResultContextScope, facetFingerprint, hydrateResultFacets, type ResultFacet, type ResultFacetValue } from './result-context-scope';

const facets: ResultFacet[] = ['comment_body', 'thread_body', 'thread_title', 'profile_display_name', 'profile_bio', 'forum_description'];
describe('result context scope', () => {
	it.each(facets)('shows changed %s values and isolates entity IDs', async facet => {
		const scope = new ResultContextScope();
		expect(await scope.observe({ entityId: 'one', facet }, 'before')).toMatchObject({ state: 'shown', value: 'before' });
		expect(await scope.observe({ entityId: 'one', facet }, 'before')).toMatchObject({ state: 'known' });
		expect(await scope.observe({ entityId: 'one', facet }, 'after')).toMatchObject({ state: 'shown', value: 'after' });
		expect(await scope.observe({ entityId: 'two', facet }, 'after')).toMatchObject({ state: 'shown' });
	});
	it('does not count known-only references as present content', async () => {
		const fingerprint = await facetFingerprint('missing');
		const scope = new ResultContextScope([{ entityId: 'one', facet: 'comment_body', state: 'known', fingerprint }]);
		expect(scope.knows({ entityId: 'one', facet: 'comment_body' }, fingerprint)).toBe(false);
	});
	it.each(facets)('hydrates only the newest kept matching %s reference', async facet => {
		const fingerprint = await facetFingerprint('before');
		const shown: ResultFacetValue = { entityId: 'one', facet, state: 'shown', fingerprint, value: 'before' };
		const known: ResultFacetValue = { entityId: 'one', facet, state: 'known', fingerprint };
		const changed: ResultFacetValue = { entityId: 'one', facet, state: 'known', fingerprint: await facetFingerprint('after') };
		const kept = [[{ ...known }], [{ ...known }, changed]];
		expect(hydrateResultFacets([shown], kept)).toBe(1);
		expect(kept[0]![0]).toEqual(known);
		expect(kept[1]![0]).toEqual(shown);
		expect(kept[1]![1]).toEqual(changed);
	});
	it('keeps existing shown values without duplication', async () => {
		const shown: ResultFacetValue = { entityId: 'one', facet: 'comment_body', state: 'shown', fingerprint: await facetFingerprint('body'), value: 'body' };
		expect(hydrateResultFacets([shown], [[{ ...shown }], [{ entityId: 'one', facet: 'comment_body', state: 'known', fingerprint: shown.fingerprint }]])).toBe(0);
	});
});
