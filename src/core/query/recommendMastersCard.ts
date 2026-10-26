/** Card assembly for recommend. Ranking stays in recommendMasters. */
import type { GraphNode } from "@/core/model";
import { setOf } from "@/core/rules/family";
import { isRetired } from "@/core/rules/retired";
import { computeComponentUsage } from "./analytics";
import { bindRuleHit, fitBindRuleWarnings, packJourneyPhrase, whyLineForMaster, type BindRulesFile } from "./bindRules";
import { fitEcho, shedEcho, shrinkNameFields } from "./cardFit";
import { angularText, type CodeView } from "./codeMap";
import { propertyBlock } from "./componentProperties";
import { withCost } from "./cost";
import { examplePointer } from "./examples";
import type { GraphIndex } from "./GraphIndex";
import { realMastersNamed, RECOMMEND_BUDGET, sameNameNote, substitutionNote, variantCardName } from "./masterNames";
import { placeReady } from "./placeReady";
import type { MeaningDecision } from "./meaning/parse";
import { allSynonymGroups, appliedRecommendContext } from "./recommendContext";
import { isPrivateMaster, isSetModifierVariant, namesThisNode, setCoversAsk, weakCheckWhy, weakMatchWhy } from "./recommendLexicon";
import { type RecommendAlternate, type RecommendCandidate, type RecommendContext, type RecommendHit, refreshHintFor, slotsForComponent, whereUsedRows } from "./recommendSupport";
import { tokensOf } from "./queryTokens";
import type { SockState } from "./sock";
import { exampleQuery } from "./usageCard";
import type { WorkspaceManifest } from "./workspace";

export type Scored = {
  node: GraphNode;
  score: number;
  lexical: number;
  why: string[];
  whyOverride?: string;
  analog: boolean;
  deprecated: boolean;
  instances: number;
  setName?: string;
  exactName: boolean;
  covered: number;
  askCovered?: number;
  weak?: boolean;
  fallback?: "purpose" | "word-form";
};

