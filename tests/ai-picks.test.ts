import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runCli } from "@/server/cli";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph } from "@/core/query/GraphIndex";
import { packFromFiles, validateAiPick, type MeaningPack, type PickRequest } from "@/core/query/meaning/sock";
import { recommendMasters } from "@/core/query/recommendMasters";
import { aiPicksEnabled } from "@/server/pluginSettings";
import { loadPacks } from "../scripts/meaning-sock-build";

const FROZEN = "2026-01-01T00:00:00.000Z";
const MAIN_RECOMMEND =
  '{"intent":"switch","candidates":[{"id":"node:1","name":"Switch","type":"MAIN_COMPONENT","nodeId":"node:1","figmaNodeId":"node:1","fileKey":"ACMEUI","published":false,"publishState":"local-only","deprecated":false,"instances":0,"whereUsed":[],"score":1000000000,"why":"not verified on a screen yet","hint":"Place fileKey + nodeId."}],"truncated":false,"hint":"Place fileKey+nodeId. If stale, learn_library. Do not Read graph.json.","cost":{"chars":431,"approxTokens":108}}';

function node(id: string, type: NodeType, name: string, description = ""): GraphNode {
  return { id, type, name, description, figmaNodeId: id, isMainComponent: type === "MAIN_COMPONENT" };
}

function switchGraph(): DesignGraph {
  return {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      node("file:acme", "FILE", "Acme UI"),
      node("node:1", "MAIN_COMPONENT", "Switch", "Library switch control."),
      node("node:2", "MAIN_COMPONENT", "Button", "Sends a form."),
    ],
    edges: [],
  };
}

function packOf(id: string, markdown: string, library = "Acme"): MeaningPack {
  return packFromFiles(library, FROZEN, new Map([[id, markdown]]));
}

function ask(pack: MeaningPack, patch: Partial<PickRequest> = {}): PickRequest {
  return {
    library: pack.library,
    ask: "use this part",
    shortlist: [patch.pick ?? "button"],
    tier: "place",
    ...patch,
  };
}

describe("AI picks switch", () => {
  it("stays off unless RESOLVE_AI_PICKS is 1", () => {
    expect(aiPicksEnabled({})).toBe(false);
    expect(aiPicksEnabled({ RESOLVE_AI_PICKS: "0" })).toBe(false);
    expect(aiPicksEnabled({ RESOLVE_AI_PICKS: "true" })).toBe(false);
    expect(aiPicksEnabled({ RESOLVE_AI_PICKS: "1" })).toBe(true);
  });

  it("keeps recommend byte-identical to main when the switch is off", () => {
    const index = indexGraph(switchGraph());
    const previous = process.env["RESOLVE_AI_PICKS"];
    delete process.env["RESOLVE_AI_PICKS"];
    const off = JSON.stringify(recommendMasters(index, "switch"));
    process.env["RESOLVE_AI_PICKS"] = "0";
    const zero = JSON.stringify(recommendMasters(index, "switch"));
    process.env["RESOLVE_AI_PICKS"] = "1";
    const on = JSON.stringify(recommendMasters(index, "switch"));
    if (previous === undefined) delete process.env["RESOLVE_AI_PICKS"];
    else process.env["RESOLVE_AI_PICKS"] = previous;
    expect(off).toBe(MAIN_RECOMMEND);
    expect(zero).toBe(MAIN_RECOMMEND);
    expect(on).toBe(MAIN_RECOMMEND);
  });

  it("resolve pick says to use recommend and exits 0 when the switch is off", async () => {
    const previous = process.env["RESOLVE_AI_PICKS"];
    const previousCode = process.exitCode;
    delete process.env["RESOLVE_AI_PICKS"];
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["pick"]);
      expect(chunks.join("")).toBe("AI picks is off. Use recommend.\n");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.stdout.write = write;
      if (previous === undefined) delete process.env["RESOLVE_AI_PICKS"];
      else process.env["RESOLVE_AI_PICKS"] = previous;
      process.exitCode = previousCode;
    }
  });
});

