import { createContext, forwardRef, useContext, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { Icon } from '../../ui';

const ExpansionContext = createContext<{ id: string; expanded: boolean; long: boolean; toggle: () => void } | null>(null);

export const AgentLogCard = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'> & { expandable: boolean }>(function AgentLogCard(
	{ expandable, children, className, ...props }, forwardedRef,
) {
	const ref = useRef<HTMLDivElement>(null);
	const id = useId();
	const [expanded, setExpanded] = useState(false);
	const [long, setLong] = useState(false);
	useImperativeHandle(forwardedRef, () => ref.current!);
	// The caller always renders exactly one AgentLogBody, so the observed node
	// is the same for the life of the card. ResizeObserver reports later size
	// changes. Without it, the effect still has to measure after every render,
	// because nothing else reports a size change. The dependency below is stable
	// per environment: this app does not add or remove ResizeObserver at runtime.
	// An expanded card can keep a stale `long` after a viewport change across the
	// 640px breakpoint until the next body resize, when its height sits between
	// the 260px and 300px values of --loop-result-height.
	useLayoutEffect(() => {
		const body = ref.current?.querySelector<HTMLElement>('.agent-log-body');
		if (!expandable || !body) return;
		const measure = () => {
			const limit = Number.parseFloat(getComputedStyle(body).getPropertyValue('--loop-result-height')) || 300;
			setLong(body.scrollHeight > limit);
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		return () => observer.disconnect();
	}, typeof ResizeObserver === 'undefined' ? undefined : [expandable]);
	return (
		<ExpansionContext.Provider value={{ id, expanded, long: expandable && long, toggle: () => setExpanded(value => !value) }}>
			<div {...props} className={`${className ?? ''}${expandable && !expanded ? ' result-collapsed' : ''}`} ref={ref}>{children}</div>
		</ExpansionContext.Provider>
	);
});

export function AgentLogBody({ children }: ComponentPropsWithoutRef<'div'>) {
	const state = useContext(ExpansionContext);
	return <div className="agent-log-body" id={state?.id} onFocusCapture={event => {
		if (state?.long && !state.expanded && event.target.getBoundingClientRect().bottom > event.currentTarget.getBoundingClientRect().bottom) state.toggle();
	}}>{children}</div>;
}

export function AgentLogExpandControl() {
	const state = useContext(ExpansionContext);
	if (!state?.long) return null;
	return (
		<button className="agent-log-expand" type="button" aria-controls={state.id} aria-expanded={state.expanded} onClick={state.toggle}>
			{state.expanded ? 'Collapse' : 'Show all'} <Icon name="chev" className={state.expanded ? 'expanded' : ''} size={12} />
		</button>
	);
}
