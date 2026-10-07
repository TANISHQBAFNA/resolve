import type { GraphNode } from "@/core/model";
import { TextInputError } from "@/core/ingestion/textStamps";
import {
  advanceSoci,
  applyFreshness,
  applySociDecision,
  BindRuleError,
  buildOrientBrief,
  checkFrame,
  computeAnalytics,
  componentUsageCard,
  explainNode,
  extractSubgraph,
  freshnessSummary,
  harvestOverrideKeysForFrame,
  isPrivateMasterName,
  isRealVerifiedFrame,
  listSoci,
  mergeBindRules,
  parseLibraryRules,
  capRecipePayload,
  listRecipes,
  pathBetween,
  rankRecipes,
  queryQuestion,
  recipeCard,
  recommendMasters,
  recordCousinCorrections,
  recordVerifiedUsage,
  screenAskCard,
  jobOfName,
  screenInventory,
  topLevelMasterIds,
  searchNodes,
  usageCardForComponent,
  usageSummaryFor,
  verifyFrame,
  exampleCard,
  exampleFactForMasterOnFrame,
  withCost,
  withPendingImprovements,
  checkCousins,
  appliedContext,
  packForRecommend,
  parseIngestRole,
  ingredientCard,
  handoffSheet,
  type GraphIndex,
  type GraphLevel,
  type HandoffPack,
  type ContextBind,
  type Recipe,
  type ViewMode,
} from "@/core/query";
import { presentToolResult, type ToolCardFormat } from "./cards";
import { learnLibrary } from "./learn";
import { withDeprecation } from "./deprecations";
import {
  listGraphs,
  loadContextBind,
  loadRecipes,
  missingGraphMessage,
  readLibraryRules,
  readSock,
  readWorkspace,
  resolveGraph,
  saveSock,
  storeInfo,
  readBindRules,
  readPlaceholders,
  readRecipeOverlay,
  commitProposalDecision,
  loadGraph,
  readApprovedDecisions,
} from "./store";
import { recordGap } from "./gaps";

/**
 * Optional MCP tools. Agents: recommend / recipe / resolve / verify_frame / check_frame.
 * Do not Read graph.json. Graph stays on disk.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const graphIdProperty = {
  graphId: {
    type: "string",
    description: "Graph to query. Optional when exactly one graph is stored.",
  },
};

/** Who the screen is for, and the accessibility bar. From the requirements or FSD, or the context pack. */
const screenContextProperties = {
  audience: {
    type: "string",
    description: "Who the screen is for, taken from the requirements or FSD. Overrides the context pack for this call. Leave off when the document does not say.",
  },
  a11y: {
    type: "string",
    description: 'Accessibility bar from the requirements or FSD, e.g. "wcag-aa". Overrides the context pack for this call. Leave off when the document does not say. Does not run an audit.',
  },
};

export const DEFAULT_TOOL_NAMES = [
  "learn_library",
  "recipe",
  "recommend",
  "resolve",
  "get_example",
  "verify_frame",
  "check_cousins",
] as const;

const formatProperty = {
  format: {
    type: "string",
    enum: ["markdown", "json"],
    description:
      'Card the AI reads. Default markdown. "json" is the same card as compact JSON, without the cost block, duplicate node ids, score, or the graph.json hint.',
  },
};

export function listToolDefinitions(advanced = process.env["RESOLVE_MCP_ADVANCED"] === "1"): ToolDefinition[] {
  const allowed = new Set<string>(DEFAULT_TOOL_NAMES);
  const tools = advanced ? TOOLS : TOOLS.filter((tool) => allowed.has(tool.name));
  return tools.map((tool) => {
    const schema = tool.inputSchema;
    const properties = schema["properties"];
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: {
          ...(properties && typeof properties === "object" ? properties : {}),
          ...formatProperty,
        },
      },
    };
  });
}

