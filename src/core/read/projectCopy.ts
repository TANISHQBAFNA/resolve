import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { canonicalProposalId, LEGACY_DSCI_FILE } from "../codeKnowledge/dsci";
import type { DsciProposal, DsckState } from "../codeKnowledge/dsck";

/**
 * A copy of the components, DSCK and DSCI that Resolve keeps in each project
 * folder (`<project>/.resolve/local/`). Every run syncs it from the store:
 * components are added or updated, removed ones are marked stale (never
 * deleted), DSCK is refreshed, and DSCI keeps what a person approved. An
 * approved proposal that changed in the store is flagged, not re-approved.
 * Sync never approves anything and never stops a run: problems are warnings.
 * It is a rebuildable cache (setup gitignores it). A file someone edited by hand
 * is left as it is, with one warning, until `resolve sync` replaces it (keeping a
 * `.edited.json` backup) or the file is deleted.
 */

export const PROJECT_COPY_VERSION = 1;

export interface LocalComponent {
  id: string;
  name: string;
  type: string;
  fileKey?: string;
  figmaNodeId?: string;
  status?: string;
  fingerprint: string;
  firstSeen: string;
  updatedAt: string;
  stale?: true;
  staleSince?: string;
}

export interface LocalDsciProposal {
  id: string;
  type?: string;
  status: DsciProposal["status"];
  summary: string;
  fingerprint: string;
  proposal: DsciProposal;
  /** Approved here, then the store's proposal changed. The approved content is kept; the new one waits in `incoming`. */
  changed?: true;
  changedAt?: string;
  incoming?: DsciProposal;
  /** Approved here, then the proposal left the store. */
  missingFromStore?: true;
  /** The proposal names a component that is now stale. */
  staleComponent?: string;
}

export interface ProjectCopyWarning {
  message: string;
  next: string;
}

export interface ProjectCopyReport {
  dir: string;
  synced: boolean;
  components: { total: number; added: number; updated: number; stale: number; newlyStale: number; revived: number };
  dsck: { facts: number; staleFacts: number };
  dsci: { pending: number; approved: number; rejected: number; changedApproved: number; added: number };
  warnings: ProjectCopyWarning[];
}

interface Meta {
  version: number;
  syncedAt: string;
  store: string;
  storeFingerprint?: string;
  /** Hash of each file as Resolve last wrote it, to tell a hand edit from a sync. */
  files?: Record<string, string>;
  /** Hand-edited files already warned about, so the warning prints once. */
  editWarned?: string[];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, jsonText(value));
  renameSync(tmp, path);
}

const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** True when the file is not what Resolve last wrote there. */
function handEdited(path: string, written: string | undefined): boolean {
  if (!written || !existsSync(path)) return false;
  try {
    return textHash(readFileSync(path, "utf8")) !== written;
  } catch {
    return false;
  }
}

const PROJECT_MARKERS = [".git", "package.json", ".resolve"];

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

const hasMarker = (dir: string, markers: readonly string[]) => markers.some((marker) => existsSync(join(dir, marker)));

/**
 * The real project root. Inside a git work tree it is the nearest folder with a marker, never above the
 * repo's top (`.git`). Outside a git work tree it is the current folder only when that folder has a marker.
 * It never climbs past the home folder. No root means no copy: nothing is written into an unrelated folder.
 */
