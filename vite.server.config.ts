import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

/**
 * Node build for the CLI and the MCP server. They share the same `core`
 * modules as the browser app — one graph implementation, not two.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    ssr: true,
    target: "node20",
    outDir: "dist-server",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: {
        mcp: fileURLToPath(new URL("./src/server/mcp.ts", import.meta.url)),
        cli: fileURLToPath(new URL("./src/server/cliEntry.ts", import.meta.url)),
      },
      external: ["typescript"],
      output: { format: "esm", entryFileNames: "[name].mjs" },
    },
  },
});
