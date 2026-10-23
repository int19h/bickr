import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ParticipantTimeFields } from './participant-time-fields';

it('disables the timezone in relative mode and keeps the zone when absolute time is selected', async () => {
	const container = document.createElement('div');
	const root = createRoot(container);
	let value = { mode: 'relative' as 'relative' | 'absolute', timezone: 'Asia/Kolkata' };
	const render = () => root.render(<ParticipantTimeFields value={value} onChange={next => { value = next; render(); }} />);
	await act(render);
	const timezone = container.querySelector<HTMLInputElement>('input[aria-label="Timezone"]')!;
	expect(timezone.disabled).toBe(true);
	await act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
	expect(timezone.disabled).toBe(false);
	expect(timezone.value).toBe('Asia/Kolkata');
	expect(value).toEqual({ mode: 'absolute', timezone: 'Asia/Kolkata' });
	await act(() => root.unmount());
});

it('marks an invalid timezone and shows a correction', async () => {
	const container = document.createElement('div');
	const root = createRoot(container);
	await act(() => root.render(<ParticipantTimeFields value={{ mode: 'absolute', timezone: 'Mars/Olympus' }} onChange={() => {}} />));
	expect(container.querySelector('input[aria-label="Timezone"]')?.getAttribute('aria-invalid')).toBe('true');
	expect(container.textContent).toContain('Enter a valid IANA timezone name.');
	await act(() => root.unmount());
});
