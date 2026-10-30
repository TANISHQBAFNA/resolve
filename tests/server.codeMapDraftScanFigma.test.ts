import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodeCommand, runLinkMap } from "@/server/code/command";
import { graphMasters } from "@/server/graphMasters";
import { clearCache } from "@/server/store";

const saved = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };
afterEach(() => {
  for (const [key, value] of [["RESOLVE_HOME", saved.home], ["RESOLVE_MODE", saved.mode]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearCache();
});

function quiet(run: () => void): string {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = write;
  }
  return lines.join("");
}

type Row = { figma: string; code: string; status: string };

describe("code-map review with Figma components from code scan --figma", () => {
  it("drafts, confirms and denies when no Figma library is learned", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-draft-figma-"));
    const repo = join(root, "repo");
    const store = join(root, "store");
    mkdirSync(store, { recursive: true });
    for (const [name, body] of [
      ["acme-button", ".acme-button { color: var(--ink); }\n.acme-button--primary { color: var(--ink); }\n"],
      ["acme-banner", ".acme-banner { color: var(--ink); }\n.acme-banner--promo { color: var(--ink); }\n"],
      ["acme-badge", ".acme-badge { color: var(--ink); }\n"],
    ]) {
      mkdirSync(join(repo, "building-blocks", name), { recursive: true });
      writeFileSync(join(repo, "building-blocks", name, `${name}.css`), body);
    }
    const mastersFile = join(root, "masters.json");
    writeFileSync(mastersFile, JSON.stringify([
      { name: "Acme Button", nodeId: "1:1", variants: ["primary"] },
      { name: "Acme Banner", nodeId: "1:2", variants: ["promo"] },
      { name: "Acme Badge", nodeId: "1:3" },
    ]));
    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "both";
    clearCache();
    expect(graphMasters()).toEqual([]);
    quiet(() => runCodeCommand(["scan", "--repo", repo, "--figma", mastersFile], graphMasters));

    const drafted = quiet(() => runLinkMap(["--repo", repo, "--draft"], graphMasters));
    expect(drafted).not.toContain(": 0 proposed");
    const file = join(repo, ".resolve", "component-map.json");
    expect(existsSync(file)).toBe(true);
    const rows = () => (JSON.parse(readFileSync(file, "utf8")) as { entries: Row[] }).entries;
    const pairs = rows().map((row) => `${row.figma}=${row.code}:${row.status}`);
    expect(pairs).toContain("Acme Button=acme-button:proposed");
    expect(pairs).toContain("Acme Banner=acme-banner:proposed");
    expect(pairs).toContain("Acme Badge=acme-badge:proposed");

    expect(quiet(() => runLinkMap(["--repo", repo, "--confirm", "Acme Badge=acme-badge", "--who", "tester"], graphMasters))).toContain("Confirmed 1 pair(s)");
    expect(quiet(() => runLinkMap(["--repo", repo, "--deny", "Acme Banner=acme-banner", "--who", "tester"], graphMasters))).toContain("Denied 1 pair(s)");
    const reviewed = rows();
    expect(reviewed.find((row) => row.figma === "Acme Badge" && row.code === "acme-badge")?.status).toBe("confirmed");
    expect(reviewed.find((row) => row.figma === "Acme Banner" && row.code === "acme-banner")?.status).toBe("denied");

    const report = JSON.parse(quiet(() => runLinkMap(["--repo", repo, "--pairs", "--json"], graphMasters))) as { pairs: Array<{ figma: string; code: string }> };
    expect(report.pairs.map((pair) => `${pair.figma}=${pair.code}`)).toEqual(["Acme Badge=acme-badge"]);
  });
});
