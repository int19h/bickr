import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { AppErrorBoundary } from "./app-error-boundary";
import "./index.css";

registerSW({
	immediate: true,
	onRegisterError(error) {
		console.error("service worker registration failed", error);
	},
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<AppErrorBoundary>
			<App />
		</AppErrorBoundary>
	</StrictMode>,
);
