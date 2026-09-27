/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { createServer as createViteServer } from "vite";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

function isGovernancePath(url?: string): boolean {
  return (url?.split("?")[0] ?? "") === "/api/governance";
}

function sendGovernance(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void }, view: unknown): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(view));
}

function sendGovernanceError(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void }, error: unknown): void {
  res.statusCode = 500;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}

function governanceApiPlugin(): Plugin {
  return {
    name: "resolve-governance-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (!isGovernancePath(req.url)) {
          next();
          return;
        }
        void (async () => {
          try {
            const mod = (await server.ssrLoadModule("/src/server/governance.ts")) as {
              governanceView: () => unknown;
            };
            sendGovernance(res, mod.governanceView());
          } catch (error) {
            sendGovernanceError(res, error);
          }
        })();
      });
    },
    configurePreviewServer(server: PreviewServer) {
      let loader: Promise<ViteDevServer> | undefined;
      const loadView = async () => {
        loader ??= createViteServer({
          configFile: false,
          root: fileURLToPath(new URL(".", import.meta.url)),
          appType: "custom",
          server: { middlewareMode: true },
          resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
        });
        const vite = await loader;
        const mod = (await vite.ssrLoadModule("/src/server/governance.ts")) as {
          governanceView: () => unknown;
        };
        return mod.governanceView();
      };
      server.middlewares.use((req, res, next) => {
        if (!isGovernancePath(req.url)) {
          next();
          return;
        }
        void loadView()
          .then((view) => sendGovernance(res, view))
          .catch((error) => sendGovernanceError(res, error));
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
