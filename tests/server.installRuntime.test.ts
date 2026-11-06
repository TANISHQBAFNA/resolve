import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindCommandText, isCheckout, runtimeFor } from "../bin/install-runtime.mjs";
import { installMcp } from "../bin/resolve-setup.mjs";

describe("install runtime", () => {
  it("quotes a checkout path that contains a space and does not set a working directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "resolve-space-"));
    const root = join(parent, "my checkout");
    mkdirSync(join(root, "dist-server"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /tmp/not-used\n");
    writeFileSync(join(root, "dist-server", "mcp.mjs"), "");
    writeFileSync(join(root, "bin", "resolve-cli.mjs"), "");
    writeFileSync(join(root, "bin", "resolve-setup.mjs"), "");
    const runtime = runtimeFor(root);
    const built = realpathSync(join(root, "dist-server", "mcp.mjs"));
    expect(runtime.kind).toBe("checkout");
    expect(runtime.mcp).toEqual({ command: process.execPath, args: [built] });
    expect(runtime.cli).toContain("my checkout");
    expect(runtime.cli).toContain("'");
    const written = installMcp(null, { root });
    const doc = JSON.parse(written.text) as { mcpServers: { resolve: { args: string[]; cwd?: string } } };
    expect(doc.mcpServers.resolve.cwd).toBeUndefined();
    expect(doc.mcpServers.resolve.args[0]).toBe(built);
    expect(doc.mcpServers.resolve.args[0]).not.toContain("'");
    const bound = bindCommandText("run `npx -y -p github:TANISHQBAFNA/resolve#v0.2.0 resolve-figma status`", runtime);
    expect(bound).toContain(`${runtime.cli} status`);
    expect(bound).not.toContain("#v0.2.0");
  });

  it("a package with no git keeps the published tag", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-pack-"));
    mkdirSync(join(root, "dist-server"), { recursive: true });
    writeFileSync(join(root, "dist-server", "mcp.mjs"), "");
    expect(isCheckout(root)).toBe(false);
    expect(runtimeFor(root).mcp.args).toEqual(["-y", "-p", "github:TANISHQBAFNA/resolve#v0.2.0", "resolve-mcp"]);
  });

  it("does not write an npx cache path", () => {
    const parent = mkdtempSync(join(tmpdir(), "resolve-cache-"));
    const root = join(parent, "_npx", "abc");
    mkdirSync(join(root, "dist-server"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /tmp/x\n");
    writeFileSync(join(root, "dist-server", "mcp.mjs"), "");
    writeFileSync(join(root, "bin", "resolve-cli.mjs"), "");
    writeFileSync(join(root, "bin", "resolve-setup.mjs"), "");
    const runtime = runtimeFor(root);
    expect(runtime.kind).toBe("release");
    expect(JSON.stringify(runtime.mcp)).not.toContain(root);
  });

  it("a checkout without a build does not invent a server path", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-nobuild-"));
    writeFileSync(join(root, ".git"), "gitdir: /tmp/x\n");
    expect(() => runtimeFor(root)).toThrow(/npm run build:server/);
  });
});
