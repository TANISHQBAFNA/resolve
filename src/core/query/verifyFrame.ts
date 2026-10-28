/** Verify a frame against the learned graph. */
import { contextCarriesMasterIds, contextIdentityFor, elementComponentIds, masterByIdOrKey } from "@/core/ingestion/designContextIds";
import { assertVerifyTextInput, scopedOverlay, TEXT_NO_FRAME, textStampsFrom } from "@/core/ingestion/textStamps";
import type { GraphNode } from "@/core/model";
import { setOf } from "@/core/rules/family";
import { isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import { type BindRulesFile, verifyBindRules } from "./bindRules";
import { attachProperUse, checkProperUse } from "./properUse";
import { briefNode, EXACT_COMPONENT_HINT, LAYER_NAME_GUESS } from "./cardCopy";
import { clipHint, fitCardAfterCost, NAME_FLOOR, shrinkNameFields, WARNING_OVERFLOW } from "./cardFit";
import { useText } from "./codeMap";
import { framePropertyFindings } from "./componentProperties";
import { type AgentCost, withCost } from "./cost";
import { type ContentWarning, frameContentWarnings, instanceTextLayers, type TextChecked } from "./examples";
import type { GraphIndex } from "./GraphIndex";
import { missingNodeSentence, readFigmaLink } from "./learnedLink";
import { isMasterType, MASTER_TYPES, placeableMasterByName, realMastersNamed, variantCardName } from "./masterNames";
import { matchesFigmaId, matchesStampedId, resolveNode, resolveNodeExact } from "./nodeLookup";
import { designerPlacedInstances, hiddenUnder } from "./placed";
import { isPrivateMaster, wholeNameTypo } from "./recommendLexicon";
import { asMaster, type LibraryRules, type RecommendContext, REFRESH_HINT, ruleMatches } from "./recommendSupport";
import { codeMapView, replacementOf } from "./replacements";
import { searchNodes } from "./search";
import type { SockState } from "./sock";
import type { WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";

export type VerifyReason = "not-in-graph" | "not-a-master" | "denied" | "private";
export type UnresolvedReason = "unresolved-instance" | "frame-not-in-graph" | "not-exact" | "file-not-learned";
export interface VerifyResolved {
  given: string;
  name?: string;
  id?: string;
  fileKey?: string;
}
export interface VerifyHit {
  name: string;
  given?: string;
  id?: string;
  figmaNodeId?: string;
  fileKey?: string;
  reason?: VerifyReason | UnresolvedReason;
  status?: GraphNode["status"];
  didYouMean?: { name: string; id?: string; fileKey?: string };
}
function uniqueNameTypo(index: GraphIndex, ask: string): GraphNode | undefined {
  const needle = ask.trim().toLowerCase();
  if (!needle) return undefined;
  const winners: GraphNode[] = [];
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (isRetired(index, node) || isPrivateMaster(index, node)) continue;
    if (isNameInferredMaster(node)) continue;
    if (!wholeNameTypo(needle, node.name)) continue;
    winners.push(node);
  }
  return winners.length === 1 ? winners[0] : undefined;
}
function labelDiffers(layerName: string, masterName: string): boolean {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const layer = norm(layerName);
  const master = norm(masterName);
  if (!layer || !master || layer === master) return false;
  const family = master.split(" / ")[0] ?? master;
  return layer !== family;
}
function suppliedIdentity(index: GraphIndex, given: string, node: GraphNode): boolean {
  const trimmed = given.trim();
  if (node.id === trimmed) return true;
  if (matchesFigmaId(node, trimmed)) return true;
  return matchesStampedId(node, trimmed, index.graph.fileKey);
}
const LOOKALIKE_TYPES = new Set(["LAYER", "TEXT_LAYER", "MEDIA_LAYER"]);
function lookalikeLayers(index: GraphIndex, frame: GraphNode): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const node of index.getDescendants(frame.id)) {
    if (!LOOKALIKE_TYPES.has(node.type)) continue;
    if (index.getAncestors(node.id).some((ancestor) => ancestor.type === "COMPONENT_INSTANCE")) continue;
    const name = node.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (!realMastersNamed(index, name).length) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}
