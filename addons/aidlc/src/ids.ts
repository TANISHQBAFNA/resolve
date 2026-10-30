import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HandoffPack } from "@/public";

/**
 * Versioned component ids: `<prefix>@<major>.<minor>[.<patch>].<tier>.<name>`, for example `ds@1.2.ingredients.button`.
 * Figma and code join on `<tier>.<name>` when the prefix matches, never on the whole string, and the two versions are compared.
 * Advisory only. A report never blocks a handoff or an export, and never changes an exit code.
 */

export const ID_TIERS = ["base", "ingredients", "recipes"] as const;
export type IdTier = (typeof ID_TIERS)[number];
export const DEFAULT_ID_PREFIX = "ds";
export const IDS_CONFIG_FILE = "aidlc.json";

export interface ComponentId {
  raw: string;
  prefix: string;
  version: { major: number; minor: number; patch?: number };
  /** The version as written: `1.2` or `1.2.1`. */
  versionText: string;
  tier: IdTier;
  name: string;
  /** `<tier>.<name>`: the join key. */
  key: string;
}

export type ParsedId = { ok: true; id: ComponentId } | { ok: false; raw: string; error: string };

const PREFIX = /^[a-z][a-z0-9-]*$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUMBER = /^(?:0|[1-9]\d*)$/;
const FORMAT = "Use <prefix>@<major>.<minor>[.<patch>].<base|ingredients|recipes>.<kebab-name>, for example ds@1.2.ingredients.button.";

export function parseComponentId(raw: string): ParsedId {
  const text = raw.trim();
  const fail = (why: string): ParsedId => ({ ok: false, raw: text, error: `"${text}" is not a component id: ${why}. ${FORMAT}` });
  const at = text.indexOf("@");
  if (at <= 0) return fail("it needs a prefix and @ at the start");
  const prefix = text.slice(0, at);
  if (!PREFIX.test(prefix)) return fail(`the prefix "${prefix}" must be lowercase letters, digits or hyphens, starting with a letter`);
  const parts = text.slice(at + 1).split(".");
  let count = 0;
  while (count < parts.length && /^\d+$/.test(parts[count]!)) count += 1;
  if (count < 2 || count > 3) return fail("the version must be major.minor or major.minor.patch");
  const numbers = parts.slice(0, count);
  if (numbers.some((part) => !NUMBER.test(part))) return fail("a version number cannot start with 0 unless it is 0");
  const rest = parts.slice(count);
  if (rest.length < 2) return fail("it needs a tier and a name after the version");
  if (rest.length > 2) return fail(`the name "${rest.slice(1).join(".")}" cannot contain dots`);
  const [tierText, name] = rest as [string, string];
  const tier = tierText === "recipe" ? "recipes" : tierText;
  if (!(ID_TIERS as readonly string[]).includes(tier)) return fail(`the tier "${tierText}" must be base, ingredients or recipes`);
  if (!NAME.test(name)) return fail(`the name "${name}" must be kebab-case: lowercase words joined by hyphens`);
  const [major, minor, patch] = numbers.map(Number) as [number, number, number | undefined];
  return {
    ok: true,
    id: { raw: text, prefix, version: { major, minor, ...(patch !== undefined ? { patch } : {}) }, versionText: numbers.join("."), tier: tier as IdTier, name, key: `${tier}.${name}` },
  };
}

