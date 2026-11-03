import { parseDsId } from "@/core/rules/dsId";
import type { Evidence, KnowledgeWarning, ParsedClaim, ParsedComponent, ParsedRecipe } from "./types";

const SCHEMA_NEXT = "fix the file to match schemas/dsck.schema.json or schemas/dsci.schema.json and run resolve code knowledge check again";
const LISTS = ["props", "variants", "parts", "slots", "tokens", "aliases"] as const;
const DSCK_KEYS = new Set(["version", "source", "repo", "ref", "status", "components"]);
const DSCI_KEYS = new Set(["version", "source", "repo", "ref", "status", "recipes"]);
const SLUG = /^[a-z][a-z0-9-]*$/;

export interface ParsedDraft {
  components: ParsedComponent[];
  recipes: ParsedRecipe[];
  warnings: KnowledgeWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schema(path: string, problem: string): KnowledgeWarning {
  return { message: `schema ${path} ${problem}`, next: SCHEMA_NEXT };
}

/** The whole string is one shared id, not a sentence that mentions one. */
export function canonicalDsId(value: string): string | undefined {
  const found = parseDsId(value.trim());
  if (!found || found.id !== value.trim().toLowerCase()) return undefined;
  return found.id;
}

function parseEvidence(value: unknown, path: string, warnings: KnowledgeWarning[]): Evidence | undefined {
  if (!isRecord(value)) {
    warnings.push(schema(path, "must be { file, line }"));
    return undefined;
  }
  for (const key of Object.keys(value)) if (key !== "file" && key !== "line") warnings.push(schema(`${path}/${key}`, "is not a schema field"));
  const file = value["file"];
  const line = value["line"];
  const fileOk = typeof file === "string" && file.trim().length > 0;
  const lineOk = typeof line === "number" && Number.isInteger(line) && line >= 1;
  if (!fileOk) warnings.push(schema(`${path}/file`, "must be a path"));
  if (!lineOk) warnings.push(schema(`${path}/line`, "must be a line number starting at 1"));
  return fileOk && lineOk ? { file: (file as string).trim(), line: line as number } : undefined;
}

function parseClaim(value: unknown, path: string, warnings: KnowledgeWarning[]): ParsedClaim | undefined {
  if (!isRecord(value)) {
    warnings.push(schema(path, "must be an object"));
    return undefined;
  }
  for (const key of Object.keys(value)) if (key !== "name" && key !== "values" && key !== "evidence") warnings.push(schema(`${path}/${key}`, "is not a schema field"));
  const name = value["name"];
  if (typeof name !== "string" || !name.trim()) warnings.push(schema(`${path}/name`, "must be a name"));
  if (value["values"] !== undefined && (!Array.isArray(value["values"]) || value["values"].some((item) => typeof item !== "string"))) {
    warnings.push(schema(`${path}/values`, "must be a list of strings"));
  }
  const evidence = value["evidence"] === undefined ? undefined : parseEvidence(value["evidence"], `${path}/evidence`, warnings);
  if (value["evidence"] === undefined) warnings.push(schema(`${path}/evidence`, "is required"));
  if (typeof name !== "string" || !name.trim()) return undefined;
  return { name: name.trim(), ...(evidence ? { evidence } : {}) };
}

function parseList(value: unknown, path: string, warnings: KnowledgeWarning[]): ParsedClaim[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(schema(path, "must be a list"));
    return [];
  }
  return value.flatMap((item, index) => {
    const claim = parseClaim(item, `${path}/${index}`, warnings);
    return claim ? [claim] : [];
  });
}

function parseStatus(value: unknown, warnings: KnowledgeWarning[]): void {
  if (value === undefined) return;
  if (value !== "proposed" && value !== "confirmed") warnings.push(schema("status", "must be proposed or confirmed"));
  if (value === "confirmed") {
    warnings.push({
      message: "status confirmed was ignored",
      next: "leave status proposed. A person confirms with resolve code knowledge confirm --who <name>. Nothing was confirmed",
    });
  }
}