function uncheckedLine(count: number, names: string[]): string {
  if (!count) return "";
  const shown = names.slice(0, 2);
  const label = count === 1 ? "1 unchecked look-alike" : `${count} unchecked look-alikes`;
  return shown.length ? `${label} (${shown.join(", ")}).` : `${label}.`;
}
/**
 * Thin post-draw check. Pass iff every placed component is an approved
 * (in-graph, not deprecated) master. Deterministic — no LLM.
 */
export function verifyFrame(index: GraphIndex, input: VerifyInput = {}) {
  const used: GraphNode[] = [];
  const view = codeMapView(index);
  const card = verifyFrameCard(index, input, used, view);
  const frameReport = checkProperUse(index, input.frame, {
    a11y: input.context?.constraints?.a11y,
    workspace: input.workspace,
    designContext: input.designContext,
  });
  const withUse = (value: typeof card) => attachProperUse(value, frameReport, { all: input.all === true });
  if (!view) return withUse(card);
  const names = new Set<string>();
  const rows = [...new Set(used)].flatMap((node) => {
    const name = setOf(index, node)?.name ?? node.name;
    if (!view.retired(node) || names.has(name)) return [];
    names.add(name);
    const use = replacementOf(index, node, view.twin);
    return [`retired ${name} -> ${useText(use?.node.name, use?.guess)}`];
  });
  return withUse(rows.length ? withRetiredRows(card, rows) : card);
}
/**
 * Show every retired part used (up to 3, then "+N more") inside 600 characters. Lower-value text goes first:
 * timestamp, renamed list, look-alikes, warnings, text reason, frame detail, hint after its first sentence,
 * hit detail, echoed names, then detail on invents and unresolved. The fail reasons stay. If even one row cannot fit, say how to list them. That pointer is the floor: it stays even when the failing parts alone push the card past 600.
 */
