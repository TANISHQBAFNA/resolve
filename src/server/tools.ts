import { TextInputError } from "@/core/ingestion/textStamps";
import { CODE_TOOL_NAMES, CODE_TOOLS, runCodeTool } from "./code/mcp.ts";
import { graphMasters } from "./graphMasters.ts";
import { asStringList, parseLearnOutline } from "./toolArgs.ts";
import type { Mode } from "./mode.ts";
import { activeMode, includesPack } from "./mode.ts";
import {
  applyFreshness,
  BindRuleError,
  componentUsageCard,
  freshnessSummary,
  listSoci,
  mergeBindRules,
  parseLibraryRules,
  capRecipePayload,
  listRecipes,
  rankRecipes,
  recipeCard,
  recommendMasters,
  screenAskCard,
  verifyFrame,
  exampleCard,
  withCost,
  withPendingImprovements,
  checkCousins,
  appliedContext,
  packForRecommend,
  withScreenType,
  parseIngestRole,
  ingredientCard,
  handoffSheet,
  type HandoffPack,
  applyBriefIntent,
  briefAnswerLines,
  briefAnswerParts,
  briefAnswers,
  briefScreen,
  BriefAnswerError,
} from "@/core/query";
import { presentToolResult, type ToolCardFormat } from "./cards";
import { learnLibrary } from "./learn";
import { DEPRECATED_INSTEAD, REMOVED_MCP_TOOLS, withDeprecation } from "./deprecations";
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
  proposalDecisionBody,
  readApprovedDecisions,
  runProposalDecision,
} from "./store";
import { recordGap } from "./gaps";
import { callCodeMapAlias } from "./codeMapMcp";
import { SPEC_TOOLS, runSpecTool } from "./specMcp";
import { DECISION_TOOLS, RECORD_PROPERTY, recordProblem, runDecisionTool, withDecisionRecord } from "./decisionMcp";
import { composeProblem, runCompose } from "./composeCommand";
import { recordVerifyUsage } from "./verifyRecord";

export { recordVerifyUsage };

