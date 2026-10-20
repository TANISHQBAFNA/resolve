import { describe, expect, it } from "vitest";
import bundle from "../docs/examples/acme-proper-use.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { indexGraph, verifyFrame } from "@/core/query";
import { checkProperUse, verifyExitCode } from "@/core/query/properUse";
import { presentToolResult } from "@/server/cards";
import { DEFAULT_TOOL_NAMES, TOOLS } from "@/server/tools";

const FROZEN = "2026-01-01T00:00:00.000Z";

/** Known defects on Misused. A finding outside this set is a false positive. */
const EXPECTED = [
  ["80:11", "detached"],
  ["80:61", "detached"],
  ["80:21", "colour"],
  ["80:21", "radius"],
  ["80:21", "effect"],
  ["80:101", "spacing"],
  ["80:131", "colour"],
  ["80:31", "contrast"],
  ["80:41", "tap"],
  ["80:51", "icon"],
  ["80:32", "unknown"],
  ["80:1", "unknown"],
] as const;

const ALLOWED = new Set(EXPECTED.map(([id, check]) => `${id}:${check}`));

function graphOf(kind: "figma-rest" | "figma-mcp") {
  return indexGraph(
    buildGraph(
      adaptFigmaRestFile({
        fileKey: "ACMEUSE",
        file: bundle.file,
        variables: bundle.variables,
        kind,
        ingestedAt: FROZEN,
      }),
      { builtAt: FROZEN },
    ),
  );
}

function signature(findings: Array<{ severity: string; check: string; figmaNodeId?: string; token?: string; component?: string }>) {
  return findings.map((finding) =>
    [finding.severity, finding.check, finding.figmaNodeId, finding.token ?? "", finding.component ?? ""].join(" "),
  );
}

