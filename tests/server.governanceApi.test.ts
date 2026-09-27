import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "http";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "node:url";
import { emptySock, proposeRuleChange } from "@/core/query/sock";
import { parseBindRulesFile } from "@/core/query/bindRules";
import { clearCache, saveSock, writeBindRules } from "@/server/store";
import { governanceView } from "@/server/governance";
import { governanceMiddleware } from "@/server/governanceHttp";

describe("/api/governance", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];

  beforeEach(() => {
    process.env["GRAPHIFY_HOME"] = mkdtempSync(join(tmpdir(), "resolve-gov-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
  });

  it("governanceView reads live rules, proposals, and why lines from the active store", () => {
    writeBindRules(
      parseBindRulesFile({
        rules: [{ screenType: "payment", slot: "primary-action", require: "Pay CTA" }, { forbid: "deprecated" }],
      }),
    );
    saveSock(
      proposeRuleChange(emptySock(), "Require Pay CTA for payment/primary-action", "used on 3 screens", {
        screenType: "payment",
        slot: "primary-action",
        require: "Pay CTA",
      }),
    );
    const view = governanceView();
    expect(view.rules.some((rule) => rule.label.includes("require payment/primary-action"))).toBe(true);
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0]?.status).toBe("pending");
    expect(view.hint).toMatch(/Read-only/);
  });

  it("serves /api/governance from the Vite middleware", async () => {
    writeBindRules(parseBindRulesFile({ rules: [{ forbid: "deprecated" }] }));
    saveSock(
      proposeRuleChange(emptySock(), "Pending rule", "evidence from Payment", {
        screenType: "payment",
        slot: "primary-action",
        require: "Pay CTA",
      }),
    );
    const root = fileURLToPath(new URL("..", import.meta.url));
    const server = await createViteServer({
      configFile: join(root, "vite.config.ts"),
      root,
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    try {
      const base = server.resolvedUrls?.local[0];
      expect(base).toBeTruthy();
      const response = await fetch(new URL("/api/governance", base!));
      expect(response.ok).toBe(true);
      const body = (await response.json()) as {
        rules: Array<{ label: string }>;
        proposals: unknown[];
        patterns: Array<{ why: string }>;
        hint: string;
      };
      expect(body.rules.some((rule) => rule.label.includes("forbid"))).toBe(true);
      expect(body.proposals).toHaveLength(1);
      expect(body.hint).toMatch(/Read-only/);
    } finally {
      await server.close();
    }
  });

  it("quarantines a bad require on disk and names it in warnings", () => {
    writeFileSync(
      join(process.env["GRAPHIFY_HOME"]!, "bind-rules.json"),
      `${JSON.stringify({
        version: 1,
        rules: [{ require: "node:gone" }, { forbid: "deprecated" }],
      })}\n`,
    );
    const view = governanceView();
    expect(view.rules.some((rule) => rule.kind === "forbid")).toBe(true);
    expect(view.rules.some((rule) => rule.kind === "require" && rule.require === "node:gone")).toBe(false);
    expect(view.warnings.some((row) => /unscoped|unknown|gone/i.test(row.reason))).toBe(true);
  });

  it("serves /api/governance from the shared production middleware", async () => {
    writeBindRules(parseBindRulesFile({ rules: [{ forbid: "deprecated" }] }));
    const server = createServer((req, res) => {
      governanceMiddleware(req, res, () => {
        res.statusCode = 404;
        res.end("no");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/governance`);
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { hint: string; proposalGroups?: unknown[] };
      expect(body.hint).toMatch(/Read-only/);
      expect(Array.isArray(body.proposalGroups)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("preview governance loader does not open an HMR socket", () => {
    const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(source).toMatch(/middlewareMode:\s*true,\s*hmr:\s*false/);
  });
});