export function projectRoot(cwd: string, home: string): string | undefined {
  const start = resolve(cwd);
  let nearest: string | undefined;
  for (let dir = start; dir !== home; ) {
    if (!nearest && hasMarker(dir, PROJECT_MARKERS)) nearest = dir;
    if (existsSync(join(dir, ".git"))) return nearest ?? dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return nearest === start ? start : undefined;
}

/**
 * `<project>/.resolve/local`, or undefined when there is no project to write into
 * (RESOLVE_PROJECT_COPY=0, no project root, the home folder itself, or inside the store).
 */
export function projectCopyDir(
  cwd: string,
  env: { RESOLVE_PROJECT_COPY?: string; RESOLVE_PROJECT_DIR?: string; HOME?: string; USERPROFILE?: string },
  storeRoot: string,
): string | undefined {
  if (env.RESOLVE_PROJECT_COPY?.trim() === "0") return undefined;
  const home = resolve(env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
  const explicit = env.RESOLVE_PROJECT_DIR?.trim();
  const root = explicit ? resolve(explicit) : projectRoot(cwd, home);
  if (!root || root === home || root === resolve("/")) return undefined;
  if (inside(root, resolve(storeRoot)) || inside(root, join(home, ".resolve"))) return undefined;
  return join(root, ".resolve", "local");
}

/** Sets and stand-alone components. A variant changes its set's fingerprint, not a row of its own. */
export function libraryComponents(index: GraphIndex): Array<{ node: GraphNode; fingerprint: string }> {
  const out: Array<{ node: GraphNode; fingerprint: string }> = [];
  const variantsOf = new Map<string, string[]>();
  for (const node of index.getNodesByType("MAIN_COMPONENT", "VARIANT")) {
    const setId = node.componentSetId ?? (node.parentId && index.getNode(node.parentId)?.type === "COMPONENT_SET" ? node.parentId : undefined);
    if (!setId) continue;
    const list = variantsOf.get(setId) ?? [];
    list.push(`${node.name}|${JSON.stringify(node.variantProperties ?? {})}`);
    variantsOf.set(setId, list);
  }
  for (const node of index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT")) {
    if (node.type === "MAIN_COMPONENT" && (node.componentSetId || (node.parentId && index.getNode(node.parentId)?.type === "COMPONENT_SET"))) continue;
    const fingerprint = hash([
      node.name,
      node.description ?? "",
      node.status ?? "",
      node.propertyDefinitions ?? [],
      node.metadata?.["componentKey"] ?? "",
      [...(variantsOf.get(node.id) ?? [])].sort(),
    ]);
    out.push({ node, fingerprint });
  }
  return out;
}

function proposalFingerprint(proposal: DsciProposal): string {
  const { status: _status, createdAt: _created, updatedAt: _updated, decisionNote: _note, ...content } = proposal;
  return hash(content);
}

function proposalMasterIds(proposal: DsciProposal): string[] {
  return [
    proposal.scope?.masterId,
    proposal.suggestedRule?.masterId,
    proposal.suggestedRule?.overMasterId,
    proposal.suggestedRecipe?.masterId,
    proposal.suggestedVariant?.masterId,
    proposal.suggestedDeprecation?.masterId,
    proposal.suggestedDeprecation?.cousinId,
  ].filter((id): id is string => typeof id === "string");
}

export interface SyncInput {
  dir: string;
  storeRoot: string;
  storeFingerprint?: string;
  index?: GraphIndex;
  dsck?: DsckState;
  now?: string;
  /** `resolve sync`: replace hand-edited files too, after saving a `.edited.json` backup. */
  force?: boolean;
}

/** Skip the sync when the store has not changed since the last one and the copy is complete. */
export function projectCopyFresh(dir: string, storeFingerprint: string | undefined): boolean {
  if (!storeFingerprint) return false;
  const meta = readJson<Meta>(join(dir, "meta.json"));
  return Boolean(
    meta?.storeFingerprint === storeFingerprint &&
      ["components.json", "dsck.json", "dsci.json"].every((name) => existsSync(join(dir, name))),
  );
}

export function syncProjectCopy(input: SyncInput): ProjectCopyReport {
  const now = input.now ?? new Date().toISOString();
  const { dir } = input;
  const warnings: ProjectCopyWarning[] = [];

  // Components: add, update, mark removed ones stale. Never delete a row.
  const previous = readJson<{ components?: LocalComponent[] }>(join(dir, "components.json"))?.components ?? [];
  const before = new Map(previous.map((row) => [row.id, row]));
  const current = input.index ? libraryComponents(input.index) : [];
  const counts = { total: 0, added: 0, updated: 0, stale: 0, newlyStale: 0, revived: 0 };
  const rows: LocalComponent[] = [];
  const seen = new Set<string>();
  for (const { node, fingerprint } of current) {
    seen.add(node.id);
    const old = before.get(node.id);
    const removed = node.metadata?.["removedByAbsence"] === true;
    const row: LocalComponent = {
      id: node.id,
      name: node.name,
      type: node.type,
      ...(node.fileKey ? { fileKey: node.fileKey } : {}),
      ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
      ...(node.status ? { status: node.status } : {}),
      fingerprint,
      firstSeen: old?.firstSeen ?? now,
      updatedAt: old && old.fingerprint === fingerprint ? old.updatedAt : now,
    };
    if (!old) counts.added += 1;
    else if (old.fingerprint !== fingerprint && !removed) counts.updated += 1;
    if (removed) {
      row.stale = true;
      row.staleSince = old?.staleSince ?? now;
      if (!old?.stale) counts.newlyStale += 1;
    } else if (old?.stale) counts.revived += 1;
    rows.push(row);
  }
  for (const old of previous) {
    if (seen.has(old.id)) continue;
    if (!old.stale) counts.newlyStale += 1;
    rows.push({ ...old, stale: true, staleSince: old.staleSince ?? now });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  counts.total = rows.length;
  counts.stale = rows.filter((row) => row.stale).length;
  const staleIds = new Set(rows.filter((row) => row.stale).map((row) => row.id));
  if (counts.newlyStale) {
    warnings.push({
      message: `${counts.newlyStale} component${counts.newlyStale === 1 ? " is" : "s are"} no longer in the library and marked stale in ${join(dir, "components.json")}.`,
      next: "swap stale components on screens for their live replacement (recommend), then run Resolve again.",
    });
  }

  // DSCK: refreshed from the store every run.
  const dsck = input.dsck;
  const facts = dsck?.facts ?? [];
  const staleFacts = facts.filter((fact) => staleIds.has(fact.masterId)).length;
  if (staleFacts) {
    warnings.push({
      message: `${staleFacts} usage fact${staleFacts === 1 ? "" : "s"} in DSCK point at stale components.`,
      next: "verify the screens that use them again so DSCK learns the replacement.",
    });
  }

  // DSCI: mirror the store, keep what was approved here, flag approved ones that changed. Never approve.
  const localDsci = existsSync(join(dir, "dsci.json")) ? "dsci.json" : LEGACY_DSCI_FILE;
  const oldDsci = (readJson<{ proposals?: LocalDsciProposal[] }>(join(dir, localDsci))?.proposals ?? []).map((row) => ({
    ...row,
    id: canonicalProposalId(row.id),
  }));
  const oldById = new Map(oldDsci.map((row) => [row.id, row]));
  const storeProposals = dsck?.proposals ?? [];
  const dsciRows: LocalDsciProposal[] = [];
  const dsciCounts = { pending: 0, approved: 0, rejected: 0, changedApproved: 0, added: 0 };
  const inStore = new Set<string>();
  for (const proposal of storeProposals) {
    inStore.add(proposal.id);
    const fingerprint = proposalFingerprint(proposal);
    const old = oldById.get(proposal.id);
    if (!old) dsciCounts.added += 1;
    let row: LocalDsciProposal;
    if (old?.status === "approved" && old.fingerprint !== fingerprint) {
      row = { ...old, changed: true, changedAt: old.changed ? (old.changedAt ?? now) : now, incoming: proposal };
      delete row.missingFromStore;
    } else {
      row = {
        id: proposal.id,
        ...(proposal.type ? { type: proposal.type } : {}),
        status: proposal.status,
        summary: proposal.summary,
        fingerprint,
        proposal,
      };
    }
    dsciRows.push(row);
  }
  for (const old of oldDsci) {
    if (inStore.has(old.id) || old.status !== "approved") continue;
    dsciRows.push({ ...old, missingFromStore: true });
  }
  for (const row of dsciRows) {
    const staleId = proposalMasterIds(row.proposal).find((id) => staleIds.has(id));
    if (staleId) row.staleComponent = staleId;
    else delete row.staleComponent;
    if (row.status === "approved") dsciCounts.approved += 1;
    else if (row.status === "rejected") dsciCounts.rejected += 1;
    else dsciCounts.pending += 1;
    if (row.changed) dsciCounts.changedApproved += 1;
  }
  if (dsciCounts.changedApproved) {
    const ids = dsciRows.filter((row) => row.changed).map((row) => row.id);
    warnings.push({
      message: `${ids.length} approved DSCI proposal${ids.length === 1 ? "" : "s"} changed since approval (${ids.join(", ")}). The approved version is kept; the change is not approved.`,
      next: "show the change to the designer; approve it again with `resolve approve <id> --who <name>` or reject it.",
    });
  }
  const staleRules = dsciRows.filter((row) => row.status === "approved" && row.staleComponent).map((row) => row.id);
  if (staleRules.length) {
    warnings.push({
      message: `Approved DSCI ${staleRules.join(", ")} name${staleRules.length === 1 ? "s" : ""} a stale component.`,
      next: "ask the designer to re-point or reject the rule; Resolve does not change approved rules on its own.",
    });
  }

  const lastMeta = readJson<Meta>(join(dir, "meta.json"));
  const files: Record<string, string> = { ...(lastMeta?.files ?? {}) };
  const editWarned = new Set(lastMeta?.editWarned ?? []);
  const outputs: Array<[string, unknown]> = [
    ["components.json", { version: PROJECT_COPY_VERSION, syncedAt: now, components: rows }],
    ["dsck.json", { version: PROJECT_COPY_VERSION, syncedAt: now, threshold: dsck?.threshold, facts, freshness: dsck?.freshness ?? {}, corrections: dsck?.corrections ?? [] }],
    ["dsci.json", { version: PROJECT_COPY_VERSION, syncedAt: now, proposals: dsciRows }],
  ];
  for (const [name, value] of outputs) {
    const path = join(dir, name);
    if (handEdited(path, files[name])) {
      if (!input.force) {
        if (!editWarned.has(name)) {
          warnings.push({
            message: `${path} was edited by hand, so Resolve left it as it is and stopped syncing it. This folder is a copy of the store; nothing reads your edit.`,
            next: "make the change in the store instead (for DSCI: resolve approve <id> --who <name>), then delete the file or run resolve sync to refresh it.",
          });
          editWarned.add(name);
        }
        continue;
      }
      copyFileSync(path, path.replace(/\.json$/, ".edited.json"));
      warnings.push({ message: `${path} was edited by hand. resolve sync replaced it and kept your version in ${path.replace(/\.json$/, ".edited.json")}.`, next: "make the change in the store if you still want it (for DSCI: resolve approve <id> --who <name>)." });
    }
    writeJson(path, value);
    files[name] = textHash(jsonText(value));
    editWarned.delete(name);
  }
  const meta: Meta = {
    version: PROJECT_COPY_VERSION,
    syncedAt: now,
    store: input.storeRoot,
    ...(input.storeFingerprint ? { storeFingerprint: input.storeFingerprint } : {}),
    files,
    ...(editWarned.size ? { editWarned: [...editWarned].sort() } : {}),
  };
  writeJson(join(dir, "meta.json"), meta);

  return {
    dir,
    synced: true,
    components: counts,
    dsck: { facts: facts.length, staleFacts },
    dsci: dsciCounts,
    warnings,
  };
}

/** One stderr line when the copy changed in a way a person should see. Empty when nothing to say. */
export function projectCopyNote(report: ProjectCopyReport | undefined): string {
  if (!report) return "";
  const c = report.components;
  const parts: string[] = [];
  if (c.added) parts.push(`+${c.added} component${c.added === 1 ? "" : "s"}`);
  if (c.updated) parts.push(`${c.updated} updated`);
  if (c.newlyStale) parts.push(`${c.newlyStale} newly stale`);
  if (c.revived) parts.push(`${c.revived} back`);
  if (report.dsci.added) parts.push(`${report.dsci.added} new DSCI`);
  if (!parts.length && !report.warnings.length) return "";
  const lines = report.synced ? [`[resolve] project copy ${report.dir}: ${parts.length ? parts.join(", ") : "synced"}`] : [];
  for (const warning of report.warnings) lines.push(`[resolve] warning: ${warning.message} next: ${warning.next}`);
  return `${lines.join("\n")}\n`;
}

export interface ProjectSyncDeps {
  cwd: string;
  env: Parameters<typeof projectCopyDir>[1];
  storeRoot: string;
  graphExists: boolean;
  storeFingerprint: () => string;
  loadIndex: () => GraphIndex | undefined;
  loadDsck: () => DsckState | undefined;
  force?: boolean;
}

/** The folder the copy would be created in can be written (the nearest folder that exists). */
function writable(dir: string): boolean {
  let at = dir;
  while (!existsSync(at)) {
    const parent = dirname(at);
    if (parent === at) return false;
    at = parent;
  }
  try {
    accessSync(at, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read-only project folders already warned about, kept in the store so the warning prints once. */
const READ_ONLY_FILE = "project-copy-read-only.json";

function warnReadOnlyOnce(storeRoot: string, dir: string): boolean {
  const path = join(storeRoot, READ_ONLY_FILE);
  const seen = readJson<string[]>(path) ?? [];
  if (seen.includes(dir)) return false;
  try {
    writeJson(path, [...seen, dir].sort());
  } catch {
    // The store is read-only too: warning on every run is the honest fallback.
  }
  return true;
}

const failed = (dir: string, warnings: ProjectCopyWarning[]): ProjectCopyReport => ({
  dir,
  synced: false,
  components: { total: 0, added: 0, updated: 0, stale: 0, newlyStale: 0, revived: 0 },
  dsck: { facts: 0, staleFacts: 0 },
  dsci: { pending: 0, approved: 0, rejected: 0, changedApproved: 0, added: 0 },
  warnings,
});

/** Keep `<project>/.resolve/local` in step with the store. Never throws: a failure is a warning with a next step. */
export function runProjectSync(deps: ProjectSyncDeps): ProjectCopyReport | undefined {
  try {
    const dir = projectCopyDir(deps.cwd, deps.env, deps.storeRoot);
    if (!dir || !deps.graphExists) return undefined;
    if (!writable(dir)) {
      if (!deps.force && !warnReadOnlyOnce(deps.storeRoot, dir)) return undefined;
      return failed(dir, [{ message: `The project folder is read-only, so Resolve keeps no copy in ${dir}. Shown once.`, next: "nothing to do; to keep a copy, make the folder writable or set RESOLVE_PROJECT_DIR. RESOLVE_PROJECT_COPY=0 turns the copy off." }]);
    }
    const fingerprint = deps.storeFingerprint();
    if (!deps.force && projectCopyFresh(dir, fingerprint)) return undefined;
    const index = deps.loadIndex();
    const dsck = deps.loadDsck();
    return syncProjectCopy({ dir, storeRoot: deps.storeRoot, storeFingerprint: fingerprint, ...(index ? { index } : {}), ...(dsck ? { dsck } : {}), ...(deps.force ? { force: true } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed("", [{ message: `The project copy was not synced (${message}).`, next: "check the project folder is writable, then run Resolve again." }]);
  }
}