describe("Acme proper use", () => {
  const index = graphOf("figma-rest");

  it("keeps the default MCP tool list at 7", () => {
    expect([...DEFAULT_TOOL_NAMES]).toEqual([
      "learn_library",
      "recipe",
      "brief",
      "recommend",
      "resolve",
      "get_example",
      "verify_frame",
      "check_cousins",
    ]);
  });

  it("flags the known Misused defects and nothing else", () => {
    const report = checkProperUse(index, "Misused");
    expect(report).toBeTruthy();
    const findings = report!.findings;
    const keys = findings.map((finding) => `${finding.figmaNodeId}:${finding.check}`);
    const falsePositives = keys.filter((key) => !ALLOWED.has(key));
    const missed = EXPECTED.filter(([id, check]) => !keys.includes(`${id}:${check}`));
    const truePositives = keys.length - falsePositives.length;
    const precision = truePositives / keys.length;
    expect({ precision, falsePositives, missed, signature: signature(findings) }).toEqual({
      precision: 1,
      falsePositives: [],
      missed: [],
      signature: signature(findings),
    });
    expect(precision).toBe(1);
    expect(report).toMatchObject({
      errors: 5,
      warnings: 7,
      unknown: 2,
      exitCode: 7,
      level: "wcag-aa",
      summary:
        "2 detached, 3 hard-coded colours, 2 hard-coded spacing, 1 hard-coded radius, 1 hard-coded effect, 1 contrast fail, 1 tap target, 1 icon-only button, 2 unknown",
    });

    const detached = findings.find((finding) => finding.figmaNodeId === "80:11");
    expect(detached).toMatchObject({
      severity: "error",
      check: "detached",
      component: "Button",
      fileKey: "ACMEUSE",
      componentKey: "acme-button-set",
      fix: "Re-insert the instance.",
    });
    expect(findings.find((finding) => finding.figmaNodeId === "80:61")).toMatchObject({
      component: "Status row",
      fileKey: "ACMEUSE",
      componentKey: "acme-status-row",
      fix: "Re-insert the instance.",
    });
    const colours = findings.filter((finding) => finding.check === "colour").map((finding) => finding.problem);
    expect(colours.some((problem) => problem.includes("Fill #1A73E8") && problem.includes("color/primary/600"))).toBe(true);
    expect(colours.some((problem) => problem.includes("Stroke #1A1A1A") && problem.includes("color/text/strong"))).toBe(true);
    expect(findings.find((finding) => finding.figmaNodeId === "80:131")?.token).toBe("color/primary/600");
    expect(findings.find((finding) => finding.check === "radius")?.token).toBe("radius/8");
    expect(findings.find((finding) => finding.check === "effect")?.token).toBe("Effect/Card shadow");
    expect(findings.filter((finding) => finding.check === "spacing").every((finding) => finding.token === "space/16")).toBe(true);
    expect(findings.find((finding) => finding.check === "contrast")?.problem).toMatch(/below 4\.5:1 for wcag-aa/);
    expect(findings.find((finding) => finding.check === "tap")?.problem).toMatch(/30×30, under the 44×44/);
    expect(findings.find((finding) => finding.check === "icon")?.problem).toMatch(/no label or description/);
    expect(findings.find((finding) => finding.figmaNodeId === "80:32")?.fix).toMatch(/translucent/);
    expect(findings.find((finding) => finding.figmaNodeId === "80:1")?.problem).toMatch(/no size/);
    const tokens = new Set(findings.flatMap((finding) => (finding.token ? [finding.token] : [])));
    expect([...tokens].sort()).toEqual([
      "Effect/Card shadow",
      "color/primary/600",
      "color/text/strong",
      "radius/8",
      "space/16",
    ]);
  });

  it("gives the clean Acme frame 0 errors", () => {
    const report = checkProperUse(index, "Paid screen");
    expect(report).toMatchObject({ errors: 0, warnings: 0, unknown: 0, exitCode: 0, findings: [], summary: "0 errors" });
    const card = verifyFrame(index, { frame: "Paid screen" });
    expect(card.pass).toBe(true);
    expect(verifyExitCode(card)).toBe(0);
    expect(card.properUse?.errors).toBe(0);
    expect(JSON.stringify(card).length).toBeLessThanOrEqual(600);
  });

  it("uses exit 7 only when the component check passed", () => {
    const misused = verifyFrame(index, { frame: "Misused" });
    expect(misused.pass).toBe(true);
    expect(misused.properUse?.exitCode).toBe(7);
    expect(misused.properUse?.summary).toMatch(/^2 detached/);
    expect(verifyExitCode(misused)).toBe(7);
    const shown = misused.properUse?.findings ?? [];
    const ranks = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < shown.length; i += 1) {
      expect(ranks[shown[i]!.severity]).toBeGreaterThanOrEqual(ranks[shown[i - 1]!.severity]);
    }
    expect(misused.properUse?.errors).toBe(5);
    expect(shown.filter((finding) => finding.severity === "error").map((finding) => finding.figmaNodeId)).toEqual([
      "80:11",
      "80:61",
      "80:31",
      "80:41",
      "80:51",
    ]);
    expect(misused.properUse?.truncated).toBe("+9 more. resolve check --all, or verify_frame all:true");
    const markdown = presentToolResult(misused, "markdown", "verify_frame");
    expect(markdown.startsWith("Components: PASS · Proper use: FAIL (5 errors, 7 warnings)")).toBe(true);
    const moreAt = markdown.indexOf("+9 more");
    expect(moreAt).toBeGreaterThan(markdown.indexOf("80:51"));
    expect(markdown.indexOf("80:51")).toBeGreaterThan(markdown.indexOf("80:11"));

    const bad = verifyFrame(index, { frame: "Bad props" });
    expect(bad.pass).toBe(false);
    expect(verifyExitCode(bad)).toBe(1);
    const props = checkProperUse(index, "Bad props");
    expect(props?.findings.map((finding) => finding.check).sort()).toEqual(["placeholder", "property"]);
    expect(props?.findings.find((finding) => finding.check === "property")?.problem).toMatch(/Huge/);
    expect(props?.findings.find((finding) => finding.check === "placeholder")?.problem).toMatch(/Button/);
  });

  it("drops the tap error at the 24px AA-minimum bar", () => {
    const report = checkProperUse(index, "Misused", { a11y: "wcag-aa-minimum" });
    expect(report?.level).toBe("wcag-aa-minimum");
    expect(report?.findings.some((finding) => finding.check === "tap")).toBe(false);
    expect(report?.findings.some((finding) => finding.check === "contrast")).toBe(true);
  });

  it("says unknown on a Figma MCP capture that has no bindings", () => {
    const mcp = graphOf("figma-mcp");
    const report = checkProperUse(mcp, "Misused");
    const checks = new Set(report?.findings.map((finding) => finding.check));
    expect(checks.has("colour")).toBe(false);
    expect(checks.has("spacing")).toBe(false);
    expect(checks.has("radius")).toBe(false);
    expect(checks.has("effect")).toBe(false);
    expect(checks.has("contrast")).toBe(false);
    expect(checks.has("detached")).toBe(true);
    expect(checks.has("unknown")).toBe(true);
    expect(report?.findings.find((finding) => finding.check === "unknown")?.problem).toMatch(/could not be checked/);
    expect(report?.findings.find((finding) => finding.check === "unknown")?.fix).toMatch(/boundVariables/);
  });

  it("prints a Proper use section on the check card", () => {
    const card = verifyFrame(index, { frame: "Paid screen" });
    const markdown = presentToolResult(card, "markdown", "verify_frame");
    expect(markdown.startsWith("Components: PASS · Proper use: PASS")).toBe(true);
    expect(markdown).toContain("Proper use: 0 errors");
    const json = JSON.parse(presentToolResult(card, "json", "verify_frame")) as { pass?: boolean; properUse?: { summary?: string } };
    expect(json.pass).toBe(true);
    expect(json.properUse?.summary).toBe("0 errors");
  });

  it("keeps a warnings-only line as PASS and lists every finding when all is set", () => {
    const noted = presentToolResult(
      {
        pass: true,
        properUse: { errors: 0, warnings: 2, unknown: 0, exitCode: 0, summary: "2 placeholders", level: "wcag-aa", findings: [] },
      },
      "markdown",
      "verify_frame",
    );
    expect(noted.startsWith("Components: PASS · Proper use: PASS (2 warnings)")).toBe(true);
    const schema = TOOLS.find((tool) => tool.name === "verify_frame")?.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("all");
    const full = verifyFrame(index, { frame: "Misused", all: true });
    expect(full.properUse?.findings).toHaveLength(14);
    expect(full.properUse?.truncated).toBeUndefined();
    expect(full.pass).toBe(true);
    expect(verifyExitCode(full)).toBe(7);
  });
});
