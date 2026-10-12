/** Synonym overlay and icon-library warnings for recommend. */
import { existsSync, readFileSync } from "node:fs";
import type { GraphNode } from "@/core/model";
import { foldLibName } from "@/core/rules/names";
import synonymFile from "@/data/synonyms.json";
import type { GraphIndex } from "./GraphIndex";
import { MASTER_TYPES } from "./masterNames";
import { overlayFile } from "./overlayFile";
import { tokensOf } from "./queryTokens";
import { type LibraryRules, type RecommendContext, ruleMatches } from "./recommendSupport";
import { isScreen, screenOf } from "./screenInventory";
import type { WorkspaceManifest } from "./workspace";

export function variantHaystack(node: GraphNode): string {
  const props = node.variantProperties;
  if (!props) return "";
  return Object.entries(props)
    .flatMap(([key, value]) => [key, value])
    .join(" ");
}
/** Unique masters nested on each screen frame. */
export function mastersByScreen(index: GraphIndex): Map<string, GraphNode[]> {
  const byScreen = new Map<string, GraphNode[]>();
  for (const frame of index.getNodesByType("FRAME")) {
    if (!isScreen(index, frame)) continue;
    const seen = new Map<string, GraphNode>();
    for (const instance of index.getNestedInstances(frame.id)) {
      const main = index.getMainComponent(instance.id);
      if (main) seen.set(main.id, main);
    }
    byScreen.set(frame.id, [...seen.values()]);
  }
  return byScreen;
}
export function screensOfMaster(index: GraphIndex, node: GraphNode): GraphNode[] {
  const seen = new Map<string, GraphNode>();
  for (const instance of index.getAllInstancesOf(node.id)) {
    const screen = screenOf(index, instance.id);
    if (screen) seen.set(screen.id, screen);
  }
  return [...seen.values()];
}
export function contextTokenGroups(context?: RecommendContext) {
  if (!context) return undefined;
  return {
    product: tokensOf([context.product?.id, context.product?.name].filter(Boolean).join(" ")),
    client: tokensOf([context.client?.id, context.client?.name].filter(Boolean).join(" ")),
    domain: tokensOf([context.domain, context.screenType].filter(Boolean).join(" ")),
    journey: tokensOf([context.journey?.step, context.journey?.screenJob].filter(Boolean).join(" ")),
  };
}
export function appliedRecommendContext(context?: RecommendContext) {
  if (!context) return undefined;
  const product = context.product?.name || context.product?.id;
  const client = context.client?.name || context.client?.id;
  const journey = context.journey?.screenJob || context.journey?.step;
  const a11y = context.constraints?.a11y?.trim();
  const from = (key: "product" | "client" | "domain" | "journey" | "audience" | "a11y") => context.sources?.[key];
  const sourceValues = Object.values(context.sources ?? {});
  const id = context.id?.trim();
  const chosen = sourceValues.length
    ? sourceValues.some((item) => item === "active pack" || item.startsWith("pack "))
    : Boolean(id);
  if (!product && !client && !context.domain && !journey && !context.audience && !a11y && !context.warning && !context.files?.length) {
    return undefined;
  }
  return {
    ...(chosen && id ? { id } : {}),
    ...(product ? { product, ...(from("product") ? { productFrom: from("product") } : {}) } : {}),
    ...(client ? { client, ...(from("client") ? { clientFrom: from("client") } : {}) } : {}),
    ...(context.domain ? { domain: context.domain, ...(from("domain") ? { domainFrom: from("domain") } : {}) } : {}),
    ...(journey ? { journey, ...(from("journey") ? { journeyFrom: from("journey") } : {}) } : {}),
    ...(context.audience ? { audience: context.audience, ...(from("audience") ? { audienceFrom: from("audience") } : {}) } : {}),
    ...(a11y ? { a11y, ...(from("a11y") ? { a11yFrom: from("a11y") } : {}) } : {}),
    ...(context.files?.length ? { files: context.files } : {}),
    ...(context.warning ? { warning: context.warning } : {}),
  };
}
export function deniedByRules(index: GraphIndex, node: GraphNode, rules?: LibraryRules): boolean {
  const deny = rules?.deny;
  if (!deny?.length) return false;
  return deny.some((rule) => ruleMatches(index, node, rule));
}
/** Everyday words that mean the same control. Reasons live in src/data/synonyms.json. */
export const SYNONYM_GROUPS: (readonly string[])[] = [];
export const SYNONYM_OF = new Map<string, readonly string[]>();
for (const group of synonymFile.groups) {
  const terms = group.terms.map((term) => term.toLowerCase()).filter((term) => !term.includes(" "));
  if (terms.length) SYNONYM_GROUPS.push(terms);
  for (const term of terms) SYNONYM_OF.set(term, terms);
}
/** Label words that can sit beside a control. They match, and the card is partial. */
export const LABEL_FILLER = new Set(["sign", "terms", "submit", "submitting", "phone", "number", "country", "edit"]);
/** Unasked position words. "app bar" is the top bar, not the bottom bar. */
export const DEMOTE_UNASKED = new Set(["bottom", "secondary", "right"]);
interface SynonymGroup {
  terms: string[];
}
let extraGroups: SynonymGroup[] = [];
export const extraSynonym = new Map<string, readonly string[]>();
export function allSynonymGroups(): readonly { terms: readonly string[] }[] {
  return extraGroups.length ? [...synonymFile.groups, ...extraGroups] : synonymFile.groups;
}
function synonymOverlayFile(): string | undefined {
  return overlayFile("synonyms.json");
}
/** Per-library words. Missing or broken file changes nothing. */
export function loadSynonymOverlay(): void {
  extraGroups = [];
  extraSynonym.clear();
  const path = synonymOverlayFile();
  if (!path) return;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = raw && typeof raw === "object" ? (raw as { groups?: unknown }) : undefined;
    const groups = Array.isArray(record?.groups) ? record.groups : Array.isArray(raw) ? raw : [];
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const terms = (group as { terms?: unknown }).terms;
      if (!Array.isArray(terms)) continue;
      const cleaned = terms.map((term) => String(term).trim().toLowerCase()).filter(Boolean);
      if (cleaned.length < 2) continue;
      extraGroups.push({ terms: cleaned });
      const singles = cleaned.filter((term) => !term.includes(" "));
      for (const term of singles) extraSynonym.set(term, singles);
    }
  } catch {
    extraGroups = [];
    extraSynonym.clear();
  }
}
interface IconLibraryEntry {
  raw: string;
  name?: string;
  fileKey?: string;
  page?: string;
}
/** Team icon-library entries. Empty = name heuristic. Re-read every recommend. */
let iconLibraryEntries: IconLibraryEntry[] = [];
let iconLibraryIgnored = new Set<string>();
let iconLibraryMalformed = false;
function parseIconLibraryItem(item: unknown): IconLibraryEntry | undefined {
  if (typeof item === "string") {
    const folded = foldLibName(item);
    return folded ? { raw: item.trim(), name: folded, fileKey: folded, page: folded } : undefined;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const rec = item as { name?: unknown; fileKey?: unknown; page?: unknown };
  const name = typeof rec.name === "string" ? foldLibName(rec.name) : "";
  const fileKey = typeof rec.fileKey === "string" ? foldLibName(rec.fileKey) : "";
  const page = typeof rec.page === "string" ? foldLibName(rec.page) : "";
  if (!name && !fileKey && !page) return undefined;
  const raw = name || fileKey || page;
  return {
    raw,
    ...(name ? { name } : {}),
    ...(fileKey ? { fileKey } : {}),
    ...(page ? { page } : {}),
  };
}
function loadIconLibraries(): void {
  iconLibraryEntries = [];
  iconLibraryIgnored = new Set();
  iconLibraryMalformed = false;
  const path = overlayFile("icon-libraries.json");
  // A pinned store with no file is no config. Only real JSON errors warn.
  if (!path || !existsSync(path)) return;
  let raw: unknown;
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
    if (!text) return;
    raw = JSON.parse(text);
  } catch {
    iconLibraryMalformed = true;
    return;
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { libraries?: unknown }).libraries
      : undefined;
  if (!Array.isArray(list)) {
    iconLibraryMalformed = true;
    return;
  }
  for (const item of list) {
    const entry = parseIconLibraryItem(item);
    if (entry) iconLibraryEntries.push(entry);
  }
}
function metaText(node: GraphNode, key: string): string | undefined {
  const value = node.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function nodeIconAnchors(
  index: GraphIndex,
  node: GraphNode,
  workspace?: WorkspaceManifest,
): { names: string[]; keys: string[]; pages: string[] } {
  const names: string[] = [];
  const keys: string[] = [];
  const pages: string[] = [];
  const pushName = (value?: string) => {
    if (value) names.push(foldLibName(value));
  };
  const pushKey = (value?: string) => {
    if (value) keys.push(foldLibName(value));
  };
  const pushPage = (value?: string) => {
    if (value) pages.push(foldLibName(value));
  };
  pushKey(metaText(node, "sourceFileKey"));
  pushName(metaText(node, "sourceFileName"));
  pushPage(metaText(node, "sourcePageName"));
  const key = node.fileKey?.trim();
  if (key) {
    pushKey(key);
    for (const file of index.getNodesByType("FILE")) {
      if (file.fileKey === key || file.id === `file:${key}`) pushName(file.name);
    }
    if (workspace) {
      for (const file of workspace.files) {
        if (file.key === key) {
          pushKey(file.key);
          if (file.label) pushName(file.label);
        }
      }
    }
  }
  const page = node.pageId ? index.getNode(node.pageId) : undefined;
  if (page && (page.type === "PAGE" || page.type === "SECTION")) pushPage(page.name);
  for (const ancestor of index.getAncestors(node.id)) {
    if (ancestor.type === "PAGE" || ancestor.type === "SECTION") pushPage(ancestor.name);
  }
  return { names, keys, pages };
}
function entryHitsAnchors(
  entry: IconLibraryEntry,
  anchors: { names: string[]; keys: string[]; pages: string[] },
): boolean {
  if (entry.fileKey && anchors.keys.includes(entry.fileKey)) return true;
  if (entry.name && anchors.names.includes(entry.name)) return true;
  if (entry.page && anchors.pages.includes(entry.page)) return true;
  return false;
}
function mainLibraryAnchors(
  index: GraphIndex,
  workspace?: WorkspaceManifest,
): { names: string[]; keys: string[] } {
  const names: string[] = [];
  const keys: string[] = [];
  const primary = index.graph.fileKey;
  if (primary) keys.push(foldLibName(primary));
  if (index.graph.fileName) names.push(foldLibName(index.graph.fileName));
  for (const file of index.getNodesByType("FILE")) {
    if (!primary || file.fileKey === primary || file.id === `file:${primary}`) {
      names.push(foldLibName(file.name));
      if (file.fileKey) keys.push(foldLibName(file.fileKey));
    }
  }
  if (workspace && primary) {
    for (const file of workspace.files) {
      if (file.key === primary) {
        keys.push(foldLibName(file.key));
        if (file.label) names.push(foldLibName(file.label));
      }
    }
  }
  return { names, keys };
}
function entryHitsMainLibrary(entry: IconLibraryEntry, main: { names: string[]; keys: string[] }): boolean {
  if (entry.fileKey && main.keys.includes(entry.fileKey)) return true;
  if (entry.name && main.names.includes(entry.name)) return true;
  return false;
}
export function fromIconLibrary(
  index: GraphIndex,
  node: GraphNode,
  workspace?: WorkspaceManifest,
): boolean {
  if (!iconLibraryEntries.length) return false;
  const main = mainLibraryAnchors(index, workspace);
  const anchors = nodeIconAnchors(index, node, workspace);
  return iconLibraryEntries.some((entry) => {
    if (iconLibraryIgnored.has(entry.raw)) return false;
    if (entryHitsMainLibrary(entry, main)) return false;
    return entryHitsAnchors(entry, anchors);
  });
}
let emittedIconLibraryWarningKey = "";
export function emitIconLibraryWarningsOnce(lines: readonly string[]): void {
  if (!lines.length) return;
  const key = lines.join("\n");
  if (key === emittedIconLibraryWarningKey) return;
  emittedIconLibraryWarningKey = key;
  for (const line of lines) process.stderr.write(`${line}\n`);
}
/** One line per unmatched or ignored icon-library entry. Empty when nothing is configured. */
export function iconLibraryWarnings(
  index: GraphIndex,
  workspace?: WorkspaceManifest,
): string[] {
  loadIconLibraries();
  const lines: string[] = [];
  if (iconLibraryMalformed) lines.push("icon-libraries.json is malformed; ignored");
  if (!iconLibraryEntries.length) return lines;
  const main = mainLibraryAnchors(index, workspace);
  const masters = index.getNodesByType(...MASTER_TYPES);
  iconLibraryIgnored = new Set();
  for (const entry of iconLibraryEntries) {
    if (entryHitsMainLibrary(entry, main)) {
      iconLibraryIgnored.add(entry.raw);
      lines.push(`icon library "${entry.raw}" matches the main library; ignored`);
      continue;
    }
    const hit = masters.some((node) => entryHitsAnchors(entry, nodeIconAnchors(index, node, workspace)));
    if (!hit) lines.push(`icon library "${entry.raw}" matched no components`);
  }
  return lines;
}
