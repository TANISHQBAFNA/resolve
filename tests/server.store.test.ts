import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { graph } from "./fixture";
import {
  clearCache,
  defaultGlobalStore,
  discoverStoreRoot,
  graphPath,
  listGraphs,
  loadContextBind,
  loadGraph,
  loadSock,
  missingGraphMessage,
  readContextPacks,
  readWorkspace,
  saveGraph,
  saveIngestedFile,
  sockPath,
  storeInfo,
  storeRoot,
  workspacePath,
} from "@/server/store";

describe("store", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "figma-resolve-store-"));
    process.env["RESOLVE_HOME"] = dir;
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("saveGraph writes only graph.json and deletes report sidecars", () => {
    mkdirSync(join(dir, "reports"), { recursive: true });
    mkdirSync(join(dir, "graphs"), { recursive: true });
    writeFileSync(join(dir, "GRAPH_REPORT.md"), "# leftover\n");
    writeFileSync(join(dir, "index.json"), "{}\n");
    writeFileSync(join(dir, "graphs", "old.json"), "{}\n");
    writeFileSync(join(dir, "reports", "old.md"), "# leftover\n");

    const summary = saveGraph(graph);

    expect(existsSync(graphPath())).toBe(true);
    expect(readdirSync(storeRoot()).sort()).toEqual(["graph.json"]);
    expect(loadGraph()?.graph.fileKey).toBe(graph.fileKey);
    expect(listGraphs()).toHaveLength(1);
    expect(summary.nodes).toBe(graph.nodes.length);
  });

  it("loads product+journey context packs from context-packs.json", () => {
    writeFileSync(
      join(dir, "context-packs.json"),
      JSON.stringify({
        active: "storefront-checkout-summary",
        packs: [
          {
            id: "storefront-checkout-summary",
            product: "Storefront",
            domain: "checkout",
            journey: "summary",
            recipeIds: ["checkout-summary"],
            figmaNodeId: "do-not-keep",
          },
        ],
      }),
    );
    const file = readContextPacks();
    expect(file.active).toBe("storefront-checkout-summary");
    expect(file.packs[0]?.domain).toBe("checkout");
    expect(file.packs[0] && "figmaNodeId" in file.packs[0]).toBe(false);
    const bind = loadContextBind();
    expect(bind.active).toBe("storefront-checkout-summary");
    expect(bind.packs).toHaveLength(1);
    expect(bind.workspace).toBeUndefined();
  });

  it("saveIngestedFile writes workspace.json + per-file graph and stamps fileKey", () => {
    const first = saveIngestedFile(graph, { role: "library", label: "Shared DS" });
    expect(first.role).toBe("library");
    expect(existsSync(workspacePath())).toBe(true);
    expect(readWorkspace().files[0]).toMatchObject({ role: "library", key: graph.fileKey, label: "Shared DS" });
    const loaded = loadGraph();
    expect(loaded?.graph.nodes.every((node) => node.fileKey === graph.fileKey)).toBe(true);
    expect(listGraphs()[0]?.role).toBe("library");
    expect(existsSync(graphPath())).toBe(true);
  });

  it("refuses to silently change an existing file role", () => {
    saveIngestedFile(graph, { role: "library", label: "Shared DS" });
    expect(() => saveIngestedFile(graph, { role: "product" })).toThrow(/already .*library/);
    expect(() => saveIngestedFile(graph, { role: "product" })).toThrow(/force-role|product/);
    expect(readWorkspace().files[0]?.role).toBe("library");
  });

  it("keeps the existing role on a same-file refresh when --role is omitted", () => {
    saveIngestedFile(graph, { role: "library", label: "Shared DS" });
    const again = saveIngestedFile(graph, { label: "Shared DS" });
    expect(again.role).toBe("library");
    expect(readWorkspace().files[0]?.role).toBe("library");
  });

  it("changes role only when forceRole is set", () => {
    saveIngestedFile(graph, { role: "library", label: "Shared DS" });
    const next = saveIngestedFile(graph, { role: "product", forceRole: true });
    expect(next.role).toBe("product");
    expect(readWorkspace().files[0]?.role).toBe("product");
  });

  it("reloads after another process writes graph.json (no clearCache)", () => {
    expect(loadGraph()).toBeUndefined();
    writeFileSync(graphPath(), `${JSON.stringify(graph)}\n`);
    const first = loadGraph();
    expect(first?.graph.fileName).toBe(graph.fileName);

    const updated = { ...graph, fileName: "Fresh ingest" };
    writeFileSync(graphPath(), `${JSON.stringify(updated)}\n`);
    const again = loadGraph();
    expect(again?.graph.fileName).toBe("Fresh ingest");
  });

  it("names the exact store path when no graph is stored", () => {
    const message = missingGraphMessage();
    expect(message).toContain(graphPath());
    expect(message).toContain(storeRoot());
    expect(message).toMatch(/learn_library|RESOLVE_HOME/i);
  });

  it("storeInfo reports the path the server is reading", () => {
    const info = storeInfo();
    expect(info.path).toBe(storeRoot());
    expect(info.graph).toBe(graphPath());
    expect(info.workspace).toBe(workspacePath());
    expect(info.builtAt).toBeUndefined();
    saveGraph(graph);
    expect(storeInfo().builtAt).toBe(graph.builtAt);
  });

  it("discoverStoreRoot walks up to a parent .resolve and honors RESOLVE_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-discover-"));
    const nested = join(root, "apps", "agent");
    mkdirSync(join(root, ".resolve"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".resolve", "graph.json"), "{}\n");

    expect(discoverStoreRoot(nested, {})).toBe(join(root, ".resolve"));
    expect(discoverStoreRoot(nested, { RESOLVE_HOME: dir })).toBe(dir);
  });

  it("defaults to ~/.resolve/<workspace> when no local .resolve exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "resolve-empty-cwd-"));
    expect(discoverStoreRoot(empty, { HOME: "/tmp/fake-home", RESOLVE_WORKSPACE: "acme" })).toBe(
      join("/tmp/fake-home", ".resolve", "acme"),
    );
    expect(defaultGlobalStore({ HOME: "/tmp/fake-home", RESOLVE_WORKSPACE: "acme" })).toBe(
      join("/tmp/fake-home", ".resolve", "acme"),
    );
    expect(() => defaultGlobalStore({ HOME: "/tmp/fake-home", RESOLVE_WORKSPACE: ".." })).toThrow(/RESOLVE_WORKSPACE/);
    expect(() => defaultGlobalStore({ HOME: "/tmp/fake-home", RESOLVE_WORKSPACE: "." })).toThrow(/RESOLVE_WORKSPACE/);
    expect(() => defaultGlobalStore({ HOME: "/tmp/fake-home", RESOLVE_WORKSPACE: "a/b" })).toThrow(/RESOLVE_WORKSPACE/);
    expect(() => defaultGlobalStore({ HOME: "/tmp/fake-home", RESOLVE_WORKSPACE: "a\\b" })).toThrow(/RESOLVE_WORKSPACE/);
  });

  it("clamps sock.json threshold and proposalCap and trims corrections", () => {
    const corrections = Array.from({ length: 201 }, (_, i) => ({
      fromId: "a",
      toId: "b",
      screenId: `s${i}`,
      fromName: "A",
      toName: "B",
      screenName: "One",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    }));
    writeFileSync(
      sockPath(),
      `${JSON.stringify({ version: 1, threshold: 1, proposalCap: 99, facts: [], freshness: {}, proposals: [], corrections })}\n`,
    );
    clearCache();
    const sock = loadSock();
    expect(sock?.threshold).toBe(3);
    expect(sock?.proposalCap).toBe(12);
    expect(sock?.corrections).toHaveLength(200);
    expect(sock?.corrections?.[0]?.screenId).toBe("s1");
    expect(sock?.warnings?.some((line) => /threshold/.test(line))).toBe(true);
    expect(sock?.warnings?.some((line) => /proposalCap/.test(line))).toBe(true);
    expect(sock?.warnings?.some((line) => /200/.test(line))).toBe(true);
  });
});
