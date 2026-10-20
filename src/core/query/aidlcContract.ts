import { z } from "zod/v4";
import type { DecisionRecord } from "./decisionRecord";
import type { HandoffPack } from "./handoff";

/**
 * AIDLC hook: the contract between Resolve and AIDLC stages.
 * requirementsContext goes in to AIDLC; designHandoff comes out of Resolve.
 * This zod schema is the one owner; schemas/aidlc-handoff.schema.json is generated from it.
 * Opt-in: only `resolve export aidlc` (or MCP export_aidlc) builds it, from files a handoff already wrote.
 */

export const AIDLC_SCHEMA_VERSION = 1 as const;

const Pick = z.object({
  name: z.string(),
  id: z.string().optional(),
  fileKey: z.string().optional(),
  figmaNodeId: z.string().optional(),
  source: z.string(),
  match: z.string(),
  why: z.string().optional(),
  screen: z.string().optional(),
  slot: z.string().optional(),
});

const Part = z.object({
  name: z.string(),
  variant: z.string().optional(),
  fileKey: z.string().optional(),
  figmaNodeId: z.string().optional(),
  count: z.number().int().min(0),
  identity: z.string(),
  status: z.string(),
  slot: z.string().optional(),
  /** Code from the code map, "unmapped" (never guessed), or "unknown". */
  code: z.string(),
  angular: z
    .object({ selector: z.string(), importPath: z.string(), module: z.string().optional(), standalone: z.literal(true).optional() })
    .optional(),
  /** Other values each Figma property can take: the states to build. */
  states: z.record(z.string(), z.array(z.string())).optional(),
});

export const AidlcHandoffSchema = z.object({
  schemaVersion: z.literal(AIDLC_SCHEMA_VERSION),
  kind: z.literal("resolve.aidlc"),
  requirementsContext: z.object({
    request: z.string().optional(),
    screens: z.array(z.string()),
    product: z.string().optional(),
    journey: z.string().optional(),
    audience: z.string().optional(),
    a11y: z.string().optional(),
    answers: z.object({ shape: z.string().optional(), platform: z.string().optional(), states: z.array(z.string()) }).optional(),
    assumptions: z.array(z.string()),
    openQuestions: z.array(z.string()),
  }),
  designHandoff: z.object({
    draft: z.boolean(),
    codeMap: z.boolean(),
    screens: z.array(
      z.object({
        name: z.string(),
        fileKey: z.string().optional(),
        figmaNodeId: z.string().optional(),
        recipe: z.object({ id: z.string(), title: z.string(), matchedBy: z.string() }).optional(),
        parts: z.array(Part),
        verify: z.object({ pass: z.boolean(), retired: z.array(z.string()), unresolved: z.array(z.string()) }),
        openItems: z.array(z.string()),
      }),
    ),
    decisions: z.object({
      recorded: z.boolean(),
      picks: z.array(Pick),
      rejected: z.array(z.object({ what: z.string(), reason: z.string(), screen: z.string().optional() })),
    }),
  }),
});

export type AidlcHandoff = z.infer<typeof AidlcHandoffSchema>;

/** The JSON Schema AIDLC validates against. Generated from AidlcHandoffSchema. */
export function aidlcJsonSchema(): object {
  return {
    $id: "https://github.com/TANISHQBAFNA/resolve/schemas/aidlc-handoff.schema.json",
    title: "Resolve to AIDLC handoff",
    description: "requirementsContext in, designHandoff out. schemaVersion 1. Generated from src/core/query/aidlcContract.ts.",
    ...z.toJSONSchema(AidlcHandoffSchema),
  };
}

const defined = <T extends object>(row: T) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;

/** Handoff (+ its decision record, when one was written) to the AIDLC contract. Validated before it is returned. */
export function aidlcExport(pack: Extract<HandoffPack, { ok: true }>, record?: DecisionRecord): AidlcHandoff {
  const context = pack.screens[0]?.context ?? {};
  const doc: AidlcHandoff = {
    schemaVersion: AIDLC_SCHEMA_VERSION,
    kind: "resolve.aidlc",
    requirementsContext: defined({
      request: record?.request,
      screens: pack.screens.map((screen) => screen.screen.name),
      product: context.product,
      journey: context.journey,
      audience: context.audience,
      a11y: context.a11y ?? context.accessibility,
      answers: record?.answers,
      assumptions: record?.assumptions ?? pack.screens.flatMap((screen) => screen.briefing ?? []),
      openQuestions: record?.openQuestions ?? pack.screens.flatMap((screen) => screen.openQuestions),
    }),
    designHandoff: {
      draft: pack.draft,
      codeMap: pack.codeMap,
      screens: pack.screens.map((screen) => ({
        ...defined({ name: screen.screen.name, fileKey: screen.screen.fileKey, figmaNodeId: screen.screen.figmaNodeId }),
        ...(screen.recipe ? { recipe: { id: screen.recipe.id, title: screen.recipe.title, matchedBy: screen.recipe.matchedBy } } : {}),
        parts: screen.components.map((row) =>
          defined({
            name: row.name,
            variant: row.variant,
            fileKey: row.fileKey,
            figmaNodeId: row.figmaNodeId,
            count: row.count,
            identity: row.identity,
            status: row.status,
            slot: row.slot,
            code: row.code,
            angular: row.angular ? defined({ selector: row.angular.selector, importPath: row.angular.importPath, module: row.angular.module, standalone: row.angular.standalone }) : undefined,
            states: row.states,
          }),
        ),
        verify: { pass: screen.verify.pass, retired: screen.verify.retired, unresolved: screen.verify.unresolved },
        openItems: screen.openQuestions,
      })),
      decisions: { recorded: Boolean(record), picks: record?.picks ?? [], rejected: record?.rejected ?? [] },
    },
  };
  return AidlcHandoffSchema.parse(doc);
}
