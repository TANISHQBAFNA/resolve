/** Orient, query, path, explain, and the retired check-frame entry. */
import { buildAiGraphContext, toMarkdownPrompt } from "@/core/ai";
import { isRetired } from "@/core/rules/retired";
import { computeAnalytics, type GraphAnalytics } from "./analytics";
import { briefNode } from "./cardCopy";
import { detectCommunitiesForIndex } from "./communities";
import { withCost } from "./cost";
import type { GraphIndex } from "./GraphIndex";
import { variantCardName } from "./masterNames";
import { resolveNode } from "./nodeLookup";
import { screenInventory, sharedComponents, similarUsage } from "./screenInventory";
import { searchNodes } from "./search";
import { extractSubgraph, levelForNode } from "./subgraph";

export interface OrientBrief {
  file: { name: string; key: string; sourceKind: string };
  totals: GraphAnalytics["totals"];
  godNodes: Array<{ id: string; name: string; type: string; degree: number }>;
  communities: Array<{ name: string; size: number; hub: string }>;
  health: {
    unusedComponents: number;
    unresolvedInstances: number;
    framesWithoutComponents: number;
  };
  askNext: string[];
  hint: string;
}
export function suggestQuestions(index: GraphIndex, analytics: GraphAnalytics): string[] {
  const questions: string[] = [];
  const screens = index.getNodesByType("FRAME").filter((node) => {
    const parent = index.getParent(node.id);
    return parent?.type === "PAGE" || parent?.type === "SECTION" || parent?.type === "FILE";
  });
  const topScreen = screens[0];
  const topComponent = analytics.componentUsage.find((usage) => usage.instanceCount > 0);
  const hub = analytics.mostConnected.find(
    (entry) => entry.node.type === "MAIN_COMPONENT" || entry.node.type === "COMPONENT_SET",
  );

  if (topScreen) questions.push(`What is ${topScreen.name} built from?`);
  if (topComponent) {
    questions.push(
      `Where is ${topComponent.component.name} used, and what breaks if it changes?`,
    );
  }
  if (hub) questions.push(`Why is ${hub.node.name} a hub in this file?`);
  if (analytics.unusedComponents.length) {
    questions.push("Which component definitions have zero instances?");
  }
  if (screens.length >= 2) {
    questions.push(`How is ${screens[0]!.name} related to ${screens[1]!.name}?`);
  }
  return questions.slice(0, 5);
}
export function buildOrientBrief(index: GraphIndex): OrientBrief {
  const analytics = computeAnalytics(index);
  const file = index.getFileNode();
  const communities = detectCommunitiesForIndex(index, { excludeHubs: true })
    .communities.filter((community) => community.size > 1)
    .slice(0, 12);

  return {
    file: {
      name: file?.name ?? index.graph.fileName,
      key: index.graph.fileKey,
      sourceKind: index.graph.source.kind,
    },
    totals: analytics.totals,
    godNodes: analytics.mostConnected.slice(0, 8).map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      type: entry.node.type,
      degree: entry.degree,
    })),
    communities: communities.map((community) => ({
      name: community.name,
      size: community.size,
      hub: community.hubId,
    })),
    health: {
      unusedComponents: analytics.unusedComponents.length,
      unresolvedInstances: analytics.unresolvedInstances.length,
      framesWithoutComponents: analytics.framesWithoutComponents.length,
    },
    askNext: suggestQuestions(index, analytics),
    hint:
      "Implementing a screen: optional recipe \"<job>\", recommend unbound slots, Figma on those figmaNodeIds, then verify_frame. Do not Read graph.json.",
  };
}
export function toGraphReportMarkdown(brief: OrientBrief): string {
  const lines = [
    `# ${brief.file.name}`,
    "",
    `${brief.totals.nodes} nodes, ${brief.totals.edges} edges, ${brief.totals.componentDefinitions} components, ${brief.totals.instances} instances. Source: ${brief.file.sourceKind}.`,
    "",
    "Ingested once. Do not Read graph.json.",
    "",
    "## Implement a screen",
    "",
    "1. Optional: `recipe \"<screen job>\"` — pack of masters + slots with `figmaNodeId`s.",
    "2. `recommend \"<intent>\"` — ranked masters for unbound slots (`figmaNodeId`, variants, where-used).",
    "3. Figma (`use_figma` / `get_design_context`) on those `figmaNodeId`s only.",
    "4. Before `verify_frame`, fetch the frame's design context so Resolve can read the text. Pass it as `designContext`. Pass design context to `learn_library` too, so the component default is stored. Then `verify_frame` — invents / deprecated / unresolved / leftover text.",
    "5. `resolve \"<component>\"` when you already know the name (usage card).",
    "6. Do **not** call `get_design_context` on a FRAME or SECTION until recipe/recommend/resolve returns an id.",
    "",
    "## God nodes",
    "",
    ...brief.godNodes.map(
      (node) => `- **${node.name}** (\`${node.type}\`, degree ${node.degree}) \`${node.id}\``,
    ),
    "",
    "## Communities",
    "",
    ...brief.communities.map((community) => `- **${community.name}** — ${community.size} nodes`),
    "",
    "## Health",
    "",
    `- unused components: ${brief.health.unusedComponents}`,
    `- unresolved instances: ${brief.health.unresolvedInstances}`,
    `- frames with no components: ${brief.health.framesWithoutComponents}`,
    "",
    "## Ask next",
    "",
    ...brief.askNext.map((question) => `- ${question}`),
    "",
    brief.hint,
    "",
  ];
  return lines.join("\n");
}
export function queryQuestion(
  index: GraphIndex,
  question: string,
  options: { maxNodes?: number; budgetChars?: number } = {},
) {
  const analog = similarUsage(index, question);
  // Only the analog shortcut when the question names a component family.
  // Empty familyTokens would treat every instance on matching screens as
  // "pick this variant" — 12 Headings, not Heading × 12.
  if (analog.familyTokens.length && analog.variants.length) {
    const use = analog.variants[0]!;
    return withCost({
      question,
      use,
      also: analog.variants.slice(1),
      similarScreens: analog.screens,
      hint: `Use ${use.set ? `${use.set} / ` : ""}${use.name} — nested on ${use.on.map((screen) => screen.name).join(", ")}. Do not pick a variant from an unrelated screen.`,
    });
  }

  let hits = searchNodes(index, question, { limit: 8 });
  if (!hits.length && analog.screens[0]) {
    const screen = index.getNode(analog.screens[0].id);
    if (screen) {
      hits = [{ node: screen, score: analog.screens[0].score, matchedOn: ["name"] }];
    }
  }
  if (!hits.length) {
    const orient = buildOrientBrief(index);
    return withCost({
      question,
      matched: 0,
      similarScreens: analog.screens,
      hint: "No node matched. Use a name from Ask next, or the query language (type:main Button).",
      askNext: orient.askNext,
    });
  }

  const focus =
    hits.find((hit) => hit.node.type === "FRAME" || hit.node.type === "SECTION")?.node ??
    hits[0]!.node;

  if (focus.type === "FRAME" || focus.type === "SECTION") {
    const inventory = screenInventory(index, focus.id);
    return withCost({
      question,
      focus: briefNode(focus),
      matches: hits.map((hit) => ({ ...briefNode(hit.node), matchedOn: hit.matchedOn })),
      ...inventory,
    });
  }
  const budgetChars = options.budgetChars ?? 8000;
  let maxNodes = options.maxNodes ?? 40;
  let subgraph = extractSubgraph(index, {
    focusId: focus.id,
    level: levelForNode(focus),
    viewMode: "dependency",
    maxNodes,
  });
  let payload = {
    question,
    focus: briefNode(focus),
    matches: hits.map((hit) => ({ ...briefNode(hit.node), matchedOn: hit.matchedOn })),
    truncated: subgraph.truncated,
    ...briefSubgraph(subgraph),
  };

  // ponytail: shrink neighbourhood until under budget; add paging if agents need more
  while (JSON.stringify(payload).length > budgetChars && maxNodes > 8) {
    maxNodes = Math.floor(maxNodes / 2);
    subgraph = extractSubgraph(index, {
      focusId: focus.id,
      level: levelForNode(focus),
      viewMode: "dependency",
      maxNodes,
    });
    payload = {
      ...payload,
      truncated: true,
      ...briefSubgraph(subgraph),
    };
  }

  return withCost(payload);
}
function briefSubgraph(subgraph: { nodes: Parameters<typeof briefNode>[0][]; edges: Array<{ source: string; target: string; type: string }> }) {
  return {
    nodes: subgraph.nodes.map(briefNode),
    edges: subgraph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
    })),
  };
}