function withRetiredRows<T extends object>(card: T, rows: string[]): T {
  type Hits = Array<Record<string, unknown>>;
  type Loose = Record<string, unknown> & { deprecated?: Hits; invents?: Hits; unresolved?: Hits; frame?: Record<string, unknown> };
  const trims: Array<(c: Loose) => void> = [
    (c) => void delete c["builtAt"],
    (c) => (delete c["renamed"], delete c["renamedNote"]),
    (c) => void delete c["unchecked"],
    (c) => (delete c["warnings"], delete c["warningNote"]),
    (c) => void delete c["textReason"],
    (c) => c.frame && (c.frame = { name: c.frame["name"] }),
    (c) => (c["hint"] = String(c["hint"]).split(/(?<=\.) /)[0]),
    (c) => c.deprecated && (c.deprecated = c.deprecated.map(({ name, id }) => ({ name, id }))),
    (c) => c.deprecated && (c.deprecated = c.deprecated.map(({ name }) => ({ name }))),
    (c) => void delete c["resolved"],
    (c) => (c.invents = c.invents?.map(({ name }) => ({ name })), c.unresolved = c.unresolved?.map(({ name }) => ({ name }))),
  ];
  const fit = (retired: string | string[]) => {
    const c: Loose = structuredClone({ ...card, retired }) as Loose;
    for (const trim of [() => {}, ...trims]) {
      trim(c);
      const priced = repriced(c);
      if (JSON.stringify(priced).length <= 600) return priced as unknown as T;
    }
  };
  for (let k = Math.min(rows.length, 3); k >= 1; k -= 1) {
    const fitted = fit([...rows.slice(0, k), ...(rows.length > k ? [`+${rows.length - k} more, run \`resolve code-map --retired\` for the list`] : [])]);
    if (fitted) return fitted;
  }
  const pointer = `+${rows.length} retired, run \`resolve code-map --retired\` for the list`;
  return fit(pointer) ?? (repriced({ ...card, retired: pointer }) as unknown as T);
}
type VerifyInput = {
  frame?: string;
  components?: string[];
  rules?: LibraryRules;
  context?: RecommendContext;
  bindRules?: BindRulesFile;
  sock?: SockState;
  workspace?: WorkspaceManifest;
  placeholders?: string[];
  /** Figma get_design_context, or get_metadata that includes characters. */
  designContext?: unknown;
  /** Agent-passed text: `{ nodeId, characters }` list, id→string map, or `{ texts }`. */
  texts?: unknown;
  /** Every proper-use finding. The card may exceed 600 characters. */
  all?: boolean;
};
function verifyFrameCard(index: GraphIndex, input: VerifyInput, used: GraphNode[], view?: ReturnType<typeof codeMapView>) {
  assertVerifyTextInput(input.designContext, "designContext");
  assertVerifyTextInput(input.texts, "texts");
  const invents: VerifyHit[] = [];
  const deprecatedHits: VerifyHit[] = [];
  const unresolved: VerifyHit[] = [];
  const resolved: VerifyResolved[] = [];
  const approvedIds = new Set<string>();
  const nameOnlyIds = new Set<string>();
  const seenInvent = new Set<string>();
  const seenDeprecated = new Set<string>();
  const seenUnresolved = new Set<string>();

  const mergedRules: LibraryRules = {
    allow: input.rules?.allow ?? input.context?.libraryRules?.allow,
    deny: [
      ...(input.rules?.deny ?? []),
      ...(input.context?.libraryRules?.deny ?? []),
    ].filter((item, pos, list) => item.trim().length > 0 && list.indexOf(item) === pos),
  };
  const allow = mergedRules.allow?.filter((item) => item.trim().length > 0);
  const deny = mergedRules.deny?.filter((item) => item.trim().length > 0);
  const allowList = allow?.length ? allow : undefined;
  const denyList = deny?.length ? deny : undefined;

  const pushUnique = (list: VerifyHit[], seen: Set<string>, hit: VerifyHit, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    list.push(hit);
  };

  const blockedByRules = (master: GraphNode, given: string): boolean => {
    if (denyList) {
      const denied =
        denyList.some((rule) => ruleMatches(index, master, rule)) ||
        denyList.some((rule) => rule.trim().toLowerCase() === given.trim().toLowerCase());
      if (denied) return true;
    }
    if (allowList) {
      const allowed =
        allowList.some((rule) => ruleMatches(index, master, rule)) ||
        allowList.some((rule) => rule.trim().toLowerCase() === given.trim().toLowerCase());
      if (!allowed) return true;
    }
    return false;
  };

  const fileOf = (node: GraphNode) => nodeFileKey(node, index.graph.fileKey);

  const stampHit = (node: GraphNode, extra: Omit<VerifyHit, "name" | "id" | "figmaNodeId" | "fileKey"> = {}): VerifyHit => {
    const fileKey = fileOf(node);
    return {
      name: variantCardName(index, node),
      id: node.id,
      figmaNodeId: node.figmaNodeId,
      ...(fileKey ? { fileKey } : {}),
      ...extra,
    };
  };

  const realMasterByName = (name: string): GraphNode | undefined =>
    placeableMasterByName(index, name, input.workspace);

  const considerMaster = (master: GraphNode, given: string) => {
    if (isNameInferredMaster(master)) {
      const real = realMasterByName(master.name) ?? realMasterByName(given);
      if (real && real.id !== master.id) {
        considerMaster(real, given);
        return;
      }
      pushUnique(
        invents,
        seenInvent,
        stampHit(master, { reason: "not-a-master", given }),
        `invent:${master.id}`,
      );
      return;
    }
    if (isPrivateMasterName(master.name)) {
      pushUnique(invents, seenInvent, stampHit(master, { reason: "private", given }), `private:${master.id}`);
      return;
    }
    if (blockedByRules(master, given)) {
      pushUnique(invents, seenInvent, stampHit(master, { reason: "denied" }), `denied:${master.id}`);
      return;
    }
    if (isRetired(index, master) || view?.retired(master)) {
      pushUnique(deprecatedHits, seenDeprecated, stampHit(master, { status: "deprecated" }), master.id);
      return;
    }
    approvedIds.add(master.id);
  };

  let frameNode: GraphNode | undefined;
  let nameOnly = false;
  let idChecked = 0;
  const renamed: Array<{ node: string; layerName: string; masterName: string }> = [];
  const idsInContext = contextCarriesMasterIds(input.designContext);
  const componentIds = elementComponentIds(input.designContext);
  const frameName = input.frame?.trim();
  let linkHint: string | undefined;
  if (frameName) {
    const link = readFigmaLink(index, frameName);
    if (link && !link.ok) {
      linkHint = link.message;
      pushUnique(
        unresolved,
        seenUnresolved,
        { name: frameName, reason: link.kind === "not-learned" ? "file-not-learned" : "frame-not-in-graph" },
        `link:${frameName}`,
      );
    } else if (link?.ok) {
      frameNode = resolveNode(index, frameName);
      if (!frameNode) {
        linkHint = missingNodeSentence(link.fileKey, link.nodeIds[0] ?? "");
        pushUnique(
          unresolved,
          seenUnresolved,
          { name: link.nodeIds[0] ?? frameName, reason: "frame-not-in-graph" },
          `link:${frameName}`,
        );
      }
    } else {
      frameNode = resolveNode(index, frameName);
    }
    if (!frameNode) {
      if (!link) {
        pushUnique(
          unresolved,
          seenUnresolved,
          { name: frameName, reason: "frame-not-in-graph" },
          `frame:${frameName}`,
        );
      }
    } else {
      const libraryNode =
        isMasterType(frameNode.type) || frameNode.type === "PAGE" || frameNode.type === "SECTION";
      const instances = libraryNode ? [] : designerPlacedInstances(index, frameNode.id);
      for (const instance of instances) {
        if (hiddenUnder(index, instance, frameNode.id)) continue;
        const main = index.getMainComponent(instance.id);
        if (!main) {
          pushUnique(
            unresolved,
            seenUnresolved,
            stampHit(instance, { reason: "unresolved-instance" }),
            instance.id,
          );
          continue;
        }
        if (isNameInferredMaster(main)) {
          if (idsInContext) {
            const boundId = contextIdentityFor(componentIds, instance.figmaNodeId);
            const bound = boundId ? masterByIdOrKey(index.graph, boundId) : undefined;
            const boundMaster = bound ? asMaster(index, bound) : undefined;
            if (boundMaster && !isNameInferredMaster(boundMaster)) {
              considerMaster(boundMaster, instance.name);
              idChecked += 1;
              const boundLabel = variantCardName(index, boundMaster);
              if (labelDiffers(instance.name, boundLabel)) {
                renamed.push({
                  node: instance.figmaNodeId ?? instance.id,
                  layerName: instance.name,
                  masterName: boundLabel,
                });
              }
              continue;
            }
            // Claimed id missing, spoofed, name-in-slot, or not a real master: stay a guess.
          }
          nameOnly = true;
          continue;
        }
        const masterLabel = variantCardName(index, main);
        considerMaster(main, main.name);
        idChecked += 1;
        if (labelDiffers(instance.name, masterLabel)) {
          renamed.push({
            node: instance.figmaNodeId ?? instance.id,
            layerName: instance.name,
            masterName: masterLabel,
          });
        }
      }
    }
  }

  for (const raw of input.components ?? []) {
    const given = raw.trim();
    if (!given) continue;
    const node = resolveNodeExact(index, given);
    if (!node) {
      resolved.push({ given });
      const near = searchNodes(index, given, { limit: 8 })
        .map((hit) => asMaster(index, hit.node))
        .find((node): node is GraphNode => Boolean(node));
        const suggested =
        near && !isNameInferredMaster(near) ? near : uniqueNameTypo(index, given);
      if (suggested && !isNameInferredMaster(suggested)) {
        const fileKey = fileOf(suggested);
        pushUnique(
          unresolved,
          seenUnresolved,
          {
            name: given,
            given,
            reason: "not-exact",
            didYouMean: {
              name: variantCardName(index, suggested),
              id: suggested.id,
              ...(fileKey ? { fileKey } : {}),
            },
          },
          `fuzzy:${given.toLowerCase()}`,
        );
        continue;
      }
      pushUnique(invents, seenInvent, { name: given, given, reason: "not-in-graph" }, `invent:${given.toLowerCase()}`);
      continue;
    }
    const master = asMaster(index, node);
    const givenIsIdentity = suppliedIdentity(index, given, master ?? node);
    if (givenIsIdentity && master && !isNameInferredMaster(master)) {
      const fileKey = fileOf(master);
      resolved.push({
        given,
        name: variantCardName(index, master),
        id: master.id,
        ...(fileKey ? { fileKey } : {}),
      });
      considerMaster(master, given);
      idChecked += 1;
      continue;
    }
    const preferred =
      placeableMasterByName(index, given, input.workspace) ??
      (master ? placeableMasterByName(index, master.name, input.workspace) : undefined);
    const echoed = preferred ?? master ?? node;
    const fileKey = fileOf(echoed);
    resolved.push({
      given,
      name: variantCardName(index, echoed),
      id: echoed.id,
      ...(fileKey ? { fileKey } : {}),
    });
    if (!master && !preferred) {
      pushUnique(invents, seenInvent, stampHit(node, { reason: "not-a-master", given }), `invent:${node.id}`);
      continue;
    }
    const identityNode = preferred ?? master ?? node;
    const byIdentity = suppliedIdentity(index, given, identityNode);
    if (!preferred && master && isNameInferredMaster(master)) {
      const before = new Set(approvedIds);
      considerMaster(master, given);
      if (approvedIds.size > before.size) {
        nameOnly = true;
        for (const id of approvedIds) if (!before.has(id)) nameOnlyIds.add(id);
      }
      else if (byIdentity) idChecked += 1;
      continue;
    }
    if (preferred) considerMaster(preferred, given);
    else if (master) considerMaster(master, given);
    if (byIdentity) idChecked += 1;
  }

  const frameKey = frameNode ? fileOf(frameNode) : undefined;
  const layers = frameNode
    ? instanceTextLayers(index, frameNode.id).filter((layer) => {
        const key = fileOf(layer);
        return !frameKey || !key || key === frameKey;
      })
    : [];
  const applied = frameNode
    ? scopedOverlay(layers, textStampsFrom(input.designContext), textStampsFrom(input.texts))
    : undefined;
  const content = frameNode
    ? frameContentWarnings(index, frameNode.id, input.placeholders, { overlay: applied?.overlay })
    : { warnings: [] as ContentWarning[], blocking: false, textChecked: false as const, textReason: TEXT_NO_FRAME };
  const propertyFindings = frameNode ? framePropertyFindings(index, frameNode) : { flags: [], notes: [] };
  const clean = invents.length === 0 && deprecatedHits.length === 0 && unresolved.length === 0;
  const placed: GraphNode[] = [...approvedIds]
    .map((id) => index.getNode(id))
    .filter((node): node is GraphNode => Boolean(node));
  used.push(
    ...placed,
    ...deprecatedHits.flatMap((hit) => (hit.id ? [index.getNode(hit.id)] : [])).filter((node): node is GraphNode => Boolean(node)),
  );
  // With all: true only, so the default card keeps its locked size. Problem layers are already listed under invents, deprecated and unresolved.
  // One row per checked component, one status each. Wrong cousin and missing state come from check_cousins and recipe, not here.
  const layerRows = [
    ...placed.map((node) => ({ name: variantCardName(index, node), id: node.id, status: nameOnlyIds.has(node.id) ? "name-only" : "pass" })),
    ...deprecatedHits.map((hit) => ({ name: hit.name, ...(hit.id ? { id: hit.id } : {}), status: "retired" })),
    ...invents.map((hit) => ({ name: hit.name, ...(hit.id ? { id: hit.id } : {}), status: "invented" })),
    ...unresolved.map((hit) => ({ name: hit.given ?? hit.name, status: "unresolved" })),
  ];
  const ruleFailure = input.bindRules?.rules.length
    ? verifyBindRules(index, input.bindRules, placed, {
        domain: input.context?.domain,
        journey: input.context?.journey?.screenJob || input.context?.journey?.step,
        product: input.context?.product?.name || input.context?.product?.id,
        pack: input.context?.id,
        frameName: frameNode?.name ?? input.frame,
        sock: input.sock,
      })
    : undefined;
  const bindPass = !ruleFailure;
  const propertyFail = propertyFindings.flags.length > 0;
  const ok = clean && bindPass && !content.blocking && !propertyFail;
  const nameOnlyPass = ok && nameOnly;
  const verified = ok && idChecked > 0 && !nameOnly;
  const nothingChecked = ok && idChecked === 0 && !nameOnly;
  const librarySubject =
    Boolean(frameNode) &&
    (isMasterType(frameNode!.type) || frameNode!.type === "PAGE" || frameNode!.type === "SECTION");
  const lookalikes = frameNode ? lookalikeLayers(index, frameNode) : [];
  const uncheckedNames = lookalikes.slice(0, 2);
  const lookalikeNote = uncheckedLine(lookalikes.length, uncheckedNames);
  const bindHint = ruleFailure
    ? `Fail — bind rule ${ruleFailure.rule}: ${ruleFailure.reason}.${
        ruleFailure.expected ? ` Place ${ruleFailure.expected.name} (${ruleFailure.expected.id}).` : ""
      }`
    : undefined;
  const pending = input.sock?.proposals.filter((row) => row.status === "pending").length ?? 0;
  const hint = linkHint
    ? linkHint
    : nameOnlyPass
    ? EXACT_COMPONENT_HINT
    : verified
      ? [
          renamed.length ? "Verified. Label differs." : "Verified.",
          lookalikeNote,
          REFRESH_HINT,
        ]
          .filter(Boolean)
          .join(" ")
      : nothingChecked
        ? approvedIds.size > 0
          ? "Named components are in the library. No placed screen was checked."
          : librarySubject
          ? "This is a library node, not a product screen. Run verify on a product frame."
          : ["Nothing checked.", lookalikeNote, "No component id or key."].filter(Boolean).join(" ")
          : content.blocking && clean && bindPass
          ? `Fail — placeholder text left in a placed instance. ${REFRESH_HINT}`
          : propertyFail && clean && bindPass
            ? `Fail — a property value is not allowed. ${REFRESH_HINT}`
            : bindHint ??
              `Fail — invents/deprecated/unresolved listed. Replace invents with recommend() figmaNodeIds. ${REFRESH_HINT}`;
  const pendingHint = pending ? `pending improvements: ${pending}.` : undefined;
  const fullHint = pendingHint ? `${hint} ${pendingHint}` : hint;
  // An invented part is listed under invents only, never as resolved. A near miss keeps its given name beside its did-you-mean.
  const invented = new Set(invents.map((hit) => hit.id ?? `given:${hit.given ?? hit.name}`));
  const resolvedParts = resolved.filter((row) => !invented.has(row.id ?? `given:${row.given}`));
  const base = {
    pass: verified,
    ...(nameOnlyPass
      ? { result: "name-only" as const }
      : verified
        ? { result: "verified" as const }
        : nothingChecked
          ? { result: "nothing checked" as const }
          : {}),
    ...(nameOnly ? { nameOnly: true as const, guess: LAYER_NAME_GUESS } : {}),
    ...(renamed.length ? { labelDiffers: true as const } : {}),
    approved: approvedIds.size,
    ...(input.all === true && layerRows.length ? { layers: layerRows } : {}),
    resolved: resolvedParts,
    invents,
    deprecated: deprecatedHits,
    unresolved,
    ...(propertyFindings.flags.length ? { propertyFlags: propertyFindings.flags } : {}),
    ...(propertyFindings.notes.length ? { propertyNotes: propertyFindings.notes } : {}),
    ...(ruleFailure ? { ruleFailure } : {}),
    frame: frameNode
      ? {
          ...briefNode(frameNode),
          ...(fileOf(frameNode) ? { fileKey: fileOf(frameNode) } : {}),
        }
      : undefined,
    builtAt: index.graph.builtAt,
    hint: fullHint,
    ...(pending ? { pendingImprovements: pending } : {}),
  };
  const textMeta = {
    textChecked: content.textChecked,
    textReason: content.textReason,
    ...(applied && applied.textOverrides > 0 ? { textOverrides: applied.textOverrides } : {}),
  };
  const renamedCap = 5;
  const renamedLimit = Math.min(renamedCap, renamed.length);
  const publishRenamed = (shownCount: number, showLookalikeNames: boolean) => {
    const shown = renamed.slice(0, shownCount);
    const hidden = renamed.length - shownCount;
    const attempt = {
      ...base,
      ...(shown.length ? { renamed: shown } : {}),
      ...(shown.length && hidden > 0 ? { renamedNote: `+${hidden} more` } : {}),
      ...(lookalikes.length
        ? {
            unchecked: {
              count: lookalikes.length,
              ...(showLookalikeNames && uncheckedNames.length ? { names: uncheckedNames } : {}),
            },
          }
        : {}),
    };
    return stampTextCheck(
      fitCardAfterCost(structuredClone(attempt), input.bindRules?.warnings, content.warnings, 600),
      textMeta,
    );
  };
  const fitsRenamed = (
    stamped: ReturnType<typeof publishRenamed>,
    shown: Array<{ node: string; layerName: string; masterName: string }>,
  ) =>
    JSON.stringify(stamped).length <= 600 &&
    stamped.hint === fullHint &&
    JSON.stringify(stamped.renamed ?? []) === JSON.stringify(shown) &&
    (renamed.length <= shown.length || Boolean(stamped.renamedNote));
  let published = publishRenamed(renamedLimit, true);
  if (fitsRenamed(published, renamed.slice(0, renamedLimit))) return published;
  published = publishRenamed(renamedLimit, false);
  if (fitsRenamed(published, renamed.slice(0, renamedLimit))) return published;
  for (let shownCount = renamedLimit - 1; shownCount >= 0; shownCount -= 1) {
    const shown = renamed.slice(0, shownCount);
    published = publishRenamed(shownCount, false);
    if (fitsRenamed(published, shown) || shownCount === 0) break;
  }
  return published;
}
function repriced<T extends object>(value: T): Omit<T, "cost"> & { cost: AgentCost } {
  const rest = { ...value } as T & { cost?: unknown };
  delete rest.cost;
  return withCost(rest);
}
type Stamped<T> = T & { textChecked: TextChecked; textReason?: string; textOverrides?: number };
function warningMore(note: string | undefined): number {
  const match = note?.match(/^and (\d+) more warnings$/);
  return match ? Number(match[1]) : 0;
}
function stampTextCheck<T extends { hint: string }>(
  fitted: T,
  content: { textChecked: TextChecked; textReason?: string; textOverrides?: number },
): Stamped<T> {
  const budget = 600;
  const fits = (value: object) => JSON.stringify(value).length <= budget;
  const price = (value: object): Stamped<T> => repriced(value) as unknown as Stamped<T>;
  const seed = { ...fitted } as T & {
    warnings?: ContentWarning[];
    warningNote?: string;
    cost?: unknown;
    textReason?: string;
    textOverrides?: number;
    textChecked?: TextChecked;
    unchecked?: { count?: number; names?: string[] };
    renamedNote?: string;
    labelDiffers?: true;
    propertyNotes?: unknown;
    frame?: { name?: string };
  };
  delete seed.cost;
  let hint = seed.hint;
  let warnings = seed.warnings ? [...seed.warnings] : undefined;
  let warningNote = seed.warningNote;
  let keepReason = content.textChecked !== true && Boolean(content.textReason);
  let keepOverrides = Boolean(content.textOverrides && content.textOverrides > 0);
  let extra = warningMore(warningNote);

  const build = (): Stamped<T> => {
    const next: Record<string, unknown> = { ...seed, hint };
    delete next["cost"];
    delete next["warnings"];
    delete next["warningNote"];
    delete next["textReason"];
    delete next["textOverrides"];
    delete next["textChecked"];
    next["hint"] = hint;
    next["textChecked"] = content.textChecked;
    if (keepReason && content.textReason) next["textReason"] = content.textReason;
    if (keepOverrides && content.textOverrides) next["textOverrides"] = content.textOverrides;
    if (warnings && warnings.length > 0) next["warnings"] = warnings;
    if (warningNote) next["warningNote"] = warningNote;
    return price(next);
  };

  let card = build();
  if (fits(card)) return card;
  keepReason = false;
  card = build();
  if (fits(card)) return card;
  keepOverrides = false;
  card = build();
  if (fits(card)) return card;
  const unchecked = seed.unchecked;
  if (unchecked?.names?.length) {
    seed.unchecked = { count: unchecked.count };
    card = build();
    if (fits(card)) return card;
  }
  const frame = seed.frame as { name?: string } | undefined;
  while (!fits(card) && frame && typeof frame.name === "string" && frame.name.length > NAME_FLOOR) {
    const overflow = JSON.stringify(card).length - budget;
    const nextLen = Math.max(NAME_FLOOR, frame.name.length - Math.max(1, overflow + 1));
    if (nextLen >= frame.name.length) break;
    const keep = Math.max(1, nextLen - 1);
    frame.name = `${frame.name.slice(0, keep)}…`;
    card = build();
  }
  if (fits(card)) return card;
  if (seed.renamedNote) {
    delete seed.renamedNote;
    card = build();
    if (fits(card)) return card;
  }
  if (seed.propertyNotes) {
    delete seed.propertyNotes;
    card = build();
    if (fits(card)) return card;
  }
  const hintFloor = hint.includes(EXACT_COMPONENT_HINT)
    ? Math.max(12, EXACT_COMPONENT_HINT.length)
    : 12;
  while (!fits(card) && hint.length > hintFloor) {
    const overflow = JSON.stringify(card).length - budget;
    const cut = Math.max(8, overflow + 1);
    const nextLen = Math.max(hintFloor, hint.length - cut);
    if (nextLen >= hint.length) break;
    hint = clipHint(hint, nextLen);
    card = build();
  }
  if (fits(card)) return card;
  if (seed.labelDiffers) {
    delete seed.labelDiffers;
    card = build();
    if (fits(card)) return card;
  }
  while (!fits(card) && warnings && warnings.length > 0) {
    warnings.pop();
    extra += 1;
    warningNote = WARNING_OVERFLOW(extra);
    card = build();
  }
  if (fits(card)) return card;
  const bare = { ...card } as Record<string, unknown>;
  delete bare["cost"];
  shrinkNameFields(bare, budget, (value) => JSON.stringify(withCost(value)).length);
  return price(bare);
}
