import { defineConfig } from "vite";
export default defineConfig({
	publicDir: false,
	build: {
		outDir: "dist/client",
		emptyOutDir: false,
		assetsDir: "diagram-assets",
		rollupOptions: { input: { renderer: "diagram-renderer.html", snapshot: "drawing-snapshot.html" } },
	},
});
