import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/extension.ts",
      formats: ["es"],
      fileName: () => "extension.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "node20",
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      external: ["vscode"],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
