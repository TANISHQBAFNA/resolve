import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { overlayFile, pinnedHome } from "@/core/query/overlayFile";
import { scoreboardHistoryDir } from "@/server/scoreboardView";
import { clearCache, discoverStoreRoot, missingGraphMessage, storeInfo, storeRoot } from "@/server/store";

// RESOLVE_HOME is the name. GRAPHIFY_HOME is the older name and still works, silently. RESOLVE_HOME wins.
describe("RESOLVE_HOME", () => {
  const keep = { resolve: process.env["RESOLVE_HOME"], graphify: process.env["GRAPHIFY_HOME"] };
  let a: string;
  let b: string;
  const set = (name: string, value?: string) => (value === undefined ? delete process.env[name] : (process.env[name] = value));

  beforeEach(() => {
    a = mkdtempSync(join(tmpdir(), "resolve-home-a-"));
    b = mkdtempSync(join(tmpdir(), "resolve-home-b-"));
    set("RESOLVE_HOME");
    set("GRAPHIFY_HOME");
    clearCache();
  });
  afterEach(() => {
    set("RESOLVE_HOME", keep.resolve);
    set("GRAPHIFY_HOME", keep.graphify);
    clearCache();
  });

  it("names the store folder: primary, fallback, precedence, blank values", () => {
    expect(discoverStoreRoot(b, { RESOLVE_HOME: a })).toBe(resolve(a));
    expect(discoverStoreRoot(b, { GRAPHIFY_HOME: a })).toBe(resolve(a));
    expect(discoverStoreRoot(b, { RESOLVE_HOME: a, GRAPHIFY_HOME: b })).toBe(resolve(a));
    expect(discoverStoreRoot(b, { RESOLVE_HOME: "  ", GRAPHIFY_HOME: a })).toBe(resolve(a));
    expect(pinnedHome({ RESOLVE_HOME: "", GRAPHIFY_HOME: "" })).toBeUndefined();
    expect(pinnedHome({})).toBeUndefined();
  });

  it("scoreboard history follows the same rule", () => {
    expect(scoreboardHistoryDir("x", { RESOLVE_HOME: a })).toBe(join(resolve(a), "scoreboard"));
    expect(scoreboardHistoryDir("x", { GRAPHIFY_HOME: a })).toBe(join(resolve(a), "scoreboard"));
    expect(scoreboardHistoryDir("x", { RESOLVE_HOME: a, GRAPHIFY_HOME: b })).toBe(join(resolve(a), "scoreboard"));
  });

  it("team files (synonyms, code map) sit in the pinned folder under either name", () => {
    set("GRAPHIFY_HOME", b);
    expect(overlayFile("code-map.json")).toBe(join(resolve(b), "code-map.json"));
    set("RESOLVE_HOME", a);
    expect(overlayFile("code-map.json")).toBe(join(resolve(a), "code-map.json"));
  });

  it("the old project folder is still read; the new folder wins; nothing is moved or deleted", () => {
    const project = mkdtempSync(join(tmpdir(), "resolve-home-proj-"));
    const old = join(project, ".graphify");
    mkdirSync(old);
    writeFileSync(join(old, "workspace.json"), "{}");
    writeFileSync(join(old, "synonyms.json"), '{"old":true}');
    writeFileSync(join(old, "code-map.json"), '{"old":true}');
    const inside = join(project, "src");
    mkdirSync(inside);
    const proc = process.cwd();
    process.chdir(inside);
    try {
      expect(discoverStoreRoot(inside, {})).toBe(old);
      expect(overlayFile("synonyms.json")).toBe(join(old, "synonyms.json"));
      const fresh = join(project, ".resolve");
      mkdirSync(fresh);
      writeFileSync(join(fresh, "workspace.json"), "{}");
      writeFileSync(join(fresh, "synonyms.json"), '{"new":true}');
      expect(discoverStoreRoot(inside, {})).toBe(fresh);
      expect(overlayFile("synonyms.json")).toBe(join(fresh, "synonyms.json"));
      expect(overlayFile("code-map.json")).toBe(join(old, "code-map.json"));
      expect(existsSync(join(old, "synonyms.json")) && readFileSync(join(old, "synonyms.json"), "utf8")).toBe('{"old":true}');
    } finally {
      process.chdir(proc);
    }
  });

  it("where / no-graph message say RESOLVE_HOME, whichever name was set", () => {
    set("GRAPHIFY_HOME", b);
    expect(storeRoot()).toBe(resolve(b));
    expect(missingGraphMessage()).toContain(`RESOLVE_HOME=${b}`);
    expect(missingGraphMessage()).not.toContain("GRAPHIFY");
    set("RESOLVE_HOME", a);
    expect(storeInfo()).toMatchObject({ path: resolve(a), resolveHome: a });
    expect(storeInfo()).not.toHaveProperty("graphifyHome");
    expect(missingGraphMessage()).toContain(`RESOLVE_HOME=${a}`);
    set("RESOLVE_HOME");
    set("GRAPHIFY_HOME");
    clearCache();
    expect(missingGraphMessage()).toContain("Set RESOLVE_HOME to pin a folder.");
  });
});