const freshnessProperties = {
  fileKey: { type: "string", description: "Figma file key for the freshness check." },
  lastModified: { type: "string", description: "Figma lastModified the agent already has. Marks stale on change." },
  version: { type: "string", description: "Figma file version the agent already has. Marks stale on change." },
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "learn_library",
    description:
      "Load or update SOCK from Figma MCP output. Pass get_metadata XML as metadataXml plus fileKey and role (library|product). Optional libraries = search_design_system / get_libraries (stamps published component keys). Pass designContext too when you have it: metadata usually has no characters, and learn keeps master default text only from real characters. Incremental and resumable across sessions — use that for big libraries (view/free seats have a low read quota; progress is saved). Needs a paid Figma MCP seat (Dev/Full) or a REST token ingest. Do not invent a hand-built capture.",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string", description: "Figma file key." },
        role: { type: "string", description: "library | product | client" },
        fileName: { type: "string" },
        label: { type: "string" },
        metadataXml: { type: "string", description: "Raw Figma MCP get_metadata XML (prose around it is fine)." },
        libraries: { description: "search_design_system or get_libraries JSON. Stamps published keys." },
        designContext: {
          description:
            "get_design_context for this file. Pass it on learn so master default text is stored. A layer name is not text. Metadata alone leaves defaults unknown.",
        },
        lastModified: { type: "string" },
        version: { type: "string" },
        resume: { type: "boolean", description: "Resume a checkpointed learn for a large library." },
        outline: {
          type: "array",
          description: "Known pages/frames for this file (id + name). Remaining work is reported as learned X of Y.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              kind: { type: "string", description: "page | frame" },
            },
          },
        },
      },
      required: ["fileKey"],
    },
  },
  {
    name: "recommend",
    description:
      "Intent in, ranked library masters out. A bare screen job (inquiry, summary, approval or payment screen) answers from mapped screens instead: approaches with masters in order. Ranks by name/intent, variant props, where-used and sibling co-occurrence, live over stale, deprecated demoted. Bind rules (.resolve/bind-rules.json) require/forbid/prefer. The top pick has a one-line why (SOCK facts, 'used N× in file', or 'not verified on a screen yet') and, when a real populated instance is known, an ex id (or fileKey:nodeId when it lives in another file). No example is omitted. Call get_example for the other hits and for file key, screen, variant, structure, and sizing. Clone that instance and replace content; do not start from the default variant. Set context from the requirements or FSD: pack, or only the product, journey, audience, and a11y that document states. Do not ask for those four. The card echoes that context with its source (document, pack <id>, or active pack). Pass the same context on recipe and verify_frame. Every pick shows fileKey and figmaNodeId. The structured card is capped at 600 characters; Markdown is shorter. Empty candidates means stop. Do not invent a component. Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        intent: {
          type: "string",
          description: 'Free-text brief, e.g. "approval summary with primary button and input"',
        },
        pack: {
          type: "string",
          description: "Context pack id from .resolve/context-packs.json. Else the file's active pack.",
        },
        product: { type: "string", description: "Product id or name. Scopes ranking when a pack matches, else inline." },
        journey: { type: "string", description: "Journey step / screen job. Scopes ranking on top of name/intent." },
        domain: { type: "string", description: 'Product domain, e.g. "checkout" or "onboarding".' },
        ...screenContextProperties,
        screenType: { type: "string", description: 'Screen kind, e.g. "settings" or "checkout". Same tie-break as domain.' },
        budgetChars: { type: "number", description: "Hard cap on the structured card, in characters. Default 600. Markdown is shorter." },
        ...freshnessProperties,
      },
      required: ["intent"],
    },
  },
  {
    name: "check_cousins",
    description:
      "Wrong-cousin report for a product/client frame or placed names. Same role or weak name as a shared DS library master, but a different master family / file. Needs a library-role file in .resolve/workspace.json. Unsure rows refuse to guess. Never invents a master. Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        frame: { type: "string", description: "Product/client frame name, graph id, or figmaNodeId." },
        components: {
          type: "array",
          items: { type: "string" },
          description: "Placed component names or ids.",
        },
        job: { type: "string", description: "Screen job, e.g. \"checkout summary\". Uses the matching recipe for role." },
        pack: { type: "string" },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        ...freshnessProperties,
        fileKey: {
          type: "string",
          description:
            "Product/client file key. Checks every instance in that file. Also used for the freshness check.",
        },
      },
    },
  },
  {
    name: "resolve",
    description:
      "I know the name, give me the id. Exact master name or id always returns fileKey and figmaNodeId even when unused (zero instances). One-line why from SOCK facts. Pass the same context as recommend (pack, or product, journey, audience, a11y). The card echoes that context with its source. screenType/journey/domain break cousin ties. A deprecated master comes back flagged, plus its live replacement. Names starting with _ or . return only on an exact name; a fuzzy ask does not. Unknown name: the card says it was not found and to call recommend, not an empty list. Frame names return a screen inventory. The structured card is capped at about 2000 characters; Markdown is shorter.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        name: { type: "string", description: 'Component or frame name, e.g. "Main Card" or "Portfolio"' },
        pack: {
          type: "string",
          description: "Context pack id from .resolve/context-packs.json. Else the file's active pack.",
        },
        product: { type: "string", description: "Product id or name. Scopes ranking when a pack matches, else inline." },
        journey: { type: "string", description: "Journey step / screen job. Breaks ties between cousins." },
        domain: { type: "string", description: 'Product domain, e.g. "checkout" or "settings".' },
        ...screenContextProperties,
        screenType: { type: "string", description: 'Screen kind, e.g. "settings" or "checkout".' },
        budgetChars: { type: "number", description: "Hard cap on the structured card, in characters. Default 2000. Markdown is shorter." },
        ...freshnessProperties,
      },
      required: ["name"],
    },
  },
  {
    name: "get_example",
    description:
      "Full config for the real populated instance behind a pick. The recommend card puts ex on the top pick only; call this for the others. Returns file key, node id, screen name, variant props, child structure (tabs, dividers, row count), and sizing. Clone this instance and replace content; do not start from the default variant. When none is known, the card says there is no example and why (bare defaults only, not on any screen, use the live replacement, or no such component — call recommend). The long sentence stays here. Never invents a node. Retired and private masters are not examples.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        name: { type: "string", description: "Master name, graph id, or figma node id from the pick." },
        pack: { type: "string" },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        screenType: { type: "string" },
        ...freshnessProperties,
      },
      required: ["name"],
    },
  },
  {
    name: "orient",
    description:
      "Deprecated. This will be removed after a quarter. Use recommend or recipe. God nodes and communities.",
    inputSchema: { type: "object", properties: { ...graphIdProperty } },
  },
  {
    name: "query",
    description:
      "Deprecated. This will be removed after a quarter. Use recommend or resolve. One-hop answer: similar screens and which component variants they nest.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        question: { type: "string", description: 'e.g. "where is Input Field used"' },
        budgetChars: { type: "number", description: "Hard cap on the structured card, in characters. Default 8000. Markdown is shorter." },
      },
      required: ["question"],
    },
  },
  {
    name: "path",
    description:
      "Deprecated. This will be removed after a quarter. Use recommend. Shortest relationship path between two nodes, by name or id.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "explain",
    description:
      "Deprecated. This will be removed after a quarter. Use the why line on a recommend or resolve card. Bounded markdown brief for one node.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        name: { type: "string", description: "Node name or id." },
        task: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "check_frame",
    description:
      "Deprecated. This will be removed after a quarter. Use verify_frame. Analog shortcut: pick the variant similar screens nest and list deprecated ones to avoid.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        intent: { type: "string", description: 'e.g. "approval summary buttons"' },
      },
      required: ["intent"],
    },
  },
  {
    name: "verify_frame",
    description:
      "After drawing, check a frame or a proposed component list against the library graph and bind rules. Pass iff every placement is an in-graph master, not deprecated, and bind require/forbid rules hold. Before verify, fetch the frame's design context so Resolve can read the text — pass it as designContext. texts fills empty layers inside this frame only and cannot replace stored copy or component defaults. textChecked is true only when instance text and the component default were both read; otherwise it is partial, false, or n/a. A component list with no frame is textChecked false. Warnings (not failures) for leftover default text and a fixed height that clearly exceeds the content. Known placeholder strings fail. A bind-rule fail names the rule and returns the required master id + place hint. Optional allow/deny. Deterministic — no LLM.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        frame: { type: "string", description: "Frame name, graph id, or figmaNodeId." },
        components: {
          type: "array",
          items: { type: "string" },
          description: "Placed component names or ids (proposed or observed).",
        },
        rulesFile: {
          type: "string",
          description:
            "Optional JSON { allow, deny }. If omitted, uses .resolve/library-rules.json when that file exists; otherwise in-graph + not deprecated = approved.",
        },
        allow: { type: "array", items: { type: "string" }, description: "Inline allow list (names or ids)." },
        deny: { type: "array", items: { type: "string" }, description: "Inline deny list (names or ids)." },
        pack: { type: "string", description: "Optional context pack. Applies pack libraryRules; still invent/deprecated/unresolved only." },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        designContext: {
          description:
            "Figma get_design_context (or get_metadata that includes characters) for this frame. Before verify, fetch the frame's design context so Resolve can read the text.",
        },
        texts: {
          description:
            "Fill empty text layers inside this frame only: { \"1:3\": \"Pay now\" } or [{ nodeId, characters }]. Does not replace stored copy and does not change component defaults. At most 2000 entries, 2000 characters each. Never a layer name.",
        },
        ...freshnessProperties,
      },
    },
  },
  {
    name: "list_soci",
    description:
      "List SOCI proposals (require-rule, recipe-update, variant-candidate, deprecation-candidate, wrong-cousin). Usage facts write themselves; SOCI never auto-applies. Approve or reject with approve_proposal / reject_proposal (this advanced surface, confirmedBy required).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "approve_proposal",
    description:
      "Human-only. Apply a pending SOCI proposal to bind-rules.json and append an audit line (confirmedBy, when, proposal id, before/after). Rules never auto-change. Advanced surface. Needs RESOLVE_MCP_ADVANCED=1 and confirmedBy.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Pending SOCI proposal id." },
        confirmedBy: { type: "string", description: "Human name confirming this write. Required. Agents cannot confirm." },
        note: { type: "string", description: "Optional note stored with variant/deprecation decisions." },
      },
      required: ["proposalId", "confirmedBy"],
    },
  },
  {
    name: "reject_proposal",
    description:
      "Human-only. Reject a pending SOCI proposal. Appends an audit line. Does not change bind-rules.json. Advanced surface. Needs RESOLVE_MCP_ADVANCED=1 and confirmedBy.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "Pending SOCI proposal id." },
        confirmedBy: { type: "string", description: "Human name confirming this reject. Required. Agents cannot confirm." },
      },
      required: ["proposalId", "confirmedBy"],
    },
  },
  {
    name: "list_recipes",
    description:
      "List screen recipes (composition packs). When a graph is ingested, slots bind to live masters (fill or suggest figmaNodeIds from recommend). Overlay .resolve/recipes.json still wins. Set context from the requirements or FSD: pack, or only the product, journey, audience, and a11y that document states. Do not ask for those four. That scopes slot fills and nextRecommend. Unbound slots include the next recommend query. Never invents node ids. Next: recipe \"<id or intent>\". Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        pack: { type: "string", description: "Context pack id to bind while listing." },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        ...screenContextProperties,
      },
    },
  },
  {
    name: "recipe",
    description:
      "Get a screen recipe by id, title, or intent. A bare screen job (\"payment screen\") answers from mapped screens, never a starter recipe. After ingest, slots resolve against live masters (overlay .resolve/recipes.json still wins). Set context from the requirements or FSD: pack, or only the product, journey, audience, and a11y that document states. Do not ask for those four. That scopes slot fills and nextRecommend. The card echoes audience and a11y. Unbound slots include the next recommend query. Never invents node ids. After placing: verify_frame with the same context. Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        query: {
          type: "string",
          description: 'Recipe id, title, or intent, e.g. "checkout summary" or "sign-in"',
        },
        intent: {
          type: "string",
          description: "Recipe id, title, or intent. Same as query when query is omitted. Extra brief mixed into unbound-slot ranking when both are set.",
        },
        pack: { type: "string", description: "Context pack id. Else pack bound via recipeIds / contextPackId / active." },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        ...screenContextProperties,
        ...freshnessProperties,
      },
    },
  },
  {
    name: "get_recipe",
    description:
      "Deprecated. This will be removed after a quarter. Use recipe. Alias of recipe. After ingest: slots bound/filled from live masters.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        query: {
          type: "string",
          description: 'Recipe id, title, or intent, e.g. "checkout summary"',
        },
        intent: {
          type: "string",
          description: "Optional extra brief mixed into unbound-slot ranking.",
        },
        pack: { type: "string" },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        ...screenContextProperties,
      },
      required: ["query"],
    },
  },
  {
    name: "get_ingredients",
    description:
      "What is inside a component: the library parts placed directly in it, for a developer handoff. Follows one variant: pass variant (\"Size=Medium\"), else the first in the set. A placed instance id reads that copy's own parts at every level. Where the copy's insides were not learned, the card says the parts are from the main component (not checked on this screen, or not checked on the copy inside this component). Variant is refused for an instance id. Each part shows fileKey and figmaNodeId, its code component from .resolve/code-map.json, or that there is no code link (never guessed), plus Angular selector, module or standalone, import path, inputs and outputs when the map entry is Angular. A structured card over 12,000 characters is shown less deep, then fewer parts per level, and says what was cut. Ask a part by name for its own card. Status is current, retired (old code, and what to use instead), unconfirmed (a guess from the layer name), other-library, or not-found. Exact name or id only. An unknown name says it was not found and to call recommend. Markdown by default. Advanced surface. Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        name: { type: "string", description: "Exact component name, variant name, graph id, figma node id, or fileKey:nodeId (an instance id follows the variant it uses)." },
        variant: { type: "string", description: 'Variant to follow, e.g. "Size=Medium, State=Default". Only for a component with variants.' },
        depth: { type: "number", description: "Levels of parts to show, 1-3. Default 1." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_handoff",
    description:
      "Developer handoff sheet for one or more designed screens (frames): recipe slots, each component placed on the screen with fileKey and figmaNodeId and its code from .resolve/code-map.json (unmapped when there is no entry; never guessed), Angular selector, module, inputs and outputs, suggested inputs from Figma variant properties (Variant=Primary becomes variant=\"primary\") and a suggested template line, the parts inside each component, a PASS or FAIL line, approved decisions (who, when, why), and open questions. Refuses when a retired component is on a screen (always), or when a component is only a guess from its layer name ('MCP metadata insufficient for component X. Use Figma REST or design_context.'). allowWeak makes a draft instead, labelled name-guess; drafts are not for build. Over 40,000 characters of the structured card, parts are shown one level less deep at a time until it fits, and the card says how many parts are listed. Open questions and the summary counts always come from the full sheet. Markdown lists each part once, on its component, not again as a second parts table. A copy whose component is in no learned file is refused as not-found. A component from a library file that is not learned is other-library (no Figma id of this file, code unknown, not counted as unmapped). A not-found component is code unknown too. The card lists the other values of each Figma property (the placed one is left out). A recipe slot is placed, inside another component (the card names it), or missing. Placed and inside both count as covered. One copy fills one slot. A frame can be a pasted Figma link with node-id. Markdown by default. Advanced surface. Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        frame: { type: "string", description: "Frame name, graph id, figma node id or fileKey:nodeId." },
        frames: { type: "array", items: { type: "string" }, description: "Several frames for one handoff pack." },
        allowWeak: { type: "boolean", description: "Draft: allow components known only from layer names (labelled name-guess) or missing from the learned files (labelled not-found). Retired components still refuse." },
        recipe: { type: "string", description: "Recipe id or intent to check the screen against. Default: matched from the screen name." },
        depth: { type: "number", description: "Levels of parts per component, 1-3. Default 3. Any other value is clamped, and depthNote says so." },
        pack: { type: "string" },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        ...screenContextProperties,
      },
    },
  },
  {
    name: "list_graphs",
    description:
      "List stored graphs and the store this server is reading (path, graph.json, builtAt). RESOLVE_HOME wins; else the nearest .resolve walking up from cwd. Call this to confirm MCP and CLI share one folder.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_nodes",
    description:
      "Deprecated. This will be removed after a quarter. Use recommend or resolve. Search a graph by name, type and relationship.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        query: { type: "string", description: 'e.g. "type:main Input Field" or "unused-components"' },
        limit: { type: "number", description: "Default 25." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_node",
    description:
      "Deprecated. This will be removed after a quarter. Use resolve. Everything known about one node: type, location, path, counts, and its Figma deep link.",
    inputSchema: {
      type: "object",
      properties: { ...graphIdProperty, nodeId: { type: "string" } },
      required: ["nodeId"],
    },
  },
  {
    name: "get_screen_inventory",
    description:
      "Deprecated. This will be removed after a quarter. Use resolve on a frame name. Which components are used on a screen, frame or section.",
    inputSchema: {
      type: "object",
      properties: { ...graphIdProperty, nodeId: { type: "string" } },
      required: ["nodeId"],
    },
  },
  {
    name: "get_component_usage",
    description:
      "Deprecated. This will be removed after a quarter. Use resolve. Where a component is used: instance count, frames, pages, and a risk score.",
    inputSchema: {
      type: "object",
      properties: { ...graphIdProperty, nodeId: { type: "string" } },
      required: ["nodeId"],
    },
  },
  {
    name: "get_related",
    description:
      "Deprecated. This will be removed after a quarter. Use recommend. Shortest relationship path between two nodes.",
    inputSchema: {
      type: "object",
      properties: { ...graphIdProperty, fromId: { type: "string" }, toId: { type: "string" } },
      required: ["fromId", "toId"],
    },
  },
  {
    name: "get_subgraph",
    description:
      "Deprecated. This will be removed after a quarter. Use recommend. A bounded neighbourhood around a node.",
    inputSchema: {
      type: "object",
      properties: {
        ...graphIdProperty,
        nodeId: { type: "string" },
        level: { type: "string" },
        viewMode: { type: "string" },
        maxNodes: { type: "number", description: "Default 60, hard cap 300." },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "get_health",
    description:
      "Deprecated. This will be removed after a quarter. Use learn_library. Design-system health: most reused components, unused components, frames with no component usage, orphaned screens, unresolved instances.",
    inputSchema: { type: "object", properties: { ...graphIdProperty } },
  },
];

/* ------------------------------------------------------------------ */

/** MCP size guard for get_ingredients (about 3k tokens of the structured card). The CLI prints the full card. Markdown is shorter. */
export const INGREDIENTS_MCP_MAX_CHARS = 12_000;
/** MCP size guard for get_handoff (about 10k tokens of the structured card). Over it, parts are shown one level less deep at a time until it fits. The CLI prints everything. Markdown is shorter. */
export const HANDOFF_MCP_MAX_CHARS = 40_000;

export function encodeToolResult(result: unknown, format: ToolCardFormat = "markdown", tool?: string): string {
  return presentToolResult(result, format, tool);
}

export function toolCardFormat(value: unknown): ToolCardFormat {
  if (value === undefined || value === "markdown") return "markdown";
  if (value === "json") return "json";
  throw new ToolError('`format` must be "markdown" or "json".');
}

export class ToolError extends Error {}

const asString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new ToolError(`\`${name}\` is required.`);
  return value;
};

const asNumber = (value: unknown, fallback: number, cap: number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, cap);
};

