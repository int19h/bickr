import { createContext, useContext, type AriaRole, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { routePath, type ParsedRoute } from "../routes";

export type ContentRefType = "thread" | "comment";
export type OpenContentRefOptions = { replace?: boolean };

export const NavigationContext = createContext<{
	navigate: (parsed: ParsedRoute, replace?: boolean) => void;
	openContentRef: (type: ContentRefType, id: string, options?: OpenContentRefOptions) => Promise<void>;
}>({
	navigate: () => undefined,
	openContentRef: () => Promise.resolve(),
});

export function SpaLink({
	"aria-selected": ariaSelected,
	children,
	className,
	id,
	onNavigate,
	role,
	style,
	title,
	to,
}: {
	"aria-selected"?: boolean;
	children: ReactNode;
	className?: string;
	id?: string;
	onNavigate?: () => void;
	role?: AriaRole;
	style?: CSSProperties;
	title?: string;
	to: ParsedRoute;
}) {
	const { navigate } = useContext(NavigationContext);
	return (
		<a
			className={className}
			href={routePath(to)}
			id={id}
			onClick={(event) => {
				if (!shouldHandleSpaClick(event)) {
					return;
				}
				event.preventDefault();
				onNavigate?.();
				navigate(to);
			}}
			aria-selected={ariaSelected}
			role={role}
			style={style}
			title={title}
		>
			{children}
		</a>
	);
}

export function shouldHandleSpaClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
	return (
		event.button === 0 &&
		!event.defaultPrevented &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey &&
		event.currentTarget.target !== "_blank"
	);
}