/** Anything in free text that is written like an id (`word@digit…`). An e-mail address or `'@scope/pkg'` is not. */
const CANDIDATE = /(?<![\w@./-])[A-Za-z][A-Za-z0-9_-]*@\d[^\s'"`(),;<>[\]{}]*/g;

export function idsInText(text: string): ParsedId[] {
  return [...text.matchAll(CANDIDATE)].map((match) => parseComponentId(match[0].replace(/[.:!?]+$/, "")));
}

export type IdChange = "same" | "patch" | "minor" | "major";

/** Which part of the version differs, and whether code is behind or ahead of Figma. A missing patch counts as 0. */
export function compareVersions(figma: ComponentId["version"], code: ComponentId["version"]): { change: IdChange; direction: "same" | "behind" | "ahead" } {
  const a = [figma.major, figma.minor, figma.patch ?? 0];
  const b = [code.major, code.minor, code.patch ?? 0];
  const at = a.findIndex((value, i) => value !== b[i]);
  if (at < 0) return { change: "same", direction: "same" };
  return { change: (["major", "minor", "patch"] as const)[at]!, direction: b[at]! < a[at]! ? "behind" : "ahead" };
}

const MEANING: Record<Exclude<IdChange, "same">, string> = {
  patch: "a small visual tweak such as padding or radius",
  minor: "a design change or a new variant or property",
  major: "a breaking change: a removed variant, a renamed property or changed behaviour",
};

export interface IdDrift {
  key: string;
  figma: string;
  code: string;
  change: IdChange;
  direction: "same" | "behind" | "ahead";
  /** ok: same. info: patch behind, or code ahead. warning: minor or major behind (major is the strongest wording). Never an error. */
  level: "ok" | "info" | "warning";
  message: string;
  figmaFrom: string[];
  codeFrom: string[];
}

function driftOf(key: string, figma: ComponentId, code: ComponentId, figmaFrom: string[], codeFrom: string[]): IdDrift {
  const { change, direction } = compareVersions(figma.version, code.version);
  const base = { key, figma: figma.raw, code: code.raw, change, direction, figmaFrom, codeFrom };
  if (change === "same") return { ...base, level: "ok", message: `Same version (${figma.versionText}).` };
  if (direction === "ahead") {
    return { ...base, level: "info", message: `Code ${code.versionText} is ahead of Figma ${figma.versionText} by ${change}. Check that Figma has the change too.` };
  }
  if (change === "patch") return { ...base, level: "info", message: `Code ${code.versionText} is a patch behind Figma ${figma.versionText}: ${MEANING.patch}.` };
  if (change === "minor") return { ...base, level: "warning", message: `Code ${code.versionText} is a minor version behind Figma ${figma.versionText}: ${MEANING.minor}. Update the coded component before you build with it.` };
  return {
    ...base,
    level: "warning",
    message: `MAJOR: code ${code.versionText} is a major version behind Figma ${figma.versionText}: ${MEANING.major}. Do not map this part to the old code without checking with the design system team.`,
  };
}

export interface IdSighting {
  side: "figma" | "code";
  text: string;
  from: string;
}

export interface IdsReport {
  kind: "resolve.aidlc.ids";
  schemaVersion: 1;
  prefix: string;
  /** Always false. Ids are a guide for mapping components; they never block a handoff. */
  blocks: false;
  summary: { pairs: number; same: number; patch: number; minor: number; major: number; ahead: number; figmaOnly: number; codeOnly: number; otherPrefix: number; problems: number };
  pairs: IdDrift[];
  figmaOnly: Array<{ id: string; from: string[] }>;
  codeOnly: Array<{ id: string; from: string[] }>;
  otherPrefix: Array<{ id: string; side: "figma" | "code"; from: string[] }>;
  problems: string[];
}

const newer = (a: ComponentId, b: ComponentId) => (compareVersions(a.version, b.version).direction === "ahead" ? b : a);

/** Joins Figma and code ids on `<tier>.<name>` (same prefix only) and reports version drift. Malformed ids become problems. */
export function idsReport(sightings: IdSighting[], prefix: string, problems: string[] = []): IdsReport {
  const found = { figma: new Map<string, Map<string, { id: ComponentId; from: string[] }>>(), code: new Map<string, Map<string, { id: ComponentId; from: string[] }>>() };
  const other = new Map<string, { id: string; side: "figma" | "code"; from: string[] }>();
  const issues = [...problems];
  for (const sighting of sightings) {
    for (const parsed of idsInText(sighting.text)) {
      if (!parsed.ok) {
        issues.push(`${sighting.from}: ${parsed.error}`);
        continue;
      }
      const { id } = parsed;
      if (id.prefix !== prefix) {
        const row = other.get(`${sighting.side}\0${id.raw}`) ?? { id: id.raw, side: sighting.side, from: [] };
        if (!row.from.includes(sighting.from)) row.from.push(sighting.from);
        other.set(`${sighting.side}\0${id.raw}`, row);
        continue;
      }
      const byKey = found[sighting.side].get(id.key) ?? new Map<string, { id: ComponentId; from: string[] }>();
      const row = byKey.get(id.versionText) ?? { id, from: [] };
      if (!row.from.includes(sighting.from)) row.from.push(sighting.from);
      byKey.set(id.versionText, row);
      found[sighting.side].set(id.key, byKey);
    }
  }
  const pick = (side: "figma" | "code", key: string) => {
    const rows = [...(found[side].get(key)?.values() ?? [])];
    if (rows.length > 1) issues.push(`${side === "figma" ? "Figma" : "Code"} has ${key} at more than one version (${rows.map((row) => row.id.versionText).join(", ")}). The newest is compared.`);
    return rows.length ? { id: rows.map((row) => row.id).reduce(newer), from: rows.flatMap((row) => row.from) } : undefined;
  };
  const keys = [...new Set([...found.figma.keys(), ...found.code.keys()])].sort();
  const pairs: IdDrift[] = [];
  const figmaOnly: IdsReport["figmaOnly"] = [];
  const codeOnly: IdsReport["codeOnly"] = [];
  for (const key of keys) {
    const figma = pick("figma", key);
    const code = pick("code", key);
    if (figma && code) pairs.push(driftOf(key, figma.id, code.id, figma.from, code.from));
    else if (figma) figmaOnly.push({ id: figma.id.raw, from: figma.from });
    else if (code) codeOnly.push({ id: code.id.raw, from: code.from });
  }
  const behind = (change: IdChange) => pairs.filter((row) => row.direction === "behind" && row.change === change).length;
  const otherPrefix = [...other.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unique = [...new Set(issues)];
  return {
    kind: "resolve.aidlc.ids",
    schemaVersion: 1,
    prefix,
    blocks: false,
    summary: {
      pairs: pairs.length,
      same: pairs.filter((row) => row.change === "same").length,
      patch: behind("patch"),
      minor: behind("minor"),
      major: behind("major"),
      ahead: pairs.filter((row) => row.direction === "ahead").length,
      figmaOnly: figmaOnly.length,
      codeOnly: codeOnly.length,
      otherPrefix: otherPrefix.length,
      problems: unique.length,
    },
    pairs,
    figmaOnly,
    codeOnly,
    otherPrefix,
    problems: unique,
  };
}

/** Figma side: part and ingredient names, variants and descriptions. Code side: the code-map text of each part. */
export function handoffSightings(pack: Extract<HandoffPack, { ok: true }>): IdSighting[] {
  const out: IdSighting[] = [];
  for (const screen of pack.screens) {
    const where = `screen "${screen.screen.name}"`;
    for (const part of screen.components) {
      const description = (part as { description?: unknown }).description;
      for (const text of [part.name, part.variant, typeof description === "string" ? description : undefined]) {
        if (text) out.push({ side: "figma", text, from: `${where} part "${part.name}"` });
      }
      if (part.code && part.code !== "unmapped" && part.code !== "unknown") out.push({ side: "code", text: part.code, from: `code map for "${part.name}"` });
      const inside = (parts: typeof part.parts | undefined, path: string) => {
        for (const inner of parts ?? []) {
          out.push({ side: "figma", text: inner.name, from: `${path} > "${inner.name}"` });
          if (inner.code && inner.code !== "unmapped" && inner.code !== "unknown") out.push({ side: "code", text: inner.code, from: `code map for "${inner.name}"` });
          inside(inner.parts, `${path} > "${inner.name}"`);
        }
      };
      inside(part.parts, `${where} part "${part.name}"`);
    }
  }
  return out;
}

/** Code side: `resolveId` in component.json manifests under the coded repo. */
export function manifestSightings(repo: string): { sightings: IdSighting[]; problems: string[] } {
  const sightings: IdSighting[] = [];
  const problems: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (name === "component.json") {
        try {
          const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as { resolveId?: unknown };
          if (doc.resolveId !== undefined) {
            if (typeof doc.resolveId === "string") sightings.push({ side: "code", text: doc.resolveId, from: relative(repo, path) });
            else problems.push(`${relative(repo, path)}: resolveId must be a string.`);
          }
        } catch {
          problems.push(`${relative(repo, path)} is not JSON, so its resolveId was not read.`);
        }
      } else if (!name.includes(".")) walk(path, depth + 1);
    }
  };
  if (existsSync(repo)) walk(repo, 0);
  else problems.push(`codeRepo ${repo} does not exist, so no component.json ids were read.`);
  return { sightings, problems };
}