describe("validateAiPick", () => {
  const material = readFileSync("meaning/material/button.md", "utf8");
  const acme = readFileSync("meaning/acme/button.md", "utf8");
  const retired = readFileSync("meaning/acme/legacy-alert.md", "utf8");

  it("places a quote the library owns and rejects a fabricated quote", () => {
    const pack = packOf("button", material, "Angular Material");
    const reason = material.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Angular Material buttons"));
    expect(reason).toBeTruthy();
    const original = globalThis.fetch;
    globalThis.fetch = function fetchBlocked(): Promise<Response> {
      throw new Error("network");
    };
    try {
      const placed = validateAiPick(pack, ask(pack, { pick: "button", reason, tier: "place" }));
      expect(placed.tier).toBe("place");
      expect(placed.id).toBe("button");
      expect(placed.reason).toBe(reason);
      expect(placed.failed).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
    const fabricated = validateAiPick(pack, ask(pack, { pick: "button", reason: "A button invented for this sentence.", tier: "place" }));
    expect(fabricated.tier).toBe("no-fit");
    expect(fabricated.id).toBeUndefined();
    expect(fabricated.failed).toContain("quote");
  });

  it("rejects an alias-only quote", () => {
    const pack = packOf("button", material, "Angular Material");
    const result = validateAiPick(pack, ask(pack, { pick: "button", reason: "btn", tier: "place" }));
    expect(result.tier).toBe("no-fit");
    expect(result.failed).toContain("alias-quote");
    expect(result.id).toBeUndefined();
  });

  it("accepts a quote that differs only by case and whitespace", () => {
    const pack = packOf("button", material, "Angular Material");
    const sentence = material.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Angular Material buttons"));
    expect(sentence && sentence.length).toBeGreaterThan(12);
    const reason = `  ${sentence?.toUpperCase()}  `.replace(/ /g, "  ");
    const result = validateAiPick(pack, ask(pack, { pick: "button", reason, tier: "place" }));
    expect(result.tier).toBe("place");
    expect(result.failed).toEqual([]);
  });

  it("caps a thin component at ask and lists the missing fields", () => {
    const pack = packOf("button", acme, "Acme");
    const result = validateAiPick(pack, ask(pack, { pick: "button", reason: "Button Style Primary", tier: "place" }));
    expect(result.tier).toBe("ask");
    expect(result.failed).toContain("thin-cap");
    expect(result.id).toBe("button");
    const row = result.thin.find((entry) => entry.id === "button");
    expect(row?.missing).toContain("description");
    expect(row?.missing.join(", ")).toMatch(/description/);
  });

  it("names a retired component and a missing one as no fit", () => {
    const pack = packFromFiles("Acme", FROZEN, new Map([["legacy-alert", retired], ["button", acme]]));
    const gone = validateAiPick(pack, ask(pack, { pick: "missing", reason: "Button", tier: "place" }));
    expect(gone.tier).toBe("no-fit");
    expect(gone.failed).toContain("exists");
    const old = validateAiPick(pack, ask(pack, { pick: "legacy-alert", shortlist: ["legacy-alert"], reason: "Legacy Alert", tier: "place" }));
    expect(old.tier).toBe("no-fit");
    expect(old.failed).toContain("retired");
    expect(old.id).toBeUndefined();
  });

  it("rejects a bare name, a short quote, an alias, a cross-line quote, and a pick outside the shortlist", () => {
    const pack = packOf("button", material, "Angular Material");
    const bare = validateAiPick(pack, ask(pack, { pick: "button", reason: "Button", tier: "place" }));
    expect(bare.tier).toBe("no-fit");
    expect(bare.failed).toContain("quote");
    const punct = validateAiPick(pack, ask(pack, { pick: "button", reason: ".", tier: "place" }));
    expect(punct.failed).toContain("quote");
    const crossed = validateAiPick(pack, ask(pack, { pick: "button", reason: "Angular Material buttons\nare native", tier: "place" }));
    expect(crossed.failed).toContain("quote");
    const joined = validateAiPick(pack, ask(pack, { pick: "button", reason: "styling. Five button types", tier: "place" }));
    expect(joined.failed).toContain("quote");
    const outside = validateAiPick(pack, ask(pack, { pick: "button", shortlist: ["other"], reason: material.split("\n").find((line) => line.startsWith("Angular Material buttons")), tier: "place" }));
    expect(outside.failed).toContain("shortlist");
    const empty = validateAiPick(pack, ask(pack, { pick: "button", shortlist: [], tier: "place" }));
    expect(empty.failed).toContain("shortlist");
    const duplicated = validateAiPick(pack, ask(pack, { pick: "button", shortlist: ["button", "button", "button"], reason: material.split("\n").find((line) => line.startsWith("Angular Material buttons")), tier: "place" }));
    expect(duplicated.failed).toContain("shortlist");
  });

  it("accepts a whole short line, a name with no description, and an exact property, and rejects the rest", () => {
    const sidenav = packOf("sidenav", readFileSync("meaning/material/sidenav.md", "utf8"), "Library");
    const drawer = validateAiPick(sidenav, ask(sidenav, { pick: "sidenav", shortlist: ["sidenav"], reason: "Navigation drawer.", tier: "place" }));
    expect(drawer.tier).toBe("place");
    expect(drawer.failed).toEqual([]);
    expect(drawer.nameOnly).toBeUndefined();
    const table = packOf("table", readFileSync("meaning/material/table.md", "utf8"), "Library");
    const data = validateAiPick(table, ask(table, { pick: "table", shortlist: ["table"], reason: "Data table.", tier: "place" }));
    expect(data.tier).toBe("ask");
    expect(data.failed).toContain("thin-cap");
    const tabs = packOf("tabs", readFileSync("meaning/material/tabs.md", "utf8"), "Library");
    const named = validateAiPick(tabs, ask(tabs, { pick: "tabs", shortlist: ["tabs"], reason: "Tabs.", tier: "place" }));
    expect(named.failed).toContain("quote");
    const sw = packOf("switch", readFileSync("meaning/acme/switch.md", "utf8"), "Acme");
    const only = validateAiPick(sw, ask(sw, { pick: "switch", shortlist: ["switch"], reason: "Switch", tier: "place" }));
    expect(only.tier).toBe("ask");
    expect(only.nameOnly).toBe(true);
    expect(only.failed).toContain("thin-cap");
    const alias = validateAiPick(sw, ask(sw, { pick: "switch", shortlist: ["switch"], reason: "toggle", tier: "ask" }));
    expect(alias.failed).toContain("alias-quote");
    const acmeButton = packOf("button", readFileSync("meaning/acme/button.md", "utf8"), "Acme");
    for (const reason of ["buttonstyledanger", "primary styled buttons everywhere", "Button Style Purple", "Button Size Large"]) {
      const result = validateAiPick(acmeButton, ask(acmeButton, { pick: "button", reason, tier: "ask" }));
      expect(result.failed, reason).toContain("quote");
    }
    const crossed = `# Acme / Note\nA button. Single or grouped controls.\n`;
    const crossPack = packOf("note", crossed, "Acme");
    expect(validateAiPick(crossPack, ask(crossPack, { pick: "note", shortlist: ["note"], reason: "button. Single or", tier: "place" })).failed).toContain("quote");
    expect(validateAiPick(crossPack, ask(crossPack, { pick: "note", shortlist: ["note"], reason: "Single or grouped controls.", tier: "place" })).tier).toBe("place");
    const generic = `# Acme / Note\nThe control is displayed when the form is open.\nSee https://example.com/controls for placement.\n`;
    const genericPack = packOf("note", generic, "Acme");
    expect(validateAiPick(genericPack, ask(genericPack, { pick: "note", shortlist: ["note"], reason: "is displayed when", tier: "place" })).failed).toContain("quote");
    expect(validateAiPick(genericPack, ask(genericPack, { pick: "note", shortlist: ["note"], reason: "https://example.com/controls", tier: "place" })).failed).toContain("quote");
    expect(validateAiPick(genericPack, ask(genericPack, { pick: "note", shortlist: ["note"], reason: "example.com/controls", tier: "place" })).failed).toContain("quote");
    expect(validateAiPick(genericPack, ask(genericPack, { pick: "note", shortlist: ["note"], reason: "when the form is open", tier: "place" })).tier).toBe("place");
  });

  it("treats a deprecated description as retired, and a status line as retired", () => {
    const described = `# Acme / Banner\nThis part is deprecated. Replaced by Button for new screens.\n[banner](index.md)\n`;
    const describedPack = packOf("banner", described, "Acme");
    const fromText = validateAiPick(describedPack, ask(describedPack, { pick: "banner", shortlist: ["banner"], reason: "This part is deprecated. Replaced by Button for new screens.", tier: "place" }));
    expect(fromText.failed).toContain("retired");
    expect(fromText.tier).toBe("no-fit");
    const status = `# Acme / Legacy Alert\nstatus: deprecated\n[legacy-alert](index.md)\n`;
    const statusPack = packOf("legacy-alert", status, "Acme");
    const fromStatus = validateAiPick(statusPack, ask(statusPack, { pick: "legacy-alert", shortlist: ["legacy-alert"], reason: "status deprecated line", tier: "place" }));
    expect(fromStatus.failed).toContain("retired");
  });

  it("rejects an unknown prop and an unknown tier", () => {
    const pack = packOf("button", material, "Angular Material");
    const reason = "Button";
    const props = validateAiPick(pack, ask(pack, { pick: "button", reason, props: { Mood: "sunny" }, tier: "place" }));
    expect(props.failed).toContain("props");
    expect(props.tier).toBe("no-fit");
    const tier = validateAiPick(pack, ask(pack, { pick: "button", reason, tier: "sure" }));
    expect(tier.failed).toContain("tier");
    expect(tier.tier).toBe("no-fit");
  });

  it("warns when the library is newer than the meaning files", () => {
    const pack = packOf("button", material, "Angular Material");
    const result = validateAiPick(pack, ask(pack, { pick: "button", reason: "Button", tier: "ask" }), "2026-02-01T00:00:00.000Z");
    expect(result.stale).toMatch(/older than the library/);
  });

  it("lists only real thin components, and refuses to place a stripped one", () => {
    const packs = loadPacks();
    const materialPack = packs.material;
    const listed = validateAiPick(materialPack, { library: "material", ask: "nothing", shortlist: [], tier: "no-fit" });
    expect(listed.tier).toBe("no-fit");
    expect(listed.id).toBeUndefined();
    for (const entry of listed.thin) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.missing.length).toBeGreaterThan(0);
      expect(materialPack.components.find((component) => component.id === entry.id)?.thin).toEqual(entry.missing);
    }
    expect(listed.thin.map((entry) => entry.id)).toContain("icon");
    expect(listed.thin.map((entry) => entry.id)).not.toContain("button");
    const acmeList = validateAiPick(packs.acme, { library: "acme", ask: "nothing", shortlist: [], tier: "no-fit" });
    const smallList = validateAiPick(packs["acme-small"], { library: "acme-small", ask: "nothing", shortlist: [], tier: "no-fit" });
    expect(acmeList.thin).toHaveLength(37);
    expect(smallList.thin).toHaveLength(17);
    const strip = ["button", "card", "checkbox", "chip", "dialog"];
    const thinSet: MeaningPack = {
      ...materialPack,
      components: materialPack.components.map((component) =>
        strip.includes(component.id) ? { ...component, description: "", job: "", thin: ["description", "guidelines"] } : component,
      ),
    };
    const button = thinSet.components.find((component) => component.id === "button");
    const propName = Object.keys(button?.propOptions ?? {})[0] ?? "";
    const propValue = button?.propOptions[propName]?.[0] ?? "";
    const placed = validateAiPick(thinSet, { library: "material", ask: "a button", shortlist: ["button"], pick: "button", reason: `${button?.name} ${propName} ${propValue}`, tier: "place" });
    expect(placed.tier).not.toBe("place");
    expect(placed.failed).toContain("thin-cap");
    for (const id of strip) {
      const entry = placed.thin.find((row) => row.id === id);
      expect(entry?.missing).toEqual(["description", "guidelines"]);
    }
  }, 30_000);

  it("marks a name-only pick name-only in its thin entry, and only that entry", () => {
    const stripped = readFileSync("meaning/material/table.md", "utf8").replace("Data table.\n", "");
    const pack = packFromFiles("Library", FROZEN, new Map([["table", stripped], ["icon", readFileSync("meaning/material/icon.md", "utf8")]]));
    const table = pack.components.find((component) => component.id === "table");
    expect(table?.description).toBe("");
    expect(table?.propOptions).toEqual({});
    const named = validateAiPick(pack, ask(pack, { pick: "table", shortlist: ["table"], reason: "Table", tier: "ask" }));
    expect(named.tier).toBe("ask");
    expect(named.failed).toEqual([]);
    expect(named.nameOnly).toBe(true);
    expect(named.thin.find((entry) => entry.id === "table")).toEqual({ id: "table", missing: ["description", "guidelines"], nameOnly: true });
    expect(named.thin.find((entry) => entry.id === "icon")?.nameOnly).toBeUndefined();
    const quoted = validateAiPick(pack, ask(pack, { pick: "icon", shortlist: ["icon"], reason: "Icon glyph.", tier: "ask" }));
    expect(quoted.nameOnly).toBeUndefined();
    expect(quoted.thin.every((entry) => entry.nameOnly === undefined)).toBe(true);
  });

  it("stays under 300ms at p95 on a 200-component library", () => {
    const components = Array.from({ length: 200 }, (_, index) => ({
      id: `part-${index}`,
      name: `Part ${index}`,
      aliases: ["alias"],
      description: `Part ${index} holds a short library description of a control.`,
      job: "",
      properties: ["Size: Small, Large"],
      propOptions: { size: ["Small", "Large"] },
      retired: false,
      thin: [] as string[],
    }));
    const pack: MeaningPack = { library: "Bench", vocab: "", builtAt: FROZEN, components };
    const request = ask(pack, { pick: "part-10", shortlist: ["part-10"], reason: "Part 10 holds a short library description of a control.", props: { Size: "Small" }, tier: "place" });
    for (let warm = 0; warm < 5; warm += 1) validateAiPick(pack, request);
    const samples: number[] = [];
    for (let sample = 0; sample < 40; sample += 1) {
      const start = performance.now();
      const result = validateAiPick(pack, request);
      samples.push(performance.now() - start);
      expect(result.tier).toBe("place");
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 999;
    expect(p95).toBeLessThan(300);
  });
});

