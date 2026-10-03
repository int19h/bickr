import { useEffect, useRef, useState } from 'react';
import { mathService } from './math-service';
import { prepareMathSvg } from './math-svg';
type Props = { source: string; display: boolean; 'data-md-start'?: number; 'data-md-end'?: number; 'data-md-atomic'?: boolean };
export function MathExpression(props: Props) {
	return <MathContent key={`${props.display}:${props.source}`} {...props} />;
}
function MathContent({ source, display, ...sourceAttributes }: Props) {
	const host = useRef<HTMLSpanElement>(null);
	const [state, setState] = useState<'pending' | 'ready' | 'rejected'>('pending');
	useEffect(() => {
		return mathService.render(source, display, (result) => {
			const prepared = result.kind === 'rendered' ? prepareMathSvg(result.svg) : { kind: 'rejected' as const };
			if (prepared.kind === 'ready') {
				if (!display) {
					const svg = prepared.fragment.querySelector('svg')!;
					// The scroll wrapper participates in the text line. Apply the
					// validated MathJax baseline offset there, not inside the wrapper.
					if (host.current) host.current.style.verticalAlign = svg.style.verticalAlign;
					svg.style.removeProperty('vertical-align');
				}
				host.current?.replaceChildren(prepared.fragment);
				setState('ready');
			} else setState('rejected');
		});
	}, [source, display]);
	return (
		<span className={`math-expression${display ? ' math-display' : ''}`} data-math-state={state} {...sourceAttributes}>
			<span ref={host} className="math-output" role="img" aria-label={`Formula: ${source}`} hidden={state !== 'ready'} />
			{state !== 'ready' && (
				<code className="math-fallback" title={state === 'pending' ? 'Rendering formula' : 'Formula could not render'}>
					{source}
				</code>
			)}
		</span>
	);
}
