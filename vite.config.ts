/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { createServer as createViteServer } from "vite";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

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

type ReadOnlyApi = {
  governanceView?: () => unknown;
  scoreboardView?: (env?: NodeJS.ProcessEnv, workspace?: string) => unknown;
};

function scoreboardWorkspaceQuery(url?: string): string | undefined {
  const query = url?.split("?")[1];
  if (!query) return undefined;
  const value = new URLSearchParams(query).get("workspace")?.trim();
  return value || undefined;
}

function readOnlyApiPath(url?: string): "/api/governance" | "/api/scoreboard" | undefined {
  const path = url?.split("?")[0];
  if (path === "/api/governance" || path === "/api/scoreboard") return path;
  return undefined;
}

function viewForPath(
  mod: ReadOnlyApi,
  path: "/api/governance" | "/api/scoreboard",
  url?: string,
): unknown {
  if (path === "/api/governance") return mod.governanceView?.();
  return mod.scoreboardView?.(process.env, scoreboardWorkspaceQuery(url));
}

function governanceApiPlugin(): Plugin {
  let previewLoader: Promise<ViteDevServer> | undefined;
  return {
    name: "resolve-governance-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const path = readOnlyApiPath(req.url);
        if (!path) {
          next();
          return;
        }
        void (async () => {
          try {
            const [governance, scoreboard] = await Promise.all([
              server.ssrLoadModule("/src/server/governance.ts") as Promise<ReadOnlyApi>,
              server.ssrLoadModule("/src/server/scoreboardView.ts") as Promise<ReadOnlyApi>,
            ]);
            const mod = path === "/api/governance" ? governance : scoreboard;
            sendGovernance(res, viewForPath(mod, path, req.url));
          } catch (error) {
            sendGovernanceError(res, error);
          }
        })();
      });
    },
    configurePreviewServer(server: PreviewServer) {
      const loadModule = async (specifier: string): Promise<ReadOnlyApi> => {
        previewLoader ??= createViteServer({
          configFile: false,
          root: fileURLToPath(new URL(".", import.meta.url)),
          appType: "custom",
          server: { middlewareMode: true, hmr: false, ws: false },
          resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
        });
        const vite = await previewLoader;
        return vite.ssrLoadModule(specifier) as Promise<ReadOnlyApi>;
      };
      server.middlewares.use((req, res, next) => {
        const path = readOnlyApiPath(req.url);
        if (!path) {
          next();
          return;
        }
        const specifier = path === "/api/governance" ? "/src/server/governance.ts" : "/src/server/scoreboardView.ts";
        void loadModule(specifier)
          .then((mod) => sendGovernance(res, viewForPath(mod, path, req.url)))
          .catch((error) => sendGovernanceError(res, error));
      });
    },
    closePreviewServer() {
      const pending = previewLoader;
      previewLoader = undefined;
      return pending?.then((vite) => vite.close());
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