export interface IdsConfig {
  prefix: string;
  codeRepo?: string;
  path?: string;
  problems: string[];
}

/** `.resolve/aidlc.json`: RESOLVE_HOME first, else the nearest `.resolve` walking up from each start folder in turn. A bad file is a problem, never an error. */
export function readIdsConfig(starts: string[], env: NodeJS.ProcessEnv = process.env): IdsConfig {
  const candidates: string[] = [];
  if (env["RESOLVE_HOME"]?.trim()) candidates.push(join(resolve(env["RESOLVE_HOME"]), IDS_CONFIG_FILE));
  for (const start of starts) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      candidates.push(join(dir, ".resolve", IDS_CONFIG_FILE));
      if (dirname(dir) === dir) break;
    }
  }
  const path = candidates.find((file) => existsSync(file));
  if (!path) return { prefix: DEFAULT_ID_PREFIX, problems: [] };
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    doc = parsed as Record<string, unknown>;
  } catch {
    return { prefix: DEFAULT_ID_PREFIX, path, problems: [`${path} is not a JSON object. Using the default prefix "${DEFAULT_ID_PREFIX}".`] };
  }
  const problems: string[] = [];
  let prefix = DEFAULT_ID_PREFIX;
  if (doc["idPrefix"] !== undefined) {
    if (typeof doc["idPrefix"] === "string" && PREFIX.test(doc["idPrefix"])) prefix = doc["idPrefix"];
    else problems.push(`${path}: idPrefix must be lowercase letters, digits or hyphens, starting with a letter. Using the default prefix "${DEFAULT_ID_PREFIX}".`);
  }
  const repo = doc["codeRepo"];
  const project = dirname(dirname(path));
  const codeRepo = typeof repo === "string" && repo.trim() ? (isAbsolute(repo) ? repo : resolve(project, repo)) : undefined;
  if (repo !== undefined && !codeRepo) problems.push(`${path}: codeRepo must be a folder path.`);
  return { prefix, ...(codeRepo ? { codeRepo } : {}), path, problems };
}

/** The ids section for one handoff: config, handoff names and code text, and component.json manifests when codeRepo is set. */
export function idsForHandoff(pack: Extract<HandoffPack, { ok: true }>, starts: string[], env: NodeJS.ProcessEnv = process.env): IdsReport {
  const config = readIdsConfig(starts, env);
  const manifests = config.codeRepo ? manifestSightings(config.codeRepo) : { sightings: [], problems: [] };
  return idsReport([...handoffSightings(pack), ...manifests.sightings], config.prefix, [...config.problems, ...manifests.problems]);
}