function parseLearnOutline(value: unknown): Array<{ id: string; name: string; kind: "page" | "frame" }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const units: Array<{ id: string; name: string; kind: "page" | "frame" }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
    const name = typeof rec["name"] === "string" ? rec["name"].trim() : id;
    const kind = rec["kind"] === "page" ? "page" : "frame";
    if (!id) continue;
    units.push({ id, name: name || id, kind });
  }
  return units.length ? units : undefined;
}

function recipeAlreadyEncodes(pattern: { masterId: string; name: string }, recipes: Recipe[]): boolean {
  return recipes.some((recipe) =>
    recipe.slots.some(
      (slot) => slot.defaultMasterId === pattern.masterId || slot.defaultMasterId === pattern.name,
    ),
  );
}

const asStringList = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items.map((item) => item.trim()) : undefined;
};

function loadBindRulesSafe() {
  return readBindRules();
}

function requireConfirmedBy(args: Record<string, unknown>): string {
  const value = typeof args["confirmedBy"] === "string" ? args["confirmedBy"].trim() : "";
  if (!value) {
    throw new ToolError(
      "approve_proposal / reject_proposal need confirmedBy: '<human name>'. Agents cannot confirm.",
    );
  }
  return value;
}

function libraryRulesFromArgs(args: Record<string, unknown>) {
  const inline = parseLibraryRules({ allow: args["allow"], deny: args["deny"] });
  try {
    const fromFile = readLibraryRules(typeof args["rulesFile"] === "string" ? args["rulesFile"] : undefined);
    if (!fromFile && !inline.allow && !inline.deny) return undefined;
    return {
      allow: inline.allow ?? fromFile?.allow,
      deny: inline.deny ?? fromFile?.deny,
    };
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : String(error));
  }
}

