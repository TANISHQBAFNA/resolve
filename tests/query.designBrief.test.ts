import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRIEF_EXIT, checkBrief, checkHandoffPack, inventoryTable, parseFrontmatter } from "@/core/query/designBrief";

const EXAMPLE = readFileSync("examples/design-brief/acme-approval/brief.md", "utf8");
const TEMPLATE = readFileSync("templates/design-brief/brief.md", "utf8");

const types = (markdown: string) => checkBrief(markdown).issues.map((issue) => issue.type);

describe("design brief check", () => {
  it("passes the worked Acme example", () => {
    const report = checkBrief(EXAMPLE);
    expect(report.issues).toEqual([]);
    expect(report).toMatchObject({ ok: true, exitCode: 0, input: "brief" });
  });

  it("fails the unfilled template, so it cannot pass as written", () => {
    const report = checkBrief(TEMPLATE);
    expect(report.ok).toBe(false);
    expect(new Set(report.issues.map((issue) => issue.type))).toEqual(new Set(["frontmatter", "screens", "fields", "status"]));
  });

  it("reads frontmatter lists, quotes and comments", () => {
    const parsed = parseFrontmatter('---\nticket: "T-1" # id\njourney:\n  - journey-a-b\n  - journey-c-d\nproduct: [x, y]\n---\nbody');
    expect(parsed?.data).toEqual({ ticket: "T-1", journey: ["journey-a-b", "journey-c-d"], product: ["x", "y"] });
    expect(parsed?.body).toBe("body");
    expect(parseFrontmatter("# no frontmatter")).toBeUndefined();
  });

  it("fails when frontmatter is missing, and says which key", () => {
    expect(checkBrief("# A brief with no frontmatter").exitCode).toBe(BRIEF_EXIT.frontmatter);
    const report = checkBrief(EXAMPLE.replace(/^ticket: .*\n/m, ""));
    expect(report.exitCode).toBe(BRIEF_EXIT.frontmatter);
    expect(report.issues.map((issue) => issue.where)).toEqual(["ticket"]);
  });

  it("fails a journey id that is not journey-<verb>-<noun>, and a bad ui_scope or status", () => {
    expect(checkBrief(EXAMPLE.replace("journey-approve-payment]", "approve]")).issues[0]?.message).toMatch(/journey-<verb>-<noun>/);
    expect(types(EXAMPLE.replace("ui_scope: true", "ui_scope: maybe"))).toContain("frontmatter");
    expect(types(EXAMPLE.replace("status: complete", "status: done"))).toEqual(["frontmatter"]);
  });

  it("fails an empty screen-state cell", () => {
    const report = checkBrief(EXAMPLE.replace("| Pending approvals | loading | Table skeleton with the column headers visible. |", "| Pending approvals | loading |  |"));
    expect(report.exitCode).toBe(BRIEF_EXIT.screens);
    expect(report.issues[0]?.where).toMatch(/Pending approvals \/ loading/);
  });

  it("fails N/A without a reason, and accepts N/A with one", () => {
    const bare = EXAMPLE.replace("N/A — the list has no submit action, so there is nothing to confirm.", "N/A");
    expect(checkBrief(bare).exitCode).toBe(BRIEF_EXIT.screens);
    expect(checkBrief(bare).issues[0]?.message).toMatch(/no reason/);
    const dash = EXAMPLE.replace("N/A — the list has no submit action, so there is nothing to confirm.", "N/A — none");
    expect(checkBrief(dash).issues).toEqual([]);
    expect(checkBrief(EXAMPLE.replace("N/A — the list has no submit action, so there is nothing to confirm.", "N/A —")).exitCode).toBe(BRIEF_EXIT.screens);
  });

  it("fails a screen that is missing a state row", () => {
    const report = checkBrief(EXAMPLE.replace(/^\| Review payment \| loading \|.*\n/m, ""));
    expect(report.exitCode).toBe(BRIEF_EXIT.screens);
    expect(report.issues[0]).toMatchObject({ where: "Screen inventory: review payment" });
    expect(report.issues[0]?.message).toMatch(/loading/);
  });

  it("fails a field with no source, and a field with no or unknown provenance", () => {
    const noSource = checkBrief(EXAMPLE.replace("| payments.payee_name |", "|  |"));
    expect(noSource.exitCode).toBe(BRIEF_EXIT.fields);
    expect(noSource.issues[0]?.message).toMatch(/No source/);
    const noProvenance = checkBrief(EXAMPLE.replace("| Up to 15 digits | contract |", "| Up to 15 digits |  |"));
    expect(noProvenance.exitCode).toBe(BRIEF_EXIT.fields);
    expect(noProvenance.issues[0]?.message).toMatch(/Provenance is empty/);
    const unknown = checkBrief(EXAMPLE.replace("| Up to 15 digits | contract |", "| Up to 15 digits | guessed |"));
    expect(unknown.issues[0]?.message).toMatch(/guessed/);
  });

  it("fails an unanswered open question only when status is complete", () => {
    const open = EXAMPLE.replace("| No. The Approve button is disabled with the message \"Above your limit\" and the payment goes to the next checker. |", "|  |");
    const report = checkBrief(open);
    expect(report.exitCode).toBe(BRIEF_EXIT.questions);
    expect(report.issues[0]?.message).toMatch(/^Unanswered: Can a checker/);
    expect(types(open.replace("status: complete", "status: draft"))).toEqual(["status"]);
  });

  it("fails status draft, because a ticket is ready for planning only with a complete brief", () => {
    const report = checkBrief(EXAMPLE.replace("status: complete", "status: draft"));
    expect(report).toMatchObject({ ok: false, exitCode: BRIEF_EXIT.status });
  });

  it("uses the lowest code when several types fail, and lists them all", () => {
    const broken = EXAMPLE.replace(/^ticket: .*\n/m, "").replace("| payments.payee_name |", "|  |");
    const report = checkBrief(broken);
    expect(new Set(report.issues.map((issue) => issue.type))).toEqual(new Set(["frontmatter", "fields"]));
    expect(report.exitCode).toBe(BRIEF_EXIT.frontmatter);
  });

  it("gives every failure type its own non-zero code", () => {
    const codes = Object.values(BRIEF_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => code > 1)).toBe(true);
  });

  it("passes a backend-only ticket", () => {
    const report = checkBrief("---\nticket: T-2\nproduct: Acme Pay\njourney: journey-sync-ledger\nui_scope: false\nrequirements_source: r.md\nstatus: draft\n---\n# Ledger sync\n");
    expect(report).toMatchObject({ ok: true, exitCode: 0 });
    expect(report.note).toMatch(/backend only/);
  });

  it("hands the screen rows to resolve spec without N/A rows", () => {
    const table = inventoryTable(EXAMPLE);
    expect(table.split("\n")[0]).toMatch(/^\| Screen \| State/);
    expect(table).toContain("A table of payments waiting for this checker");
    expect(table).not.toMatch(/N\/A/);
    expect(inventoryTable("# nothing")).toBe("");
  });
});

describe("handoff pack check", () => {
  const pass = { ok: true, draft: false, screens: [{ name: "Confirm payment", verify: { pass: true } }] };

  it("passes a non-draft handoff where verify passed", () => {
    expect(checkHandoffPack(pass)).toMatchObject({ ok: true, exitCode: 0, input: "handoff" });
  });

  it("fails a draft, a refused handoff, no screens, and a screen where verify failed", () => {
    expect(checkHandoffPack({ ...pass, draft: true })).toMatchObject({ ok: false, exitCode: BRIEF_EXIT.handoff });
    expect(checkHandoffPack({ ok: false, draft: false, refused: [] }).exitCode).toBe(BRIEF_EXIT.handoff);
    expect(checkHandoffPack({ ...pass, screens: [] }).exitCode).toBe(BRIEF_EXIT.handoff);
    const failed = checkHandoffPack({ ...pass, screens: [{ name: "Confirm payment", verify: { pass: false } }] });
    expect(failed.exitCode).toBe(BRIEF_EXIT.handoff);
    expect(failed.issues[0]?.where).toBe("screen Confirm payment");
    expect(checkHandoffPack("not a pack").exitCode).toBe(BRIEF_EXIT.handoff);
  });
});
