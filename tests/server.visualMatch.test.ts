import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scoreUnmatched } from "@/core/query/draftScore";
import { setVisualShot, visualPoints, visualSignal } from "@/core/query/visualMatch";
import { mapReport } from "@/server/code/map";
import { buildCatalog } from "@/server/code/scan";
import { runLinkMap } from "@/server/code/command";
import type { ResolveConfig } from "@/server/mode";

const buttonPng = readFileSync(join(process.cwd(), "fixtures/acme-visual/acme-button.png"));
const chipPng = readFileSync(join(process.cwd(), "fixtures/acme-visual/acme-chip.png"));
const badgePng = readFileSync(join(process.cwd(), "fixtures/acme-visual/acme-badge.png"));

function tree(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
}

function config(repo: string, store: string): ResolveConfig {
  return { mode: "both", modeSource: "env", repoPath: repo, localPrefixes: [], storeDir: store };
}

function capture(run: () => void): string {
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

const masters = [{ name: "AcmePay", nodeId: "1:2", variants: ["bold"], properties: { tone: ["bold"] }, description: "Pay control" }];

describe("visual match on Acme fixture PNGs", () => {
  afterEach(() => {
    setVisualShot(undefined);
    process.exitCode = undefined;
  });

  it("orders the same component above a renamed lookalike and a different component", () => {
    const same = visualPoints(buttonPng, buttonPng);
    const lookalike = visualPoints(buttonPng, chipPng);
    const different = visualPoints(buttonPng, badgePng);
    expect(same).toBe(20);
    expect(lookalike).toBe(17);
    expect(different).toBe(5);

    const root = join(tmpdir(), `resolve-visual-rank-${Date.now()}`);
    const store = join(root, "store");
    tree(root, {
      ".resolve/figma-images/AcmePay.png": buttonPng,
      ".resolve/figma-images/1-2.png": buttonPng,
      "remit/remit.html": "<button class=\"remit\">Pay</button>\n",
      "voucher/voucher.html": "<span class=\"voucher\">Save</span>\n",
      "seal/seal.html": "<i class=\"seal\">3</i>\n",
    });
    mkdirSync(store, { recursive: true });
    const shots: Record<string, Buffer> = { remit: buttonPng, voucher: chipPng, seal: badgePng };
    setVisualShot(({ codeName }) => shots[codeName]);
    const cfg = config(root, store);
    const report = mapReport(buildCatalog(cfg), cfg, { suggest: true, masters, limit: 5 });
    const drafts = (report.suggestions ?? []).filter((row) => row.figma === "AcmePay");
    expect(drafts.map((row) => row.code)).toEqual(["remit", "voucher", "seal"]);
    expect(drafts.map((row) => row.score)).toEqual([same, lookalike, different]);
    for (const row of drafts) {
      expect(row.confidence).toBe("suggested");
      expect(row.reasons.join("\n")).not.toMatch(/not yet measured/);
      expect(row.reasons.join("\n")).toMatch(/visual \d+\/20/);
    }
    expect(report.pairs.map((pair) => pair.code)).not.toContain("remit");
    expect(report.pairs.map((pair) => pair.code)).not.toContain("voucher");
    expect(report.pairs.map((pair) => pair.code)).not.toContain("seal");
    expect(report.bulkConfirm ?? []).not.toContain("AcmePay=remit");
    expect(report.bulkConfirm ?? []).not.toContain("AcmePay=voucher");
    expect(report.bulkConfirm ?? []).not.toContain("AcmePay=seal");
    expect(readFileSync(join(root, "remit/remit.html"), "utf8")).not.toContain("data-ds-id");
  });

  it("finds a PNG by node id and an example HTML file, and still does not link", () => {
    const root = join(tmpdir(), `resolve-visual-id-${Date.now()}`);
    const store = join(root, "store");
    tree(root, {
      ".resolve/figma-images/1-2.png": buttonPng,
      "pack/component.json": `${JSON.stringify({ id: "pack", example: "example.html" })}\n`,
      "pack/example.html": "<div class=\"pack\">Pay</div>\n",
    });
    mkdirSync(store, { recursive: true });
    setVisualShot(() => buttonPng);
    const rows = scoreUnmatched({
      figma: { name: "AcmePay", nodeId: "1:2" },
      codes: [{ name: "pack", variants: [], modifiers: [], elements: [], tokens: [], aliases: [], files: ["pack/component.json"] }],
      repo: root,
    });
    expect(rows[0]?.reasons.join("\n")).toMatch(/visual 20\/20/);
    expect(rows[0]?.reasons.join("\n")).toMatch(/1-2\.png/);
    expect(rows[0]?.reasons.join("\n")).toMatch(/example\.html/);
    const report = mapReport(buildCatalog(config(root, store)), config(root, store), { suggest: true, masters, limit: 5 });
    expect(report.pairs.map((pair) => `${pair.figma}=${pair.code}`)).not.toContain("AcmePay=pack");
    expect(report.bulkConfirm ?? []).not.toContain("AcmePay=pack");
  });

  it("stays at 0 with a next step when the PNG or the render is missing, and the command exits 0", () => {
    const missing = visualSignal({ repo: join(tmpdir(), "resolve-visual-none"), figmaName: "AcmePay", codeName: "remit", files: [] });
    expect(missing.points).toBe(0);
    expect(missing.text).toMatch(/visual 0\/20 not yet measured/);
    expect(missing.text).toMatch(/next: export a PNG of this Figma component to \.resolve\/figma-images\/AcmePay\.png/);
    expect(missing.text).toMatch(/does not use a Figma token/);

    const root = join(tmpdir(), `resolve-visual-miss-${Date.now()}`);
    const store = join(root, "store");
    tree(root, {
      ".resolve/figma-images/AcmePay.png": buttonPng,
      "remit/remit.html": "<button class=\"remit\" data-tone=\"bold\">Pay</button>\n",
    });
    mkdirSync(store, { recursive: true });
    process.env["FIGMA_ACCESS_TOKEN"] = "not-a-real-token";
    setVisualShot(() => undefined);
    try {
      const quiet = visualSignal({
        repo: root,
        figmaName: "AcmePay",
        codeName: "remit",
        files: [{ file: "remit/remit.html", abs: join(root, "remit/remit.html") }],
      });
      expect(quiet.points).toBe(0);
      expect(quiet.text).toMatch(/visual 0\/20 not yet measured/);
      expect(quiet.text).toMatch(/next:/);

      const out = capture(() => runLinkMap(["--repo", root, "--suggest", "--limit", "5"], () => masters));
      expect(out).toMatch(/visual 0\/20 not yet measured/);
      expect(out).toMatch(/next:/);
      expect(out).not.toMatch(/Confirmed/);
      expect(process.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(root, "remit/remit.html"), "utf8")).not.toContain("data-ds-id");
    } finally {
      delete process.env["FIGMA_ACCESS_TOKEN"];
    }
  });

  it("does not throw when a browser is absent, and a real render stays inside 0-20", () => {
    const root = join(tmpdir(), `resolve-visual-live-${Date.now()}`);
    tree(root, {
      ".resolve/figma-images/AcmePay.png": buttonPng,
      "remit/remit.html": "<button class=\"remit\" style=\"display:block;width:52px;height:24px;margin:8px 6px;background:#1b4fd8;border:0\">Pay</button>\n",
    });
    const live = visualSignal({
      repo: root,
      figmaName: "AcmePay",
      codeName: "remit",
      files: [{ file: "remit/remit.html", abs: join(root, "remit/remit.html") }],
    });
    expect(live.points).toBeGreaterThanOrEqual(0);
    expect(live.points).toBeLessThanOrEqual(20);
    if (live.text.includes("not yet measured")) {
      expect(live.points).toBe(0);
      expect(live.text).toMatch(/next:/);
    } else {
      expect(live.text).toMatch(/visual \d+\/20/);
      expect(live.text).toMatch(/\.resolve\/figma-images\/AcmePay\.png/);
    }
  }, 25000);
});