function contextBindFromArgs(args: Record<string, unknown>) {
  return loadContextBind({
    pack: typeof args["pack"] === "string" ? args["pack"] : undefined,
    product: typeof args["product"] === "string" ? args["product"] : undefined,
    journey: typeof args["journey"] === "string" ? args["journey"] : undefined,
    domain: typeof args["domain"] === "string" ? args["domain"] : undefined,
    audience: typeof args["audience"] === "string" ? args["audience"] : undefined,
    a11y: typeof args["a11y"] === "string" ? args["a11y"] : undefined,
    packsFile: typeof args["packsFile"] === "string" ? args["packsFile"] : undefined,
  });
}

function context(args: Record<string, unknown>) {
  const graphId = typeof args["graphId"] === "string" ? args["graphId"] : undefined;
  const resolved = resolveGraph(graphId);
  if (!resolved) {
    const available = listGraphs().map((entry) => entry.graphId);
    throw new ToolError(
      available.length
        ? `Unknown or ambiguous graphId. Available: ${available.join(", ")}. Pass one explicitly.`
        : missingGraphMessage(),
    );
  }
  return resolved;
}

function requireNode(index: GraphIndex, nodeId: string): GraphNode {
  const node = index.getNode(nodeId);
  if (!node) throw new ToolError(`Node \`${nodeId}\` is not in this graph.`);
  return node;
}

