import type { FigmaTarget } from "./figmaFileKey";

/**
 * Ingest scope.
 *
 * - `node` — the `node-id` on a shared screen / frame / section link
 * - `screens` — each top-level FRAME/SECTION/COMPONENT/COMPONENT_SET, one REST call at a time
 * - `file` — one `GET /v1/files/:key` (escape hatch)
 * - `auto` — `node` when the URL has a node-id, else `screens`
 */
export type FigmaIngestScope = "auto" | "node" | "screens" | "file";

export interface ScreenRef {
  id: string;
  name: string;
  type: string;
  pageId: string;
  pageName: string;
}

type RawNode = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  children?: unknown;
};

const SCREEN_TYPES = new Set(["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET"]);
const SKIP_INTO = new Set(["GROUP"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function resolveIngestScope(
  target: FigmaTarget,
  requested: FigmaIngestScope = "auto",
): Exclude<FigmaIngestScope, "auto"> {
  if (requested === "node") {
    if (!target.nodeIds.length) {
      throw new Error("Scope `node` needs a Figma URL with node-id=… (a shared screen, frame, or section).");
    }
    return "node";
  }
  if (requested === "screens" || requested === "file") return requested;
  return target.nodeIds.length ? "node" : "screens";
}

export function collectTopLevelScreens(document: unknown): ScreenRef[] {
  const root = asRecord(document);
  const screens: ScreenRef[] = [];

  const visit = (node: RawNode, pageId: string, pageName: string): void => {
    const type = asString(node.type) ?? "";
    const id = asString(node.id);
    const name = asString(node.name)?.trim() ?? "";
    if (SCREEN_TYPES.has(type) && id) {
      screens.push({ id, name, type, pageId, pageName });
      return;
    }
    if (SKIP_INTO.has(type)) {
      for (const child of asArray(node.children)) visit(child as RawNode, pageId, pageName);
    }
  };

  for (const page of asArray(root["children"])) {
    const canvas = page as RawNode;
    const pageId = asString(canvas.id);
    if (!pageId) continue;
    const pageName = asString(canvas.name) ?? pageId;
    for (const child of asArray(canvas.children)) visit(child as RawNode, pageId, pageName);
  }

  const byPage = new Map<string, ScreenRef[]>();
  for (const screen of screens) {
    const list = byPage.get(screen.pageId) ?? [];
    list.push(screen);
    byPage.set(screen.pageId, list);
  }
  for (const list of byPage.values()) {
    list.forEach((screen, index) => {
      if (!screen.name.trim()) screen.name = `${screen.pageName} ${index + 1}`;
    });
  }
  return screens;
}

/**
 * `GET /v1/files/:key/nodes` is a map of node id → subtree, not a DOCUMENT.
 * Wrap it so `adaptFigmaRestFile` can walk it like a file body.
 */
export function fileFromNodesResponse(
  body: unknown,
  pages?: Array<Pick<ScreenRef, "id" | "pageId" | "pageName">>,
): unknown {
  const record = asRecord(body);
  const nodes = asRecord(record["nodes"]);
  const pageById = new Map<
    string,
    { id: string; name: string; type: "CANVAS"; children: unknown[] }
  >();
  const components: Record<string, unknown> = {};
  const componentSets: Record<string, unknown> = {};
  const styles: Record<string, unknown> = {};
  const pageForNode = new Map((pages ?? []).map((ref) => [ref.id, ref]));
  const orphans: unknown[] = [];

  const mergeMaps = (target: Record<string, unknown>, extra: unknown) => {
    Object.assign(target, asRecord(extra));
  };

  for (const [id, entry] of Object.entries(nodes)) {
    if (!entry || typeof entry !== "object") continue;
    const item = asRecord(entry);
    if (item["err"]) continue;
    const document = item["document"];
    if (!document || typeof document !== "object") continue;

    mergeMaps(components, item["components"]);
    mergeMaps(componentSets, item["componentSets"]);
    mergeMaps(styles, item["styles"]);

    const node = asRecord(document);
    const type = asString(node["type"]);
    if (type === "DOCUMENT") {
      for (const child of asArray(node["children"])) {
        const childRec = asRecord(child);
        const childId = asString(childRec["id"]);
        if (!childId) continue;
        pageById.set(childId, {
          id: childId,
          name: asString(childRec["name"]) ?? childId,
          type: "CANVAS",
          children: asArray(childRec["children"]),
        });
      }
      continue;
    }
    if (type === "CANVAS") {
      const canvasId = asString(node["id"]) ?? id;
      pageById.set(canvasId, {
        id: canvasId,
        name: asString(node["name"]) ?? canvasId,
        type: "CANVAS",
        children: asArray(node["children"]),
      });
      continue;
    }

    const ref = pageForNode.get(id);
    if (ref) {
      let page = pageById.get(ref.pageId);
      if (!page) {
        page = { id: ref.pageId, name: ref.pageName, type: "CANVAS", children: [] };
        pageById.set(ref.pageId, page);
      }
      page.children.push(document);
      continue;
    }
    orphans.push(document);
  }

  if (orphans.length) {
    pageById.set("scope:0", {
      id: "scope:0",
      name: "Shared",
      type: "CANVAS",
      children: orphans,
    });
  }

  const children = [...pageById.values()];
  if (!children.length) {
    throw new Error("No Figma nodes in response.");
  }

  return {
    name: asString(record["name"]) ?? "Figma file",
    lastModified: record["lastModified"],
    version: record["version"],
    thumbnailUrl: record["thumbnailUrl"],
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children,
    },
    components,
    componentSets,
    styles,
  };
}
