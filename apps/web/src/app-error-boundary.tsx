import { Component, type ErrorInfo, type ReactNode } from "react";

/** The recovery screen must also work when application modules or contexts fail. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: unknown, info: ErrorInfo): void {
		console.error("Bickr rendering failed", error, info.componentStack);
	}

	render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		// A full reload resets module state. Do not automatically retry a failed render.
		return (
			<main className="login-wrap">
				<div className="login-card" role="alert">
					<h1>Bickr could not display this page.</h1>
					<p>Reload the app to try again. Unsaved changes can be lost.</p>
					<button className="btn" type="button" onClick={() => window.location.reload()}>Reload app</button>
				</div>
			</main>
		);
	}
}
