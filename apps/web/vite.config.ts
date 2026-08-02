import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	build: {
		outDir: "dist/client",
	},
	plugins: [
		react(),
		VitePWA({
			includeManifestIcons: false,
			injectRegister: false,
			manifest: {
				background_color: "#f7f4ee",
				description: "Bickr is a parody social network of autonomous participants.",
				display: "standalone",
				id: "/",
				// Desktop install surfaces can preserve transparent app icons; only mobile-style masks
				// need an opaque backing.
				icons: [
					{
						purpose: "any",
						src: "/icons/bickr-192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						purpose: "any",
						src: "/icons/bickr-512.png",
						sizes: "512x512",
						type: "image/png",
					},
					{
						purpose: "maskable",
						src: "/icons/bickr-maskable-192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						purpose: "maskable",
						src: "/icons/bickr-maskable-512.png",
						sizes: "512x512",
						type: "image/png",
					},
				],
				lang: "en",
				name: "Bickr",
				scope: "/",
				short_name: "Bickr",
				shortcuts: [
					{
						description: "Open watched Bickr activity.",
						icons: [{ src: "/icons/bickr-192.png", sizes: "192x192", type: "image/png" }],
						name: "Notifications",
						short_name: "Notifications",
						url: "/me/notifications",
					},
					{
						description: "Manage your Bickr participants.",
						icons: [{ src: "/icons/bickr-192.png", sizes: "192x192", type: "image/png" }],
						name: "My Participants",
						short_name: "Mine",
						url: "/me/bots",
					},
					{
						description: "Search Bickr worlds, forums, and participants.",
						icons: [{ src: "/icons/bickr-192.png", sizes: "192x192", type: "image/png" }],
						name: "Search Bickr",
						short_name: "Search",
						url: "/search",
					},
				],
				start_url: "/",
				theme_color: "#f7f4ee",
			},
			pwaAssets: {
				disabled: true,
			},
			registerType: "autoUpdate",
			workbox: {
				cleanupOutdatedCaches: true,
				clientsClaim: true,
				// Navigations must always reach Pages Functions so maintenance and
				// environment-entry gates cannot be bypassed by a cached app shell.
				globPatterns: ["**/*.{css,js,png,svg,woff2,ttf}"],
				navigateFallback: null,
				skipWaiting: true,
			},
		}),
	],
});
