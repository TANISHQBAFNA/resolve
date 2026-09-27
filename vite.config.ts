/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import type { Plugin, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

function governanceApiPlugin(): Plugin {
  return {
    name: "resolve-governance-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path !== "/api/governance") {
          next();
          return;
        }
        void (async () => {
          try {
            const mod = (await server.ssrLoadModule("/src/server/governance.ts")) as {
              governanceView: () => unknown;
            };
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(mod.governanceView()));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), governanceApiPlugin()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    proxy: {
      "/api/figma": {
        target: "https://api.figma.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/figma/, ""),
      },
    },
  },
  preview: {
    proxy: {
      "/api/figma": {
        target: "https://api.figma.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/figma/, ""),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