function parseComponent(value: unknown, path: string, warnings: KnowledgeWarning[]): ParsedComponent | undefined {
  if (!isRecord(value)) {
    warnings.push(schema(path, "must be an object"));
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "figma" && key !== "evidence" && !LISTS.includes(key as (typeof LISTS)[number])) warnings.push(schema(`${path}/${key}`, "is not a schema field"));
  }
  const id = typeof value["id"] === "string" ? canonicalDsId(value["id"]) : undefined;
  if (!id) warnings.push(schema(`${path}/id`, "must be ds@semver.tier.name"));
  if (value["figma"] !== undefined && (typeof value["figma"] !== "string" || !value["figma"].trim())) warnings.push(schema(`${path}/figma`, "must be a Figma component name"));
  const evidence = value["evidence"] === undefined ? undefined : parseEvidence(value["evidence"], `${path}/evidence`, warnings);
  if (value["evidence"] === undefined) warnings.push(schema(`${path}/evidence`, "is required"));
  if (!id) return undefined;
  const name = id.slice(id.lastIndexOf(".") + 1);
  const figma = typeof value["figma"] === "string" && value["figma"].trim() ? value["figma"].trim() : undefined;
  return {
    id,
    name,
    ...(figma ? { figma } : {}),
    props: parseList(value["props"], `${path}/props`, warnings),
    variants: parseList(value["variants"], `${path}/variants`, warnings),
    parts: parseList(value["parts"], `${path}/parts`, warnings),
    slots: parseList(value["slots"], `${path}/slots`, warnings),
    tokens: parseList(value["tokens"], `${path}/tokens`, warnings),
    aliases: parseList(value["aliases"], `${path}/aliases`, warnings),
    ...(evidence ? { evidence } : {}),
  };
}

function rootWarnings(value: Record<string, unknown>, allowed: Set<string>, warnings: KnowledgeWarning[]): void {
  if (value["version"] !== 1) warnings.push(schema("version", "must be 1"));
  if (value["source"] !== "ai") warnings.push(schema("source", "must be ai"));
  for (const key of ["repo", "ref"] as const) if (value[key] !== undefined && typeof value[key] !== "string") warnings.push(schema(key, "must be a string"));
  for (const key of Object.keys(value)) if (!allowed.has(key)) warnings.push(schema(key, "is not a schema field"));
  parseStatus(value["status"], warnings);
}

/** Schema check for a DSCK file and an optional DSCI file. Invalid pieces are dropped. The rest are kept for comparison. */
export function parseDraft(dsck: unknown, dsci: unknown | undefined): ParsedDraft {
  const warnings: KnowledgeWarning[] = [];
  const components: ParsedComponent[] = [];
  const recipes: ParsedRecipe[] = [];
  if (!isRecord(dsck)) warnings.push(schema("(file)", "must be a DSCK object"));
  else {
    rootWarnings(dsck, DSCK_KEYS, warnings);
    if (!Array.isArray(dsck["components"])) warnings.push(schema("components", "must be a list"));
    else for (const [index, item] of dsck["components"].entries()) {
      const component = parseComponent(item, `components/${index}`, warnings);
      if (component) components.push(component);
    }
  }
  if (dsci !== undefined) {
    if (!isRecord(dsci)) warnings.push(schema("usage", "must be a DSCI object"));
    else {
      rootWarnings(dsci, DSCI_KEYS, warnings);
      if (!Array.isArray(dsci["recipes"])) warnings.push(schema("recipes", "must be a list"));
      else for (const [index, item] of dsci["recipes"].entries()) recipes.push(...parseRecipe(item, index, warnings));
    }
  }
  return { components, recipes, warnings };
}

function parseRecipe(value: unknown, index: number, warnings: KnowledgeWarning[]): ParsedRecipe[] {
  const path = `recipes/${index}`;
  if (!isRecord(value)) {
    warnings.push(schema(path, "must be an object"));
    return [];
  }
  for (const key of Object.keys(value)) if (!["id", "name", "components", "evidence"].includes(key)) warnings.push(schema(`${path}/${key}`, "is not a schema field"));
  const id = typeof value["id"] === "string" ? value["id"].trim() : "";
  if (!SLUG.test(id)) warnings.push(schema(`${path}/id`, "must be a slug"));
  if (value["name"] !== undefined && typeof value["name"] !== "string") warnings.push(schema(`${path}/name`, "must be a string"));
  const components: string[] = [];
  if (!Array.isArray(value["components"]) || value["components"].length === 0) warnings.push(schema(`${path}/components`, "must list the composed component ids"));
  else for (const [at, item] of value["components"].entries()) {
    const canonical = typeof item === "string" ? canonicalDsId(item) : undefined;
    if (!canonical) warnings.push(schema(`${path}/components/${at}`, "must be ds@semver.tier.name"));
    else components.push(canonical);
  }
  const evidence = value["evidence"] === undefined ? undefined : parseEvidence(value["evidence"], `${path}/evidence`, warnings);
  if (value["evidence"] === undefined) warnings.push(schema(`${path}/evidence`, "is required"));
  if (!SLUG.test(id)) return [];
  return [{ id, components, ...(evidence ? { evidence } : {}) }];
}