/**
 * Optional MCP tools. The default surface is learn_library, recipe, recommend, resolve,
 * get_example, verify_frame, and check_cousins. Set RESOLVE_MCP_ADVANCED=1 for the rest.
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
  "brief",
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

/** Figma pack tools only in figma/both, code pack tools only in code/both. */
export function listToolDefinitions(advanced = process.env["RESOLVE_MCP_ADVANCED"] === "1", mode: Mode = activeMode()): ToolDefinition[] {
  const allowed = new Set<string>(DEFAULT_TOOL_NAMES);
  const figma = includesPack(mode, "figma") ? (advanced ? TOOLS : TOOLS.filter((tool) => allowed.has(tool.name))) : [];
  const tools = [...figma, ...(includesPack(mode, "code") ? CODE_TOOLS : [])];
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

const CODE_TOOL_SET = new Set<string>(CODE_TOOL_NAMES);

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
        answers: {
          type: "object",
          description: "Briefing answers. Topics: shape, states, platform. states may be a list. At most 3 answers. Unknown topic or option is an error.",
          additionalProperties: true,
        },
        ...freshnessProperties,
      },
      required: ["intent"],
    },
  },
  {
    name: "brief",
    description:
      "Before recommend on a screen request. Asks at most 3 multiple-choice questions, and only when the request fits the library and the answer would change the component. Topics: data shape (list, form, summary, counts), states (empty, loading, error, pending; more than one allowed), and platform. No screen-type goal question. Options are live masters. Platform is asked only when the best part comes in platform versions (Desktop Nav, Mobile Nav); a platform word alone is not a component. Nothing that fits returns no match and no questions. 'Just build' (also 'go ahead and build' or 'build without asking') asks nothing; with no match it returns no candidates. Pass answers to recommend and get_handoff; they change the parts. Unknown topic, unknown option, empty value, a duplicate, or more than 3 answers is an error. Do not invent a component. Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...RECORD_PROPERTY,
        ...graphIdProperty,
        request: { type: "string", description: "The screen request, in the designer's words." },
        answers: {
          type: "object",
          description: "Answers already given. shape and platform take one option. states takes one or more. At most 3 answers.",
          additionalProperties: true,
        },
        pack: { type: "string", description: "Context pack id. Same rules as recommend." },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        ...screenContextProperties,
      },
      required: ["request"],
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
    name: "verify_frame",
    description:
      "After drawing, check a frame or a proposed component list against the library graph and bind rules. Pass iff every placement is an in-graph master, not deprecated, and bind require/forbid rules hold. Before verify, fetch the frame's design context so Resolve can read the text — pass it as designContext. texts fills empty layers inside this frame only and cannot replace stored copy or component defaults. textChecked is true only when instance text and the component default were both read; otherwise it is partial, false, or n/a. A component list with no frame is textChecked false. Warnings (not failures) for leftover default text and a fixed height that clearly exceeds the content. Known placeholder strings fail. A bind-rule fail names the rule and returns the required master id + place hint. Optional allow/deny. The card also has a Proper use section: detached frames that match a library component, unbound colours and spacing, property values, contrast, tap size, and icon-only buttons. A check with no boundVariables or styles is unknown, not a failure. The first line states both results; proper-use errors fail that line. Pass all: true to list every finding. The default card keeps every error and says how to see the rest. Deterministic — no LLM.",
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
        all: {
          type: "boolean",
          description:
            "List every proper-use finding. The card may exceed 600 characters. Omit it to keep every error and a line that says how to see the rest.",
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
        ...RECORD_PROPERTY,
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
        compose: { type: "boolean", description: "Advanced only. When no saved recipe fits, compose one from the parts the request names. Never invents; empty slots say No match. Not saved." },
        propose: { type: "boolean", description: "Advanced only, with compose. File the composed recipe as a pending proposal; a person approves it to save." },
        answers: { type: "object", additionalProperties: true, description: "With compose. Briefing answers; shape and state answers add their parts as slots." },
        ...screenContextProperties,
        ...freshnessProperties,
      },
    },
  },
  {
    name: "get_ingredients",
    description:
      "What is inside a component: the library parts placed directly in it, for a developer handoff. Follows one variant: pass variant (\"Size=Medium\"), else the first in the set. A placed instance id reads that copy's own parts at every level. Where the copy's insides were not learned, the card says the parts are from the main component (not checked on this screen, or not checked on the copy inside this component). Variant is refused for an instance id. Each part shows fileKey and figmaNodeId, its code component from .resolve/code-map.json, or that there is no code link (never guessed), plus selector, module or standalone, import path, inputs and outputs when the map entry has a selector. A structured card over 12,000 characters is shown less deep, then fewer parts per level, and says what was cut. Ask a part by name for its own card. Status is current, retired (old code, and what to use instead), unconfirmed (a guess from the layer name), other-library, or not-found. Exact name or id only. An unknown name says it was not found and to call recommend. Markdown by default. Advanced surface. Do not Read graph.json.",
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
      "Developer handoff sheet for one or more designed screens (frames): recipe slots, each component placed on the screen with fileKey and figmaNodeId and its code from .resolve/code-map.json (unmapped when there is no entry; never guessed), selector, module, inputs and outputs, suggested inputs from Figma variant properties (Variant=Primary becomes variant=\"primary\") and a suggested template line, the parts inside each component, a PASS or FAIL line, approved decisions (who, when, why), and open questions. Refuses when a retired component is on a screen (always), or when a component is only a guess from its layer name ('MCP metadata insufficient for component X. Use Figma REST or design_context.'). allowWeak makes a draft instead, labelled name-guess; drafts are not for build. Over 40,000 characters of the structured card, parts are shown one level less deep at a time until it fits, and the card says how many parts are listed. Open questions and the summary counts always come from the full sheet. Markdown lists each part once, on its component, not again as a second parts table. A copy whose component is in no learned file is refused as not-found. A component from a library file that is not learned is other-library (no Figma id of this file, code unknown, not counted as unmapped). A not-found component is code unknown too. The card lists the other values of each Figma property (the placed one is left out). A recipe slot is placed, inside another component (the card names it), or missing. Placed and inside both count as covered. One copy fills one slot. A frame can be a pasted Figma link with node-id. Markdown by default. Advanced surface. Do not Read graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        ...RECORD_PROPERTY,
        ...graphIdProperty,
        frame: { type: "string", description: "Frame name, graph id, figma node id or fileKey:nodeId." },
        frames: { type: "array", items: { type: "string" }, description: "Several frames for one handoff pack." },
        allowWeak: { type: "boolean", description: "Draft: allow components known only from layer names (labelled name-guess) or missing from the learned files (labelled not-found). Retired components still refuse." },
        recipe: { type: "string", description: "Recipe id or intent to check the screen against. Default: matched from the screen name." },
        depth: { type: "number", description: "Levels of parts per component, 1-3. Default 3. Any other value is clamped, and depthNote says so." },
        answers: {
          type: "object",
          description: "Briefing answers. Shape and state answers are added to the parts, not only listed as a note. At most 3 answers.",
          additionalProperties: true,
        },
        pack: { type: "string" },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
        ...screenContextProperties,
      },
    },
  },
  ...SPEC_TOOLS,
  ...DECISION_TOOLS,
  {
    name: "list_graphs",
    description:
      "List stored graphs and the store this server is reading (path, graph.json, builtAt). RESOLVE_HOME wins; else the nearest .resolve walking up from cwd. Call this to confirm MCP and CLI share one folder.",
    inputSchema: { type: "object", properties: {} },
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

function recommendContextFromArgs(args: Record<string, unknown>) {
  const bind = contextBindFromArgs(args);
  const pack = packForRecommend(bind);
  const screenType = typeof args["screenType"] === "string" ? args["screenType"] : undefined;
  return { bind, pack, context: withScreenType(pack, screenType) };
}

function listedRecipes(args: Record<string, unknown>) {
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

function specRanking(args: Record<string, unknown>) {
  const { bind, pack, context: resolved } = recommendContextFromArgs(args);
  return { ...(resolved ? { context: resolved } : {}), workspace: bind.workspace, sock: readSock(), bindRules: mergeBindRules(loadBindRulesSafe(), pack?.bindRules), placeholders: readPlaceholders() };
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

function briefingAnswers(raw: unknown, index: ReturnType<typeof context>["index"]) {
  try {
    const answers = briefAnswers(raw);
    return {
      answers,
      lines: briefAnswerLines(answers, index),
      parts: briefAnswerParts(answers, index),
      intent(request: string) {
        return applyBriefIntent(request, answers, index);
      },
    };
  } catch (error) {
    if (error instanceof BriefAnswerError) throw new ToolError(error.message);
    throw error;
  }
}

export function callTool(name: string, rawArgs: unknown): unknown {
  if (REMOVED_MCP_TOOLS.has(name)) {
    const instead = DEPRECATED_INSTEAD[name] ?? "the current tools";
    throw new ToolError(`Tool "${name}" was removed. Use ${instead}.`);
  }
  try {
    const aliased = callCodeMapAlias(name, rawArgs, (args) => context(args).index);
    if (aliased !== undefined) return aliased && typeof aliased === "object" && !Array.isArray(aliased) ? withCost(aliased) : aliased;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(error instanceof Error ? error.message : String(error));
  }
  const advanced = process.env["RESOLVE_MCP_ADVANCED"] === "1";
  const allowed = new Set(listToolDefinitions(advanced).map((tool) => tool.name));
  if (!allowed.has(name)) {
    const mode = activeMode();
    const figmaTool = TOOLS.some((tool) => tool.name === name);
    if (figmaTool && !includesPack(mode, "figma")) throw new ToolError(`Tool "${name}" is in the Figma workflow, which is off (mode: ${mode}). Set mode to figma or both in .resolve/config.json, or RESOLVE_MODE.`);
    if (CODE_TOOL_SET.has(name) && !includesPack(mode, "code")) throw new ToolError(`Tool "${name}" is in the code workflow, which is off (mode: ${mode}). Set mode to code or both in .resolve/config.json, or RESOLVE_MODE.`);
    throw new ToolError(
      `Tool "${name}" is not on the default MCP surface. Set RESOLVE_MCP_ADVANCED=1 to enable it. Agents cannot call advanced tools.`,
    );
  }
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  if (CODE_TOOL_SET.has(name)) {
    try {
      return runCodeTool(name, args, graphMasters);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
  }
  const recordIssue = recordProblem(name, args);
  if (recordIssue) throw new ToolError(recordIssue);
  const result = attachCardMeta(withDeprecation(name, withDecisionRecord(name, args, dispatchTool(name, args), advanced)), args);
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
        const note = typeof args["note"] === "string" ? args["note"] : undefined;
        const decided = runProposalDecision(proposalId, action, who, note);
        const hint =
          action === "reject"
            ? "Proposal rejected. Audit line appended. SOCI never auto-applies."
            : decided.writesRecipes
              ? "Recipe overlay written atomically. Audit line appended. Figma was not edited."
              : decided.writesRules
                ? "Rule written to bind-rules.json. Audit line appended. Agents now rank/verify with it."
                : "Decision recorded for the design team. bind-rules.json and Figma were not edited. Audit line appended.";
        return { ...proposalDecisionBody(decided, action, proposalId), hint };
      } catch (error) {
        if (error instanceof BindRuleError) throw new ToolError(error.message);
        throw error;
      }
    }

    case "get_example": {
      const { index } = context(args);
      const { bind, context: resolvedContext } = recommendContextFromArgs(args);
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
      const { bind, pack, context: resolvedContext } = recommendContextFromArgs(args);
      const card = componentUsageCard(index, asString(args["name"] ?? args["query"], "name"), {
        budgetChars: budget,
        sock: readSock(),
        workspace: bind.workspace ?? readWorkspace(),
        placeholders: readPlaceholders(),
        bindRules: mergeBindRules(loadBindRulesSafe(), pack?.bindRules),
        ...(resolvedContext ? { context: resolvedContext } : {}),
      });
      const echo = pack ? appliedContext(pack) : undefined;
      if (!echo) return card;
      const shown = { ...card, context: echo, ...(pack?.warning ? { warning: pack.warning } : {}) };
      const cap = budget ?? 2000;
      return JSON.stringify(shown).length <= cap ? shown : card;
    }

    case "brief": {
      const { index } = context(args);
      const request = asString(args["request"] ?? args["intent"] ?? args["query"], "request");
      const { bind, pack, context: resolvedContext } = recommendContextFromArgs(args);
      const briefing = briefingAnswers(args["answers"], index);
      return briefScreen({
        request,
        answers: briefing.answers,
        index,
        recipes: loadRecipes(),
        decisions: readApprovedDecisions(),
        ...(resolvedContext ? { context: resolvedContext } : {}),
        workspace: bind.workspace,
        sock: readSock(),
        bindRules: mergeBindRules(loadBindRulesSafe(), pack?.bindRules),
        placeholders: readPlaceholders(),
      });
    }

    case "recommend": {
      const { index } = context(args);
      const budget = typeof args["budgetChars"] === "number" ? args["budgetChars"] : undefined;
      const { bind, pack, context: resolvedContext } = recommendContextFromArgs(args);
      const intent = briefingAnswers(args["answers"], index).intent(
        asString(args["intent"] ?? args["question"] ?? args["query"], "intent"),
      );
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
          ...(args["all"] === true ? { all: true } : {}),
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

    case "list_recipes":
      return listedRecipes(args);

    case "recipe": {
      const rawQuery = args["query"] ?? args["name"] ?? args["recipe"] ?? args["intent"];
      const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
      const compose = args["compose"] !== undefined || args["propose"] !== undefined;
      const problem = composeProblem(args["compose"], args["propose"], query);
      if (problem?.includes("must be") || (problem && compose && process.env["RESOLVE_MCP_ADVANCED"] === "1")) throw new ToolError(problem);
      if (!query || query === "list") return listedRecipes(args);
      const intent = typeof args["intent"] === "string" ? args["intent"].trim() : "";
      const extra = intent && intent !== query ? intent : undefined;
      const graphId = typeof args["graphId"] === "string" ? args["graphId"] : undefined;
      const recipes = loadRecipes();
      if (compose && process.env["RESOLVE_MCP_ADVANCED"] === "1") {
        const { index } = context(args);
        const answerParts = briefingAnswers(args["answers"], index).parts;
        const input = { request: query, answerParts, index, recipes, bind: contextBindFromArgs(args), sock: readSock(), bindRules: loadBindRulesSafe(), placeholders: readPlaceholders() };
        return capRecipePayload(runCompose(input, args["propose"] === true));
      }
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
      const note = compose ? { compose: "Composing needs the advanced surface (RESOLVE_MCP_ADVANCED=1)." } : {};
      return withPendingImprovements(
        capRecipePayload({ ...card, ...(also.length ? { also } : {}), ...note }),
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
      const briefing = briefingAnswers(args["answers"], index);
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
          ...(briefing.lines.length ? { briefing: briefing.lines } : {}),
          ...(briefing.parts.length ? { briefParts: briefing.parts } : {}),
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

    default: {
      if (name === "spec_map") return runSpecTool(args, context(args).index, specRanking(args));
      if (name === "decision_record") return runDecisionTool(name, args);
      throw new ToolError(`Unknown tool \`${name}\`.`);
    }
  }
}