export function pathBetween(index: GraphIndex, from: string, to: string) {
  const start = resolveNode(index, from);
  const end = resolveNode(index, to);
  if (!start || !end) {
    return withCost({
      connected: false,
      hops: 0,
      path: [],
      hint: `Could not resolve ${!start ? from : to}. Call orient or query for names.`,
    });
  }
  const trace = index.shortestPathTrace(start.id, end.id);
  return withCost({
    connected: trace.nodes.length > 0,
    hops: trace.hops.length,
    distance: trace.distance,
    path: trace.nodes.map(briefNode),
    via: trace.hops,
    shared: sharedComponents(index, start.id, end.id).slice(0, 8),
  });
}
export function explainNode(index: GraphIndex, nameOrId: string, task?: string) {
  const node = resolveNode(index, nameOrId);
  if (!node) {
    return withCost({
      found: false,
      hint: `Nothing named "${nameOrId}". Call orient for god nodes, or query.`,
    });
  }
  if (node.type === "FRAME" || node.type === "SECTION") {
    const inventory = screenInventory(index, node.id);
    return withCost({
      found: true,
      node: briefNode(node),
      ...inventory,
    });
  }

  const context = buildAiGraphContext(index, node.id, { nodeBudget: 40 });
  if (!context) {
    return withCost({ found: false, hint: `Could not build context for ${node.id}.` });
  }
  return withCost({
    found: true,
    node: briefNode(node),
    truncated: context.meta.truncated,
    markdown: toMarkdownPrompt(context, task),
  });
}
/**
 * Thin intelligence: which variant to put on a new screen, given sibling
 * flows — and which ones are deprecated.
 */
export function checkFrame(index: GraphIndex, intent: string) {
  const analog = similarUsage(index, intent);
  const avoid = analog.variants.filter((variant) => {
    const node = index.getNode(variant.id);
    return node ? isRetired(index, node) : false;
  });
  const use = analog.variants.find((variant) => {
    const node = index.getNode(variant.id);
    return node ? !isRetired(index, node) : true;
  });
  const useNode = use ? index.getNode(use.id) : undefined;
  const useLabel = useNode ? variantCardName(index, useNode) : use?.name;
  return withCost({
    intent,
    use: use ?? null,
    avoid,
    similarScreens: analog.screens,
    hint: use
      ? `Use ${useLabel}. Nested on ${use.on.map((screen) => screen.name).join(", ")}.${
          avoid.length ? ` Avoid deprecated: ${avoid.map((variant) => variant.name).join(", ")}.` : ""
        }`
      : analog.variants.length
        ? "Similar screens only nest deprecated variants. Do not copy them into a new frame."
        : "No similar screen nested this component family. Call recommend for library-wide ranking, or query / orient for names.",
  });
}
