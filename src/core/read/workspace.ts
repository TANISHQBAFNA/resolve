import { parseFigmaFileKey } from "@/core/ingestion/figmaFileKey";

/**
 * One Resolve workspace = one shared design-system brain across several
 * Figma files (library + product / client). Designers edit JSON under
 * `.resolve/workspace.json`. Never dump graph.json to agents.
 */

export const WORKSPACE_FILE_ROLES = ["library", "product", "client"] as const;
export type WorkspaceFileRole = (typeof WORKSPACE_FILE_ROLES)[number];

export interface WorkspaceFile {
  role: WorkspaceFileRole;
  key: string;
  url?: string;
  label?: string;
}

export interface WorkspaceManifest {
  version: 1;
  files: WorkspaceFile[];
}

export const emptyWorkspace = (): WorkspaceManifest => ({ version: 1, files: [] });

function asRole(raw: string): WorkspaceFileRole | undefined {
  const role = raw.trim().toLowerCase();
  switch (role) {
    case "library":
    case "product":
    case "client":
      return role;
    default:
      return undefined;
  }
}

function roleOf(raw: unknown): WorkspaceFileRole | undefined {
  if (typeof raw !== "string") return undefined;
  return asRole(raw);
}

/**
 * CLI `--role`. Omit the flag → undefined (caller defaults). A present
 * value that is not library | product | client throws — never a silent fallback.
 */
export function parseIngestRole(raw: string | undefined): WorkspaceFileRole | undefined {
  if (raw === undefined) return undefined;
  const role = asRole(raw);
  if (role) return role;
  const listed = WORKSPACE_FILE_ROLES.join(", ");
  const shown = raw.trim() || raw;
  throw new Error(`Unknown --role "${shown}". Valid roles: ${listed}.`);
}

function keyOf(record: Record<string, unknown>): string | undefined {
  const direct = typeof record["key"] === "string" ? record["key"].trim() : "";
  if (direct) return direct;
  const fileKey = typeof record["fileKey"] === "string" ? record["fileKey"].trim() : "";
  if (fileKey) return fileKey;
  const url = typeof record["url"] === "string" ? record["url"].trim() : "";
  if (!url) return undefined;
  return parseFigmaFileKey(url);
}

function parseOne(raw: unknown): WorkspaceFile[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const role = roleOf(record["role"]);
  const key = keyOf(record);
  if (!role || !key) return [];
  const url = typeof record["url"] === "string" ? record["url"].trim() : "";
  const label = typeof record["label"] === "string" ? record["label"].trim() : "";
  return [
    {
      role,
      key,
      ...(url ? { url } : {}),
      ...(label ? { label } : {}),
    },
  ];
}

/** Designer JSON in, workspace out. Unknown keys ignored. Bad files → empty list. */
export function parseWorkspaceFile(raw: unknown): WorkspaceManifest {
  if (Array.isArray(raw)) return { version: 1, files: raw.flatMap(parseOne) };
  if (!raw || typeof raw !== "object") return emptyWorkspace();
  const record = raw as Record<string, unknown>;
  const lists = record["files"] ?? record["workspace"];
  const files = Array.isArray(lists) ? lists.flatMap(parseOne) : [];
  return { version: 1, files };
}

/** Refuse a silent role swap. Same role or `--force-role` is fine. */
export function assertIngestRoleChange(
  manifest: WorkspaceManifest,
  key: string,
  role: WorkspaceFileRole,
  options: { forceRole?: boolean } = {},
): void {
  const needle = key.trim().toLowerCase();
  const existing = manifest.files.find((file) => file.key.toLowerCase() === needle);
  if (!existing || existing.role === role) return;
  if (options.forceRole) return;
  throw new Error(
    `File ${existing.key} is already ingested as ${existing.role}. ` +
      `This ingest would change it to ${role}, which would drop the ${existing.role} from cousins / recommend. ` +
      `Re-run without --role to keep ${existing.role}, edit .resolve/workspace.json, or pass --force-role.`,
  );
}

export function upsertWorkspaceFile(
  manifest: WorkspaceManifest,
  next: WorkspaceFile,
): WorkspaceManifest {
  const needle = next.key.toLowerCase();
  const files = manifest.files.filter((file) => file.key.toLowerCase() !== needle);
  files.push(next);
  return { version: 1, files };
}

export function removeWorkspaceFile(manifest: WorkspaceManifest, key: string): WorkspaceManifest {
  const needle = key.trim().toLowerCase();
  return { version: 1, files: manifest.files.filter((file) => file.key.toLowerCase() !== needle) };
}

export function libraryFiles(manifest: WorkspaceManifest): WorkspaceFile[] {
  return manifest.files.filter((file) => file.role === "library");
}

export function productFiles(manifest: WorkspaceManifest): WorkspaceFile[] {
  return manifest.files.filter((file) => file.role === "product" || file.role === "client");
}

export function libraryKeys(manifest: WorkspaceManifest): Set<string> {
  return new Set(libraryFiles(manifest).map((file) => file.key));
}

export function fileKeysOf(manifest: WorkspaceManifest): Set<string> {
  return new Set(manifest.files.map((file) => file.key));
}

/** Match a pack `files` entry (key or label) to a workspace file. No invent. */
export function matchWorkspaceFile(
  manifest: WorkspaceManifest,
  needle: string,
): WorkspaceFile | undefined {
  const raw = needle.trim().toLowerCase();
  if (!raw) return undefined;
  const exact = manifest.files.find(
    (file) => file.key.toLowerCase() === raw || file.label?.toLowerCase() === raw,
  );
  return exact;
}

export function isLibraryFileKey(manifest: WorkspaceManifest | undefined, fileKey?: string): boolean {
  if (!manifest || !fileKey) return false;
  const needle = fileKey.toLowerCase();
  return manifest.files.some((file) => file.role === "library" && file.key.toLowerCase() === needle);
}

export function defaultIngestRole(manifest: WorkspaceManifest): WorkspaceFileRole {
  return libraryFiles(manifest).length ? "product" : "library";
}

export function describeRole(role: WorkspaceFileRole): string {
  switch (role) {
    case "library":
      return "design system library";
    case "product":
      return "product file";
    case "client":
      return "client file";
    default: {
      const _never: never = role;
      return _never;
    }
  }
}
