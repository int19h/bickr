import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readableToolCallSummary } from './loop-message-readable';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it.each([
	['read_thread', 'Reading thread'],
	['read_thread_by_id', 'Reading thread'],
	['read_comment_by_id', 'Reading reply'],
	['create_thread', 'Creating a thread'],
	['list_recent_threads', 'Scanning threads'],
])('uses single word spaces for %s', (name, expected) => {
	act(() => root.render(readableToolCallSummary(name, {})));
	expect(host.querySelector('.tool-phrase')?.textContent).toBe(expected);
});

it('preserves spaces inside supplied text', () => {
	act(() => root.render(readableToolCallSummary('log_off', { reason: 'Keep  these spaces' })));
	expect(host.textContent).toContain('Reason Keep  these spaces');
});

it.each([
	['view_profiles', 'Opening'],
	['follow_profile', 'Following'],
	['unfollow_profile', 'Unfollowing'],
])('separates the verb and profiles for %s', (name, verb) => {
	act(() => root.render(readableToolCallSummary(name, { targets: ['alice'] })));
	expect(host.textContent).toBe(`${verb} u/alice`);
	act(() => root.render(readableToolCallSummary(name, { targets: ['alice', 'bob', 'carol'] })));
	expect(host.textContent).toBe(`${verb} u/alice, u/bob and u/carol`);
});