export function finishRecommendCard(input: {
  kept: Scored[];
  decision: MeaningDecision | undefined;
  index: GraphIndex;
  intentNeedle: string;
  tokens: string[];
  echoIntent: string;
  budgetChars: number;
  options: {
    budgetChars?: number;
    context?: RecommendContext;
    workspace?: WorkspaceManifest;
    sock?: SockState;
    bindRules?: BindRulesFile;
    placeholders?: string[];
    lexicalOnly?: boolean;
    skipFallback?: boolean;
  };
  intent: string;
  view: CodeView | undefined;
  sharedMiss: (name: string) => string[];
  onlyRetired: { name: string; use?: string; guess?: boolean } | undefined;
  retiredNote: string | undefined;
  graphFileKey: string;
  lowConfidence: boolean;
  bindQuery: {
    intent: string;
    domain?: string;
    journey?: string;
    product?: string;
    pack?: string;
    workspace?: WorkspaceManifest;
    graphFileKey: string;
    sock?: SockState;
  };
}) {
  let {
    kept,
    decision,
    index,
    intentNeedle,
    tokens,
    echoIntent,
    budgetChars,
    options,
    intent,
    view,
    sharedMiss,
    onlyRetired,
    retiredNote,
    graphFileKey,
    bindQuery,
    lowConfidence,
  } = input;
  const familyCardName = (entry: Scored): string => {
    if (entry.setName && entry.node.name.includes("=") && !namesThisNode(intentNeedle, entry.node, index)) return entry.setName;
    if (entry.node.type !== "VARIANT") return variantCardName(index, entry.node);
    const set = setOf(index, entry.node);
    if (!isSetModifierVariant(entry.node, set)) return variantCardName(index, entry.node);
    if (namesThisNode(intentNeedle, entry.node, index)) return variantCardName(index, entry.node);
    return set?.name ?? variantCardName(index, entry.node);
  };

  if (decision && !decision.empty) {
    const banned = new Set(decision.excluded.map((name) => name.toLowerCase()));
    while (kept[0] && banned.has(familyCardName(kept[0]).toLowerCase())) kept.shift();
    if (decision.leadName && !kept[0]?.exactName) {
      const wanted = decision.leadName.toLowerCase();
      const idx = kept.findIndex((entry) => familyCardName(entry).toLowerCase() === wanted || entry.node.name.toLowerCase() === wanted);
      if (idx > 0) {
        const [hit] = kept.splice(idx, 1);
        if (hit) {
          if (decision.reasons.some((reason) => reason.startsWith("A breadcrumb") || reason.startsWith("No density variant") || reason.startsWith("The named part"))) hit.weak = false;
          kept.unshift(hit);
        }
      } else if (idx === 0 && kept[0] && decision.reasons.some((reason) => reason.startsWith("A breadcrumb") || reason.startsWith("No density variant") || reason.startsWith("The named part"))) {
        kept[0].weak = false;
      } else if (idx < 0) {
        const node = realMastersNamed(index, decision.leadName).find((item) => !isRetired(index, item) && !isPrivateMaster(index, item));
        if (node) {
          const set = setOf(index, node);
          kept.unshift({
            node: set && set.id !== node.id ? set : node,
            score: 900_000,
            lexical: 900,
            why: ["name"],
            analog: false,
            deprecated: false,
            instances: computeComponentUsage(index, node).instanceCount,
            exactName: false,
            covered: tokens.length,
            weak: decision.weakWords.length > 0 && !decision.reasons.some((reason) => reason.startsWith("No density variant") || reason.startsWith("The named part")),
          });
        }
      }
    }
    if (decision.secondName && kept.length) {
      const wanted = decision.secondName.toLowerCase();
      const at = kept.findIndex((entry) => familyCardName(entry).toLowerCase() === wanted || entry.node.name.toLowerCase() === wanted);
      if (at > 1) {
        const [hit] = kept.splice(at, 1);
        if (hit) kept.splice(1, 0, hit);
      } else if (at < 0) {
        const node = realMastersNamed(index, decision.secondName).find((item) => !isRetired(index, item) && !isPrivateMaster(index, item));
        if (node) {
          const set = setOf(index, node);
          kept.splice(1, 0, {
            node: set && set.id !== node.id ? set : node,
            score: 700_000,
            lexical: 700,
            why: ["name"],
            analog: false,
            deprecated: false,
            instances: computeComponentUsage(index, node).instanceCount,
            exactName: false,
            covered: tokens.length,
            weak: false,
          });
        }
      }
    }
  }
  if (kept[0] && !kept[0].fallback) {
    const leadLabel = familyCardName(kept[0]).toLowerCase();
    const asked = new Set(tokensOf(echoIntent));
    const says = (part: string) => [...asked].some((token) => token === part || token === `${part}s` || token === `${part}es`);
    const strongAlias = allSynonymGroups().some((group) => {
      const namesLead = group.terms.some((term) => term.toLowerCase() === leadLabel);
      if (!namesLead) return false;
      return group.terms.some((term) => term.includes(" ") && tokensOf(term).every((part) => says(part)));
    });
    if (strongAlias) kept[0].weak = false;
  }

  const settingsOf = (node: GraphNode): string | undefined => {
    const set = node.type === "COMPONENT_SET" ? node : node.componentSetId ? index.getNode(node.componentSetId) : undefined;
    const variants = set ? index.getVariantsOf(set.id) : [];
    if (!variants.length) return undefined;
    const props: string[] = [];
    const seen = new Set<string>();
    for (const variant of variants) {
      for (const key of Object.keys(variant.variantProperties ?? {})) {
        if (seen.has(key)) continue;
        seen.add(key);
        props.push(key);
      }
    }
    const names = props.slice(0, 4).join(", ");
    return names ? `${variants.length} variants · ${names}` : `${variants.length} variants`;
  };

  const packJourney = packJourneyPhrase(options.context);

  const toCandidate = (
    entry: Scored,
    includeSlots: boolean,
    whereLimit: number,
  ): RecommendCandidate => {
    const whereUsed = whereUsedRows(index, entry.node, whereLimit);
    const slots = includeSlots ? slotsForComponent(index, entry.node) : [];
    const place = placeReady(entry.node, graphFileKey);
    const hint = entry.deprecated
      ? "Deprecated — do not place."
      : place.published
        ? "Place fileKey + nodeId + componentKey."
        : "Place fileKey + nodeId. Local-only (no published key).";
    const why =
      entry.whyOverride ??
      whyLineForMaster(entry.node, {
        sock: options.sock,
        packJourney,
        bindRule: options.bindRules
          ? bindRuleHit(options.bindRules, entry.node, bindQuery)
          : undefined,
        graphFileKey,
        instances: entry.instances,
      });
    return {
      id: entry.node.id,
      name: familyCardName(entry),
      type: entry.node.type,
      ...place,
      variantProperties: entry.node.variantProperties,
      ...(settingsOf(entry.node) ? { settings: settingsOf(entry.node) } : {}),
      set: entry.setName,
      status: entry.node.status,
      deprecated: entry.deprecated,
      instances: entry.instances,
      whereUsed,
      ...(slots.length ? { slots } : {}),
      score: entry.score,
      why,
      hint,
    };
  };

  const tight = budgetChars <= RECOMMEND_BUDGET;
  const target = tight ? 3 : 6;
  let limit = Math.min(kept.length, target);
  let truncated = kept.length > limit;
  let dropExtras = false;
  let dropVariant = false;
  let shedPlaceNoise = false;
  let shedLeadDetail = false;
  let omitExNote = false;
  /** `all` keeps the catalog. `matched` keeps rows the request named, before hits 2–3 go. `none` goes before the lead's why. */
  let propertyKeep: "all" | "matched" | "none" = "all";
  const exQuery = exampleQuery(index, options);

  const shortReason = (why: string): string => {
    const cut = why.split(";")[0]?.trim() || why;
    return cut.length > 64 ? `${cut.slice(0, 61)}…` : cut;
  };

  const leadCandidate = (entry: Scored, top: boolean): RecommendCandidate => {
    const full = toCandidate(entry, false, 0);
    if (entry === kept[0] && sharedMiss(familyCardName(entry)).length > 0) {
      full.why = `Weak, check: ${sharedMiss(familyCardName(entry)).map((word) => `"${word}"`).join(", ")} not in ${familyCardName(entry)}.`;
    } else if (
      entry.weak &&
      entry === kept[0] &&
      /used \d+× in file/.test(full.why) &&
      !/bind rule|used on \d+ real screen/.test(full.why)
    ) {
      full.why = weakMatchWhy(intent, familyCardName(entry));
    }
    const pointer = examplePointer(index, entry.node, exQuery, tight ? "id" : "screen");
    const block = top
      ? propertyBlock(index, entry.node, intent, view?.twin(entry.node)?.angular, options.context?.propertyHints)
      : undefined;
    const keptRows = !block || propertyKeep === "none"
      ? []
      : propertyKeep === "matched"
        ? block.properties.filter((row) => row.designerSays)
        : block.properties;
    const next: RecommendCandidate = {
      ...full,
      ...(keptRows.length
        ? {
            properties: keptRows,
            ...(block?.apply && keptRows.some((row) => row.designerSays) ? { apply: block.apply } : {}),
          }
        : {}),
      whereUsed: [],
      ...pointer,
      hint: full.deprecated ? "Deprecated — do not place." : "Place fileKey + nodeId.",
    };
    if (omitExNote) delete next.exNote;
    if (top && shedPlaceNoise) {
      const loose = next as unknown as Record<string, unknown>;
      delete loose["score"];
      if (loose["nodeId"] === loose["figmaNodeId"]) delete loose["nodeId"];
      delete loose["whereUsed"];
      delete loose["publishState"];
      if (typeof next.why === "string" && next.why.length > 48) next.why = `${next.why.slice(0, 47)}…`;
    }
    if (lowConfidence && !shedLeadDetail) next.confidence = "low";
    // The why line stays: find.md and --help promise it on the top hit.
    if (top && shedLeadDetail) {
      const loose = next as unknown as Record<string, unknown>;
      delete loose["confidence"];
      delete loose["componentKey"];
      delete loose["published"];
      delete loose["publishState"];
      delete loose["instances"];
      delete loose["hint"];
      if (loose["deprecated"] === false) delete loose["deprecated"];
    }
    delete next.slots;
    if (dropExtras) {
      delete next.set;
      delete next.settings;
    }
    if (dropVariant) {
      delete next.variantProperties;
    }
    return next;
  };

  const altCandidate = (entry: Scored): RecommendAlternate => {
    const place = placeReady(entry.node, graphFileKey);
    const why = entry.whyOverride ?? toCandidate(entry, false, 0).why;
    return {
      id: entry.node.id,
      name: familyCardName(entry),
      why: shortReason(why),
      ...(place.fileKey ? { fileKey: place.fileKey } : {}),
      ...(place.figmaNodeId ? { figmaNodeId: place.figmaNodeId } : {}),
    };
  };

  const listed = (): RecommendHit[] =>
    kept.slice(0, limit).map((entry, position) =>
      position === 0 || !tight ? leadCandidate(entry, position === 0) : altCandidate(entry),
    );

  let candidates = listed();

  const applied = appliedRecommendContext(options.context);
  let contextEcho = applied ? { ...applied } : undefined;
  const echoBag: { hint?: string } = {};
  const leadNode = kept[0]?.node;
  const leadSetName = leadNode
    ? setOf(index, leadNode)?.name ?? leadNode.name
    : "";
  const leadSetCovers = leadSetName ? setCoversAsk(intentNeedle, leadSetName) : false;
  const leadCovered = kept[0]?.covered ?? 0;
  const leadNameTokens = kept[0] ? tokensOf(familyCardName(kept[0])) : [];
  const bannerMismatch = tokens.includes("banner") && !leadNameTokens.includes("banner");
  // A lead reached only through a shared noun after an -ed/-ing word ("dated item") is a guess: weak, like compose.
  // An empty answer is never weak: weak means there is a lead to check.
  const weakLead = kept[0] !== undefined && (
    Boolean(kept[0].fallback) ||
    sharedMiss(familyCardName(kept[0])).length > 0 ||
    bannerMismatch ||
    (Boolean(kept[0].weak) && !kept[0].exactName && !(leadSetCovers && leadCovered >= tokens.length)));
  const leadClashes = leadNode ? realMastersNamed(index, leadNode.name) : [];
  const clashNote = leadNode ? sameNameNote(index, leadClashes, leadNode) : undefined;
  const subNote = substitutionNote(index, intent, leadNode);
  const extraNote = [clashNote, subNote].filter(Boolean).join(" ") || undefined;
  const payloadOf = () => {
    if (weakLead && candidates[0]) Object.assign(candidates[0], { why: weakCheckWhy((candidates[0] as { why?: string }).why, sharedMiss(kept[0] ? familyCardName(kept[0]) : ""), intent, candidates[0].name) });
    const base = {
      intent: echoIntent,
      candidates,
      truncated,
      ...(weakLead ? { match: "weak match" } : {}),
      ...(extraNote ? { note: extraNote } : {}),
      ...(contextEcho && Object.keys(contextEcho).length ? { context: contextEcho } : {}),
      ...(options.context?.warning ? { warning: options.context.warning } : {}),
      hint:
        echoBag.hint ??
        (weakLead
          ? "Weak match. Do not Read graph.json."
          : candidates.length === 0
            ? `No master matched. Do not invent. ${refreshHintFor(options.sock, graphFileKey)}`
            : candidates.length > 1 &&
                candidates.slice(1).some((row) => !("fileKey" in row && row.fileKey) || !("figmaNodeId" in row && row.figmaNodeId))
              ? `Place fileKey+nodeId on the top hit. Resolve an alternate by id before placing it. ${refreshHintFor(options.sock, graphFileKey)}`
              : `Place fileKey+nodeId. ${refreshHintFor(options.sock, graphFileKey)}`),
    };
    const fitted = fitBindRuleWarnings(options.bindRules?.warnings, base, budgetChars);
    return { ...base, ...fitted };
  };

  let payload = payloadOf();
  if (JSON.stringify(payload).length > budgetChars) {
    shedEcho(contextEcho, () => JSON.stringify(payloadOf()).length > budgetChars);
    payload = payloadOf();
  }
  const shrink = () => {
    candidates = listed();
    payload = payloadOf();
  };

  if (JSON.stringify(payload).length > budgetChars && candidates[0] && "exNote" in candidates[0]) {
    omitExNote = true;
    shrink();
  }
  const overBudget = () => JSON.stringify(payload).length > budgetChars;
  if (overBudget()) {
    const lead = candidates[0];
    if (lead && "properties" in lead && Array.isArray(lead.properties) && lead.properties.length) {
      shedPlaceNoise = true;
      shrink();
    }
  }
  if (overBudget()) {
    dropExtras = true;
    shrink();
  }
  if (overBudget()) {
    dropVariant = true;
    shrink();
  }
  if (overBudget()) {
    const lead = candidates[0];
    if (lead && "why" in lead && lead.why.length > 48) {
      lead.why = `${lead.why.slice(0, 47)}…`;
      payload = payloadOf();
    }
  }
  if (overBudget() && contextEcho) {
    const journey = contextEcho["journey"];
    if (typeof journey === "string" && journey.length > 80) {
      delete contextEcho["journey"];
      delete contextEcho["journeyFrom"];
      payload = payloadOf();
    }
    const optional = ["a11y", "a11yFrom", "audience", "audienceFrom", "files", "client", "clientFrom", "domainFrom", "productFrom", "warning"] as const;
    for (const key of optional) {
      if (!overBudget()) break;
      delete contextEcho[key];
      payload = payloadOf();
    }
  }
  if (overBudget() && candidates[0] && "properties" in candidates[0]) {
    propertyKeep = "matched";
    shrink();
  }
  if (overBudget()) {
    const ceiling = Math.min(kept.length, target);
    const counts = [...new Set([ceiling, Math.min(2, ceiling), 1])].filter((count) => count >= 1);
    const plans = [
      ...counts.map((count) => ({ count, variants: true })),
      ...counts.map((count) => ({ count, variants: false })),
    ];
    for (const plan of plans) {
      limit = plan.count;
      dropVariant = !plan.variants;
      truncated = kept.length > plan.count;
      shrink();
      fitEcho(payload, contextEcho, echoBag, budgetChars);
      payload = payloadOf();
      if (!overBudget()) break;
      const lead = candidates[0];
      if (lead && "why" in lead && lead.why.length > 72) {
        lead.why = `${lead.why.slice(0, 69)}…`;
        payload = payloadOf();
        if (!overBudget()) break;
      }
    }
  }
  const warningsWanted = options.bindRules?.warnings?.length ?? 0;
  const warningMissing = () =>
    warningsWanted > 0 && !payload.bindRuleWarnings?.length && !payload.warningNote;
  fitEcho(payload, contextEcho, echoBag, budgetChars);
  payload = payloadOf();
  if (warningMissing() || JSON.stringify(payload).length > budgetChars) {
    fitEcho(payload, contextEcho, echoBag, budgetChars);
    payload = payloadOf();
  }
  while (warningMissing() && candidates.length > 1) {
    truncated = true;
    limit = candidates.length - 1;
    shrink();
    fitEcho(payload, contextEcho, echoBag, budgetChars);
    payload = payloadOf();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    fitEcho(payload, contextEcho, echoBag, budgetChars, true);
    payload = payloadOf();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    const lead = candidates[0];
    if (lead && "whereUsed" in lead && Array.isArray(lead.whereUsed) && lead.whereUsed.length === 0) {
      delete lead.whereUsed;
    }
    if (contextEcho && "files" in contextEcho) delete contextEcho["files"];
    payload = payloadOf();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    shrinkNameFields(payload, budgetChars);
  }
  if (JSON.stringify(payload).length > budgetChars) {
    const lead = payload.candidates?.[0];
    if (lead && "why" in lead && typeof lead.why === "string" && lead.why.length > 48) {
      lead.why = `${lead.why.slice(0, 47)}…`;
    }
    echoBag.hint = "Place fileKey + nodeId.";
    payload = payloadOf();
    if (JSON.stringify(payload).length > budgetChars) shrinkNameFields(payload, budgetChars);
  }
  if (overBudget() && candidates[0] && "properties" in candidates[0]) {
    shedLeadDetail = true;
    shrink();
  }
  if (overBudget() && candidates[0] && "properties" in candidates[0]) {
    propertyKeep = "none";
    shrink();
  }

  const lead = kept[0];
  const leadTwin = lead && !weakLead && !lead.deprecated ? view?.twin(lead.node) : undefined;
  const codeLine = leadTwin && !leadTwin.retired ? leadTwin.line : undefined;
  const ngLine = codeLine ? leadTwin?.angular : undefined;
  if (
    codeLine &&
    candidates[0] &&
    "properties" in candidates[0] &&
    JSON.stringify({ ...payload, code: codeLine, ...(ngLine ? { angular: angularText(ngLine) } : {}) }).length > budgetChars
  ) {
    shedPlaceNoise = true;
    dropExtras = true;
    shrink();
  }
  const extra: { retired?: string; code?: string; angular?: string } = {};
  const append = <K extends keyof typeof extra>(key: K, value?: (typeof extra)[K]) => {
    if (value && JSON.stringify({ ...payload, ...extra, [key]: value }).length <= budgetChars) extra[key] = value;
  };
  const only = onlyRetired ? { ...payload, hint: `Only match is retired: ${onlyRetired.name}. ${onlyRetired.guess ? "Closest current part (guess): " : "Use "}${onlyRetired.use ?? "none"}.` } : undefined;
  const said = only && JSON.stringify(only).length <= budgetChars;
  if (!said) append("retired", retiredNote);
  const codeWanted = leadTwin && !leadTwin.retired ? leadTwin.line : undefined;
  const ngWanted = codeWanted ? leadTwin?.angular : undefined;
  append("code", codeWanted);
  // Selector and module as one short line (inputs and outputs are on the resolve card), only beside a real code line.
  append("angular", extra.code && extra.code !== "(cut)" && ngWanted ? angularText(ngWanted) : undefined);
  // A reviewed map's code or selector line that does not fit stays visible as (cut) when the marker fits.
  if (codeWanted && !extra.code) append("code", "(cut)");
  if (ngWanted && !extra.angular) append("angular", "(cut)");

  return withCost({ ...(said ? only : payload), ...extra });
}