/** Small projection — an agent does not need the raw metadata bag. */
const brief = (node: GraphNode) => ({
  id: node.id,
  name: node.name,
  type: node.type,
  figmaNodeId: node.figmaNodeId,
  ...(node.fileKey ? { fileKey: node.fileKey } : {}),
  status: node.status,
  owner: node.owner,
});

function attachCardMeta(result: unknown, args: Record<string, unknown>): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const fileKey =
    (typeof args["fileKey"] === "string" && args["fileKey"].trim()) ||
    resolveGraph()?.graph.fileKey;
  if (
    fileKey &&
    (typeof args["lastModified"] === "string" || typeof args["version"] === "string")
  ) {
    saveSock(
      applyFreshness(readSock(), [
        {
          fileKey,
          lastModified: typeof args["lastModified"] === "string" ? args["lastModified"] : undefined,
          version: typeof args["version"] === "string" ? args["version"] : undefined,
        },
      ]),
    );
  }
  const freshness = freshnessSummary(readSock(), fileKey);
  return freshness ? { ...result, freshness } : result;
}

export function callTool(name: string, rawArgs: unknown): unknown {
  const advanced = process.env["RESOLVE_MCP_ADVANCED"] === "1";
  const allowed = new Set(listToolDefinitions(advanced).map((tool) => tool.name));
  if (!allowed.has(name)) {
    throw new ToolError(
      `Tool "${name}" is not on the default MCP surface. Set RESOLVE_MCP_ADVANCED=1 to enable it. Agents cannot call advanced tools.`,
    );
  }
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const result = attachCardMeta(withDeprecation(name, dispatchTool(name, args)), args);
  if (result && typeof result === "object" && "cost" in result) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) return withCost(result);
  return result;
}

function dispatchTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "learn_library": {
      try {
        const fileKey = asString(args["fileKey"] ?? args["file_key"], "fileKey");
        const roleRaw = typeof args["role"] === "string" ? args["role"] : undefined;
        const role = roleRaw === undefined || roleRaw.trim() === "" ? undefined : parseIngestRole(roleRaw);
        return {
          ...learnLibrary({
            fileKey,
            role,
            fileName: typeof args["fileName"] === "string" ? args["fileName"] : undefined,
            label: typeof args["label"] === "string" ? args["label"] : undefined,
            metadataXml: typeof args["metadataXml"] === "string" ? args["metadataXml"] : undefined,
            libraries: args["libraries"],
            designContext: args["designContext"],
            lastModified: typeof args["lastModified"] === "string" ? args["lastModified"] : undefined,
            version: typeof args["version"] === "string" ? args["version"] : undefined,
            resume: args["resume"] === true,
            outline: parseLearnOutline(args["outline"]),
          }),
          store: storeInfo(),
        };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (error instanceof Error) throw new ToolError(error.message);
        throw error;
      }
    }

    case "list_soci":
      return {
        proposals: listSoci(readSock()),
        pendingImprovements: readSock().proposals.filter((row) => row.status === "pending").length,
        hint: "SOCI never auto-applies. Approve with approve_proposal (confirmedBy) or CLI: resolve approve <id> --who <name>. Recipe updates write recipes.json; variant/deprecation record a decision only.",
      };

    case "approve_proposal":
    case "reject_proposal": {
      const proposalId = asString(args["proposalId"] ?? args["id"], "proposalId");
      const who = requireConfirmedBy(args);
      const action = name === "approve_proposal" ? "approve" : "reject";
      try {
        const loaded = loadGraph();
        const decided = applySociDecision(
          readSock(),
          readBindRules(),
          proposalId,
          action,
          who,
          new Date().toISOString(),
          {
            index: loaded?.index,
            workspace: readWorkspace(),
            recipes: loadRecipes(),
            overlay: readRecipeOverlay(),
            note: typeof args["note"] === "string" ? args["note"] : undefined,
          },
        );
        commitProposalDecision(decided);
        const hint =
          action === "reject"
            ? "Proposal rejected. Audit line appended. SOCI never auto-applies."
            : decided.writesRecipes
              ? "Recipe overlay written atomically. Audit line appended. Figma was not edited."
              : decided.writesRules
                ? "Rule written to bind-rules.json. Audit line appended. Agents now rank/verify with it."
                : "Decision recorded for the design team. bind-rules.json and Figma were not edited. Audit line appended.";
        return {
          ok: true,
          action,
          proposalId,
          who: decided.audit.who,
          when: decided.audit.when,
          rules: decided.rules.rules,
          ...(decided.writesRecipes ? { recipesWritten: true } : {}),
          hint,
        };
      } catch (error) {
        if (error instanceof BindRuleError) throw new ToolError(error.message);
        throw error;
      }
    }

    case "get_example": {
      const { index } = context(args);
      const bind = contextBindFromArgs(args);
      const pack = packForRecommend(bind);
      const screenType = typeof args["screenType"] === "string" ? args["screenType"] : undefined;
      const resolvedContext = pack || screenType
        ? { ...(pack ?? {}), ...(screenType ? { screenType, id: pack?.id ?? screenType } : {}) }
        : undefined;
      return exampleCard(index, asString(args["name"] ?? args["id"] ?? args["query"], "name"), {
        ...(resolvedContext ? { context: resolvedContext } : {}),
        workspace: bind.workspace,
        sock: readSock(),
        placeholders: readPlaceholders(),
      });
    }

    case "resolve": {
      const { index } = context(args);
      const budget = typeof args["budgetChars"] === "number" ? args["budgetChars"] : undefined;
      const bind = contextBindFromArgs(args);
      const pack = packForRecommend(bind);
      const screenType = typeof args["screenType"] === "string" ? args["screenType"] : undefined;
      const resolvedContext = pack || screenType
        ? { ...(pack ?? {}), ...(screenType ? { screenType, id: pack?.id ?? screenType } : {}) }
        : undefined;
      const card = componentUsageCard(index, asString(args["name"] ?? args["query"], "name"), {
        budgetChars: budget,
        sock: readSock(),
        workspace: bind.workspace ?? readWorkspace(),
        placeholders: readPlaceholders(),
        ...(resolvedContext ? { context: resolvedContext } : {}),
      });
      const echo = pack ? appliedContext(pack) : undefined;
      if (!echo) return card;
      const shown = { ...card, context: echo, ...(pack?.warning ? { warning: pack.warning } : {}) };
      const cap = budget ?? 2000;
      return JSON.stringify(shown).length <= cap ? shown : card;
    }

    case "orient": {
      const { index, graphId } = context(args);
      return withCost({ graphId, ...buildOrientBrief(index) });
    }

    case "query": {
      const { index } = context(args);
      const question = asString(args["question"] ?? args["query"], "question");
      const budget = typeof args["budgetChars"] === "number" ? args["budgetChars"] : undefined;
      return queryQuestion(index, question, { budgetChars: budget });
    }

    case "path": {
      const { index } = context(args);
      return pathBetween(
        index,
        asString(args["from"] ?? args["fromId"], "from"),
        asString(args["to"] ?? args["toId"], "to"),
      );
    }

    case "explain": {
      const { index } = context(args);
      const task = typeof args["task"] === "string" ? args["task"] : undefined;
      return explainNode(index, asString(args["name"] ?? args["nodeId"], "name"), task);
    }

    case "recommend": {
      const { index } = context(args);
      const budget = typeof args["budgetChars"] === "number" ? args["budgetChars"] : undefined;
      const bind = contextBindFromArgs(args);
      const pack = packForRecommend(bind);
      const screenType = typeof args["screenType"] === "string" ? args["screenType"] : undefined;
      const resolvedContext = pack || screenType
        ? { ...(pack ?? {}), ...(screenType ? { screenType, id: pack?.id ?? screenType } : {}) }
        : undefined;
      const intent = asString(args["intent"] ?? args["question"] ?? args["query"], "intent");
      const screen = screenAskCard(intent, { sock: readSock(), index, recipes: loadRecipes() });
      if (screen) {
        recordGap(intent, screen);
        return screen;
      }
      const card = recommendMasters(index, intent, {
        budgetChars: budget,
        ...(resolvedContext ? { context: resolvedContext } : {}),
        workspace: bind.workspace,
        sock: readSock(),
        bindRules: mergeBindRules(loadBindRulesSafe(), pack?.bindRules),
        placeholders: readPlaceholders(),
      });
      recordGap(intent, card);
      return card;
    }

    case "check_cousins": {
      const graphId = typeof args["graphId"] === "string" ? args["graphId"] : undefined;
      const bind = contextBindFromArgs(args);
      const frame = typeof args["frame"] === "string" ? args["frame"] : undefined;
      const components = asStringList(args["components"]);
      const job = typeof args["job"] === "string" ? args["job"] : undefined;
      const fileKey = typeof args["fileKey"] === "string" ? args["fileKey"] : undefined;
      if (!frame && !components && !job && !fileKey?.trim()) {
        throw new ToolError("`frame`, `components`, `fileKey`, or `job` is required.");
      }
      return checkCousins(resolveGraph(graphId)?.index, {
        frame,
        fileKey,
        components,
        job,
        recipes: loadRecipes(),
        context: packForRecommend(bind),
        workspace: bind.workspace ?? readWorkspace(),
      });
    }

    case "check_frame": {
      const { index } = context(args);
      return checkFrame(index, asString(args["intent"] ?? args["question"], "intent"));
    }

    case "verify_frame": {
      const { index } = context(args);
      const frame = typeof args["frame"] === "string" ? args["frame"] : undefined;
      const components = asStringList(args["components"]);
      if (!frame && !components) {
        throw new ToolError("`frame` or `components` is required.");
      }
      const bind = contextBindFromArgs(args);
      const pack = packForRecommend(bind);
      let result;
      try {
        result = verifyFrame(index, {
          frame,
          components,
          rules: libraryRulesFromArgs(args),
          context: pack,
          bindRules: mergeBindRules(loadBindRulesSafe(), pack?.bindRules),
          sock: readSock(),
          workspace: bind.workspace ?? readWorkspace(),
          placeholders: readPlaceholders(),
          designContext: args["designContext"],
          texts: args["texts"],
        });
      } catch (error) {
        if (error instanceof TextInputError) throw new ToolError(error.message);
        throw error;
      }
      recordVerifyUsage(index, result, {
        frame,
        components,
        bind,
        slot: typeof args["slot"] === "string" ? args["slot"] : undefined,
        journey: typeof args["journey"] === "string" ? args["journey"] : undefined,
        product: typeof args["product"] === "string" ? args["product"] : undefined,
        pack: typeof args["pack"] === "string" ? args["pack"] : undefined,
        domain: typeof args["domain"] === "string" ? args["domain"] : undefined,
      });
      return withPendingImprovements(result, readSock());
    }

    case "list_recipes": {
      const graphId = typeof args["graphId"] === "string" ? args["graphId"] : undefined;
      return capRecipePayload(
        listRecipes(
          loadRecipes(),
          resolveGraph(graphId)?.index,
          contextBindFromArgs(args),
          readSock(),
          loadBindRulesSafe(),
          readPlaceholders(),
        ),
      );
    }

    case "recipe":
    case "get_recipe": {
      const rawQuery = args["query"] ?? args["name"] ?? args["recipe"] ?? args["intent"];
      const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
      if (!query || query === "list") {
        const graphId = typeof args["graphId"] === "string" ? args["graphId"] : undefined;
        return capRecipePayload(
          listRecipes(
            loadRecipes(),
            resolveGraph(graphId)?.index,
            contextBindFromArgs(args),
            readSock(),
            loadBindRulesSafe(),
            readPlaceholders(),
          ),
        );
      }
      const intent = typeof args["intent"] === "string" ? args["intent"].trim() : "";
      const extra = intent && intent !== query ? intent : undefined;
      const graphId = typeof args["graphId"] === "string" ? args["graphId"] : undefined;
      const recipes = loadRecipes();
      const screen = screenAskCard(query, { sock: readSock(), index: resolveGraph(graphId)?.index, recipes });
      if (screen) return withPendingImprovements(screen, readSock());
      const ranked = rankRecipes(recipes, query);
      const card = recipeCard(
        recipes,
        ranked[0]?.id ?? query,
        resolveGraph(graphId)?.index,
        extra,
        contextBindFromArgs(args),
        readSock(),
        loadBindRulesSafe(),
        readPlaceholders(),
      );
      const also = ranked.slice(1).map((recipe) => recipe.title);
      return withPendingImprovements(
        capRecipePayload(also.length ? { ...card, also } : card),
        readSock(),
      );
    }

    case "get_ingredients": {
      const { index } = context(args);
      const depth = typeof args["depth"] === "number" ? args["depth"] : Number(args["depth"] ?? 1);
      return ingredientCard(index, asString(args["name"] ?? args["id"] ?? args["query"], "name"), {
        variant: typeof args["variant"] === "string" ? args["variant"] : undefined,
        depth: Number.isFinite(depth) ? Math.min(Math.max(Math.floor(depth), 1), 3) : 1,
        maxChars: INGREDIENTS_MCP_MAX_CHARS,
      });
    }

    case "get_handoff": {
      const { index } = context(args);
      const frames = asStringList(args["frames"]) ?? (typeof args["frame"] === "string" && args["frame"].trim() ? [args["frame"]] : undefined);
      if (!frames?.length) throw new ToolError("`frame` or `frames` is required.");
      const asked = typeof args["depth"] === "number" ? args["depth"] : Number(args["depth"] ?? 3);
      const depth = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), 3) : 3;
      const depthNote =
        args["depth"] !== undefined && asked !== depth
          ? { depthNote: `depth ${JSON.stringify(args["depth"]).slice(0, 20)} is not 1, 2 or 3; used ${depth}.` }
          : {};
      const bind = contextBindFromArgs(args);
      const pack = packForRecommend(bind);
      const build = (d: number) =>
        handoffSheet(index, frames, {
          draft: args["allowWeak"] === true,
          recipe: typeof args["recipe"] === "string" ? args["recipe"] : undefined,
          recipes: loadRecipes(),
          ...(pack ? { context: pack } : {}),
          bindRules: mergeBindRules(loadBindRulesSafe(), pack?.bindRules),
          sock: readSock(),
          workspace: bind.workspace ?? readWorkspace(),
          placeholders: readPlaceholders(),
          rules: libraryRulesFromArgs(args),
          decisions: readApprovedDecisions(),
          depth: d,
          maxCharsPerCard: HANDOFF_MCP_MAX_CHARS,
        });
      const full = build(depth);
      if (!full.ok || JSON.stringify(full).length <= HANDOFF_MCP_MAX_CHARS) return { ...full, ...depthNote };
      let d = depth;
      let small: HandoffPack = full;
      while (d > 1 && JSON.stringify(small).length > HANDOFF_MCP_MAX_CHARS) {
        d -= 1;
        small = build(d);
      }
      if (!small.ok) return small;
      // Only the parts lists are cut: open questions and summary come from the full sheet, so nothing an agent must ask is lost.
      const fullScreens = full.screens;
      const screens = small.screens.map((sheet, n) => ({ ...sheet, openQuestions: fullScreens[n]!.openQuestions, summary: fullScreens[n]!.summary }));
      const shown = small.screens.reduce((t, sheet) => t + sheet.ingredients.length, 0);
      const total = fullScreens.reduce((t, sheet) => t + sheet.ingredients.length, 0);
      const questions = fullScreens.reduce((t, sheet) => t + sheet.openQuestions.length, 0);
      const result = { ...small, screens };
      const still = JSON.stringify(result).length > HANDOFF_MCP_MAX_CHARS;
      return {
        ...result,
        ...depthNote,
        cut: {
          maxChars: HANDOFF_MCP_MAX_CHARS,
          depth: d,
          askedDepth: depth,
          partsShown: shown,
          partsTotal: total,
          reason: `the full handoff is over ${HANDOFF_MCP_MAX_CHARS.toLocaleString("en-US")} characters, so parts are listed ${d === 1 ? "one level" : `${d} levels`} deep${d < depth ? ` (asked for ${depth})` : ""}: ${shown} of ${total} parts are listed${still ? " (still over the limit; ask fewer frames)" : ""}. All ${questions} open question${questions === 1 ? "" : "s"} and the summary counts are from the full sheet. Ask get_ingredients for a component's full parts, or run resolve handoff --out for the files.`,
        },
      };
    }

    case "list_graphs": {
      const graphs = listGraphs();
      const store = storeInfo();
      return {
        graphs,
        store,
        hint: graphs.length
          ? "Call list_recipes or recipe \"<job>\", then recommend unbound slots, Figma on returned figmaNodeIds (fileKey + id), then verify_frame. Multi-file workspace: check_cousins on the product frame. Do not Read graph.json."
          : missingGraphMessage(),
      };
    }

    case "find_nodes": {
      const { index, graphId } = context(args);
      const query = asString(args["query"], "query");
      const limit = asNumber(args["limit"], 25, 100);
      const results = searchNodes(index, query, { limit });
      return {
        graphId,
        query,
        count: results.length,
        results: results.map((result) => ({
          ...brief(result.node),
          matchedOn: result.matchedOn,
          isMainComponent: result.node.isMainComponent || undefined,
          isInstance: result.node.isInstance || undefined,
        })),
      };
    }

    case "get_node": {
      const { index, graphId } = context(args);
      const node = requireNode(index, asString(args["nodeId"], "nodeId"));
      const main = node.mainComponentId ? index.getNode(node.mainComponentId) : undefined;

      return {
        graphId,
        node: {
          ...brief(node),
          description: node.description,
          isMainComponent: node.isMainComponent,
          isInstance: node.isInstance,
          isRemote: node.isRemote,
          variantProperties: node.variantProperties,
          figmaUrl: node.figmaUrl,
          identity: node.metadata?.["identity"],
          platforms: node.platforms,
        },
        path: index.getHierarchyPath(node.id).map(brief),
        summary: usageSummaryFor(index, node.id),
        mainComponent: main ? brief(main) : undefined,
        children: index.getChildren(node.id).slice(0, 25).map(brief),
        styles: index.getNodes(node.styleIds ?? []).map(brief),
        variables: index.getNodes(node.variableIds ?? []).map(brief),
      };
    }

    case "get_screen_inventory": {
      const { index, graphId } = context(args);
      const node = requireNode(index, asString(args["nodeId"], "nodeId"));
      const inventory = screenInventory(index, node.id);
      return { graphId, ...inventory };
    }

    case "get_component_usage": {
      const { index, graphId } = context(args);
      const node = requireNode(index, asString(args["nodeId"], "nodeId"));
      return { graphId, ...usageCardForComponent(index, node) };
    }

    case "get_related": {
      const { index, graphId } = context(args);
      const fromId = asString(args["fromId"], "fromId");
      const toId = asString(args["toId"], "toId");
      requireNode(index, fromId);
      requireNode(index, toId);
      return { graphId, ...pathBetween(index, fromId, toId) };
    }

    case "get_subgraph": {
      const { index, graphId } = context(args);
      const nodeId = asString(args["nodeId"], "nodeId");
      requireNode(index, nodeId);

      const subgraph = extractSubgraph(index, {
        focusId: nodeId,
        level: args["level"] as GraphLevel | undefined,
        viewMode: (args["viewMode"] as ViewMode | undefined) ?? "hierarchy",
        maxNodes: asNumber(args["maxNodes"], 60, 300),
      });

      return {
        graphId,
        focusId: subgraph.focusId,
        level: subgraph.level,
        viewMode: subgraph.viewMode,
        truncated: subgraph.truncated,
        hiddenCount: subgraph.hiddenCount,
        nodes: subgraph.nodes.map(brief),
        edges: subgraph.edges.map((edge) => ({
          source: edge.source,
          target: edge.target,
          type: edge.type,
        })),
      };
    }

    case "get_health": {
      const { index, graphId } = context(args);
      const analytics = computeAnalytics(index);
      return {
        graphId,
        store: storeInfo(),
        totals: analytics.totals,
        mostReused: analytics.componentUsage
          .slice(0, 10)
          .map((usage) => ({ ...brief(usage.component), instances: usage.instanceCount })),
        unusedComponents: analytics.unusedComponents.map(brief),
        framesWithoutComponents: analytics.framesWithoutComponents.map(brief),
        orphanedFrames: analytics.orphanedFrames.map(brief),
        unresolvedInstances: analytics.unresolvedInstances.map(brief),
      };
    }

    default:
      throw new ToolError(`Unknown tool \`${name}\`.`);
  }
}

