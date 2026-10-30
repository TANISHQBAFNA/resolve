import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import type { SociProposal, SockState } from "./sock";

/**
 * A copy of the components, SOCK and SOCI that Resolve keeps in each project
 * folder (`<project>/.resolve/local/`). Every run syncs it from the store:
 * components are added or updated, removed ones are marked stale (never
 * deleted), SOCK is refreshed, and SOCI keeps what a person approved. An
 * approved proposal that changed in the store is flagged, not re-approved.
 * Sync never approves anything and never stops a run: problems are warnings.
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

export interface LocalSociProposal {
  id: string;
  type?: string;
  status: SociProposal["status"];
  summary: string;
  fingerprint: string;
  proposal: SociProposal;
  /** Approved here, then the store's proposal changed. The approved content is kept; the new one waits in `incoming`. */
  changed?: true;
  changedAt?: string;
  incoming?: SociProposal;
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
  sock: { facts: number; staleFacts: number };
  soci: { pending: number; approved: number; rejected: number; changedApproved: number; added: number };
  warnings: ProjectCopyWarning[];
}

interface Meta {
  version: number;
  syncedAt: string;
  store: string;
  storeFingerprint?: string;
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

const PROJECT_MARKERS = [".git", "package.json", ".resolve"];

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/**
 * `<project>/.resolve/local`, or undefined when there is no project to write into
 * (RESOLVE_PROJECT_COPY=0, the home folder itself, or inside the store).
 */
export function projectCopyDir(
  cwd: string,
  env: { RESOLVE_PROJECT_COPY?: string; RESOLVE_PROJECT_DIR?: string; HOME?: string; USERPROFILE?: string },
  storeRoot: string,
): string | undefined {
  if (env.RESOLVE_PROJECT_COPY?.trim() === "0") return undefined;
  const home = resolve(env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
  const explicit = env.RESOLVE_PROJECT_DIR?.trim();
  let root = resolve(explicit || cwd);
  if (!explicit) {
    for (let dir = root; dir !== home; ) {
      if (PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
        root = dir;
        break;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (root === home || root === resolve("/")) return undefined;
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

function proposalFingerprint(proposal: SociProposal): string {
  const { status: _status, createdAt: _created, updatedAt: _updated, decisionNote: _note, ...content } = proposal;
  return hash(content);
}

function proposalMasterIds(proposal: SociProposal): string[] {
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
  sock?: SockState;
  now?: string;
}

/** Skip the sync when the store has not changed since the last one and the copy is complete. */
export function projectCopyFresh(dir: string, storeFingerprint: string | undefined): boolean {
  if (!storeFingerprint) return false;
  const meta = readJson<Meta>(join(dir, "meta.json"));
  return Boolean(
    meta?.storeFingerprint === storeFingerprint &&
      ["components.json", "sock.json", "soci.json"].every((name) => existsSync(join(dir, name))),
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

  // SOCK: refreshed from the store every run.
  const sock = input.sock;
  const facts = sock?.facts ?? [];
  const staleFacts = facts.filter((fact) => staleIds.has(fact.masterId)).length;
  if (staleFacts) {
    warnings.push({
      message: `${staleFacts} usage fact${staleFacts === 1 ? "" : "s"} in SOCK point at stale components.`,
      next: "verify the screens that use them again so SOCK learns the replacement.",
    });
  }

  // SOCI: mirror the store, keep what was approved here, flag approved ones that changed. Never approve.
  const oldSoci = readJson<{ proposals?: LocalSociProposal[] }>(join(dir, "soci.json"))?.proposals ?? [];
  const oldById = new Map(oldSoci.map((row) => [row.id, row]));
  const storeProposals = sock?.proposals ?? [];
  const sociRows: LocalSociProposal[] = [];
  const sociCounts = { pending: 0, approved: 0, rejected: 0, changedApproved: 0, added: 0 };
  const inStore = new Set<string>();
  for (const proposal of storeProposals) {
    inStore.add(proposal.id);
    const fingerprint = proposalFingerprint(proposal);
    const old = oldById.get(proposal.id);
    if (!old) sociCounts.added += 1;
    let row: LocalSociProposal;
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
    sociRows.push(row);
  }
  for (const old of oldSoci) {
    if (inStore.has(old.id) || old.status !== "approved") continue;
    sociRows.push({ ...old, missingFromStore: true });
  }
  for (const row of sociRows) {
    const staleId = proposalMasterIds(row.proposal).find((id) => staleIds.has(id));
    if (staleId) row.staleComponent = staleId;
    else delete row.staleComponent;
    if (row.status === "approved") sociCounts.approved += 1;
    else if (row.status === "rejected") sociCounts.rejected += 1;
    else sociCounts.pending += 1;
    if (row.changed) sociCounts.changedApproved += 1;
  }
  if (sociCounts.changedApproved) {
    const ids = sociRows.filter((row) => row.changed).map((row) => row.id);
    warnings.push({
      message: `${ids.length} approved SOCI proposal${ids.length === 1 ? "" : "s"} changed since approval (${ids.join(", ")}). The approved version is kept; the change is not approved.`,
      next: "show the change to the designer; approve it again with `resolve approve <id> --who <name>` or reject it.",
    });
  }
  const staleRules = sociRows.filter((row) => row.status === "approved" && row.staleComponent).map((row) => row.id);
  if (staleRules.length) {
    warnings.push({
      message: `Approved SOCI ${staleRules.join(", ")} name${staleRules.length === 1 ? "s" : ""} a stale component.`,
      next: "ask the designer to re-point or reject the rule; Resolve does not change approved rules on its own.",
    });
  }

  const meta: Meta = {
    version: PROJECT_COPY_VERSION,
    syncedAt: now,
    store: input.storeRoot,
    ...(input.storeFingerprint ? { storeFingerprint: input.storeFingerprint } : {}),
  };
  writeJson(join(dir, "components.json"), { version: PROJECT_COPY_VERSION, syncedAt: now, components: rows });
  writeJson(join(dir, "sock.json"), {
    version: PROJECT_COPY_VERSION,
    syncedAt: now,
    threshold: sock?.threshold,
    facts,
    freshness: sock?.freshness ?? {},
    corrections: sock?.corrections ?? [],
  });
  writeJson(join(dir, "soci.json"), { version: PROJECT_COPY_VERSION, syncedAt: now, proposals: sociRows });
  writeJson(join(dir, "meta.json"), meta);

  return {
    dir,
    synced: true,
    components: counts,
    sock: { facts: facts.length, staleFacts },
    soci: sociCounts,
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
  if (report.soci.added) parts.push(`${report.soci.added} new SOCI`);
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
  loadSock: () => SockState | undefined;
  force?: boolean;
}

/** Keep `<project>/.resolve/local` in step with the store. Never throws: a failure is a warning with a next step. */
export function runProjectSync(deps: ProjectSyncDeps): ProjectCopyReport | undefined {
  try {
    const dir = projectCopyDir(deps.cwd, deps.env, deps.storeRoot);
    if (!dir || !deps.graphExists) return undefined;
    const fingerprint = deps.storeFingerprint();
    if (!deps.force && projectCopyFresh(dir, fingerprint)) return undefined;
    const index = deps.loadIndex();
    const sock = deps.loadSock();
    return syncProjectCopy({ dir, storeRoot: deps.storeRoot, storeFingerprint: fingerprint, ...(index ? { index } : {}), ...(sock ? { sock } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      dir: "",
      synced: false,
      components: { total: 0, added: 0, updated: 0, stale: 0, newlyStale: 0, revived: 0 },
      sock: { facts: 0, staleFacts: 0 },
      soci: { pending: 0, approved: 0, rejected: 0, changedApproved: 0, added: 0 },
      warnings: [{ message: `The project copy was not synced (${message}).`, next: "check the project folder is writable, then run Resolve again." }],
    };
  }
}