describe("resolve pick command", () => {
  it("checks a file when the switch is on", async () => {
    const previous = process.env["RESOLVE_AI_PICKS"];
    const previousCode = process.exitCode;
    process.env["RESOLVE_AI_PICKS"] = "1";
    const dir = mkdtempSync(join(tmpdir(), "ai-pick-"));
    const request = join(dir, "pick.json");
    writeFileSync(request, JSON.stringify({
      library: "material",
      ask: "a button",
      shortlist: ["button"],
      pick: "button",
      reason: "not a library sentence",
      tier: "place",
    }));
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["pick", request]);
      const result = JSON.parse(chunks.join("")) as { tier: string; failed: string[] };
      expect(result.tier).toBe("no-fit");
      expect(result.failed).toContain("quote");
      expect(process.exitCode).toBe(1);
      chunks.length = 0;
      writeFileSync(request, JSON.stringify({
        library: "material",
        ask: "a button",
        shortlist: ["button"],
        pick: "button",
        props: { color: 1, disabled: true },
        reason: "not a library sentence",
        tier: "place",
      }));
      await runCli(["pick", request]);
      const badProps = JSON.parse(chunks.join("")) as { tier: string; failed: string[] };
      expect(badProps.tier).toBe("no-fit");
      expect(badProps.failed).toContain("props");
      chunks.length = 0;
      writeFileSync(request, JSON.stringify({
        library: "acme",
        ask: "a button",
        shortlist: ["button"],
        pick: "button",
        reason: "Button Style Primary",
        tier: "place",
      }));
      await runCli(["pick", request]);
      const asked = JSON.parse(chunks.join("")) as { tier: string; failed: string[] };
      expect(asked.tier).toBe("ask");
      expect(asked.failed).toContain("thin-cap");
      expect(process.exitCode).toBe(0);
      chunks.length = 0;
      writeFileSync(request, JSON.stringify({
        library: "missing-library",
        ask: "a button",
        shortlist: ["button"],
        pick: "button",
        reason: "Button Style Primary",
        tier: "ask",
      }));
      await runCli(["pick", request]);
      expect(chunks.join("")).toContain("needs a repo checkout for now");
      chunks.length = 0;
      writeFileSync(request, JSON.stringify({
        library: "acme",
        ask: "a button",
        shortlist: ["button"],
        pick: "button",
        reason: "Button Style Primary",
        tier: "place",
      }));
      await runCli(["pick", "--library-built-at", "2026-02-01T00:00:00.000Z", request]);
      const datedFirst = JSON.parse(chunks.join("")) as { stale?: string; tier: string };
      expect(datedFirst.tier).toBe("ask");
      expect(datedFirst.stale).toMatch(/older than the library/);
      chunks.length = 0;
      await runCli(["pick", request, "--library-built-at", "2026-02-01T00:00:00.000Z"]);
      const fileFirst = JSON.parse(chunks.join("")) as { stale?: string };
      expect(fileFirst.stale).toMatch(/older than the library/);
    } finally {
      process.stdout.write = write;
      if (previous === undefined) delete process.env["RESOLVE_AI_PICKS"];
      else process.env["RESOLVE_AI_PICKS"] = previous;
      process.exitCode = previousCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolve CLI errors", () => {
  it("hides the store path when check runs on an empty home", () => {
    const cli = join(process.cwd(), "dist-server/cli.mjs");
    const home = mkdtempSync(join(tmpdir(), "resolve-empty-"));
    const result = spawnSync(process.execPath, [cli, "check", "missing-frame"], {
      encoding: "utf8",
      env: { ...process.env, RESOLVE_HOME: home },
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("Resolve has not learned a design system yet");
    expect(output).not.toContain("RESOLVE_HOME");
    expect(output).not.toContain("graph.json");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("resolve pick timing", () => {
  it("stays under 300ms at p95 end to end on a 200-component library", () => {
    const cli = join(process.cwd(), "dist-server/cli.mjs");
    const root = mkdtempSync(join(tmpdir(), "ai-pick-bench-"));
    const lib = join(root, "meaning", "bench");
    mkdirSync(lib, { recursive: true });
    const index = ["# Bench", "built: 2026-01-01T00:00:00.000Z"];
    for (let i = 0; i < 200; i += 1) {
      const id = `part-${i}`;
      index.push(`- [${id}](${id}.md) — Part ${i}`);
      writeFileSync(join(lib, `${id}.md`), `# Bench / Part ${i}\nPart ${i} holds a library description of a control.\n[part-${i}](index.md)\n`);
    }
    writeFileSync(join(lib, "index.md"), `${index.join("\n")}\n`);
    const request = join(root, "request.json");
    writeFileSync(request, JSON.stringify({
      library: "bench",
      ask: "a control",
      shortlist: ["part-10"],
      pick: "part-10",
      reason: "Part 10 holds a library description of a control.",
      tier: "place",
    }));
    const samples: number[] = [];
    let bad = 0;
    for (let i = 0; i < 5; i += 1) spawnSync(process.execPath, [cli, "pick", request], { cwd: root, encoding: "utf8", env: { ...process.env, RESOLVE_AI_PICKS: "1" } });
    for (let i = 0; i < 20; i += 1) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [cli, "pick", request], { cwd: root, encoding: "utf8", env: { ...process.env, RESOLVE_AI_PICKS: "1" } });
      samples.push(performance.now() - start);
      const body = JSON.parse((result.stdout ?? "").trim() || "{\"tier\":\"\"}") as { tier: string };
      if (result.status !== 0 || body.tier !== "place") bad += 1;
    }
    rmSync(root, { recursive: true, force: true });
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 999;
    expect(bad).toBe(0);
    expect(p95).toBeLessThan(300);
  });
});