/**
 * Save a passing verify to SOCK: usage facts, cousin corrections, SOCI proposals. MCP verify_frame and CLI verify both
 * call this, so a frame checked from the command line (the AIDLC add-on's design-check) counts as a mapped screen too.
 * Only real frames count toward patterns. The screen job comes from the journey, else the domain, else the frame name.
 */
export function recordVerifyUsage(
  index: GraphIndex,
  result: ReturnType<typeof verifyFrame>,
  input: {
    frame?: string;
    components?: string[];
    bind: ContextBind;
    slot?: string;
    journey?: string;
    product?: string;
    pack?: string;
    domain?: string;
  },
): void {
  if (!result.pass) return;
  const { frame, components, bind } = input;
  const pack = packForRecommend(bind);
  const masters: Array<{
    id: string;
    name: string;
    fileKey?: string;
    figmaNodeId?: string;
    deprecated?: boolean;
    private?: boolean;
  }> = [];
  for (const row of result.resolved) {
    if (!row.id) continue;
    const node = index.getNode(row.id);
    if (!node) continue;
    masters.push({
      id: node.id,
      name: node.name,
      fileKey: row.fileKey,
      figmaNodeId: node.figmaNodeId,
      deprecated: node.status === "deprecated",
      private: isPrivateMasterName(node.name),
    });
  }
  if (result.frame) {
    for (const instance of index.getNestedInstances(result.frame.id)) {
      const main = index.getMainComponent(instance.id);
      if (!main || masters.some((row) => row.id === main.id)) continue;
      masters.push({
        id: main.id,
        name: main.name,
        fileKey: main.fileKey,
        figmaNodeId: main.figmaNodeId,
        deprecated: main.status === "deprecated",
        private: isPrivateMasterName(main.name),
      });
    }
  }
  if (masters.length) {
    const realFrame = isRealVerifiedFrame(result.frame);
    const frameId = result.frame?.figmaNodeId ?? result.frame?.id;
    const screenId = realFrame
      ? `${result.frame!.fileKey}:${frameId}`
      : `obs:${(components ?? []).slice().sort().join(",") || "list"}`;
    const harvested =
      realFrame && result.frame?.id ? harvestOverrideKeysForFrame(index, result.frame.id) : new Map<string, string[]>();
    const slotArg = input.slot;
    const topLevel = result.frame?.id ? new Set(topLevelMasterIds(index, result.frame.id)) : undefined;
    const mastersWithOverrides = masters.map((master) => {
      const keys = harvested.get(master.id);
      const withKeys = keys?.length ? { ...master, overrideKeys: keys } : master;
      const example = result.frame?.id
        ? exampleFactForMasterOnFrame(index, result.frame.id, master.id, readPlaceholders())
        : undefined;
      const withExample = example ? { ...withKeys, ...example } : withKeys;
      const placed = topLevel && !topLevel.has(master.id) ? { ...withExample, nested: true } : withExample;
      if (!slotArg) return placed;
      if (topLevel) {
        return topLevel.has(master.id) ? { ...placed, slot: slotArg } : placed;
      }
      return { ...placed, slot: slotArg };
    });
    const journeyArg = input.journey;
    const screenName = result.frame?.name ?? frame ?? "observation";
    const job = realFrame ? (jobOfName(journeyArg) ?? jobOfName(input.domain) ?? jobOfName(screenName)) : undefined;
    let next = recordVerifiedUsage(readSock(), {
      screenId,
      screenName,
      masters: mastersWithOverrides,
      ...(job ? { job } : {}),
      journey: journeyArg,
      product: input.product,
      pack: input.pack,
      frameId: realFrame ? frameId : undefined,
      countsTowardThreshold: realFrame,
    });
    if (realFrame && result.frame) {
      const cousinReport = checkCousins(index, {
        frame: result.frame.id,
        recipes: loadRecipes(),
        context: pack,
        workspace: bind.workspace ?? readWorkspace(),
      });
      const hits = (cousinReport.cousins ?? [])
        .filter((hit) => hit.confidence === "cousin" && hit.expected)
        .map((hit) => ({
          fromId: hit.placed.id,
          fromName: hit.placed.name,
          fromFileKey: hit.placed.fileKey,
          toId: hit.expected!.id,
          toName: hit.expected!.name,
          toFileKey: hit.expected!.fileKey,
        }));
      next = recordCousinCorrections(next, {
        screenId,
        screenName: result.frame.name ?? frame ?? "frame",
        frameId,
        fileKey: result.frame.fileKey,
        hits,
      });
    }
    saveSock(
      advanceSoci(next, {
        recipes: loadRecipes(),
        index,
        workspace: bind.workspace ?? readWorkspace(),
        alreadyEncoded: (pattern) => recipeAlreadyEncodes(pattern, loadRecipes()),
      }),
    );
  }
}
