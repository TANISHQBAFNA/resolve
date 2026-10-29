import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import {
  BriefAnswerIdsSchema,
  DecisionPickSchema,
  DecisionRejectSchema,
  recordFromHandoff,
  type DecisionPick,
  type DecisionRecord,
  type HandoffComponent,
  type HandoffPack,
  type HandoffScreen,
} from "@/public";

/**
 * AIDLC hook: the contract between Resolve and AIDLC stages.
 * requirementsContext goes in to AIDLC; designHandoff comes out of Resolve.
 * This zod schema is the one owner; schema/aidlc-handoff.schema.json is generated from it.
 * Opt-in: only `resolve export aidlc` (or MCP export_aidlc) builds it, from files a handoff already wrote.
 */

export const AIDLC_SCHEMA_VERSION = 1 as const;

/** Allowed values. `satisfies` keeps them in step with the handoff types. */
export const PART_IDENTITIES = ["confirmed", "name-guess", "not-found", "to-add"] as const satisfies readonly HandoffComponent["identity"][];
export const PART_STATUSES = ["current", "retired", "not-found", "other-library"] as const satisfies readonly HandoffComponent["status"][];
export const CODE_STATUSES = ["mapped", "unmapped", "unknown"] as const;
export const RECIPE_MATCHED_BY = ["asked", "screen name"] as const satisfies readonly NonNullable<HandoffScreen["recipe"]>["matchedBy"][];

const Part = z.object({
  name: z.string(),
  variant: z.string().optional(),
  fileKey: z.string().optional(),
  figmaNodeId: z.string().optional(),
  count: z.number().int().min(0),
  identity: z.enum(PART_IDENTITIES),
  status: z.enum(PART_STATUSES),
  slot: z.string().optional(),
  /** mapped: code names a component and import; unmapped: no code link (never guessed); unknown: its library is not learned. */
  codeStatus: z.enum(CODE_STATUSES),
  /** The code-map text: "AcmeButtonComponent from '@acme/ui-angular'", or "unmapped" / "unknown". */
  code: z.string().min(1),
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
    screens: z.array(z.string()).min(1),
    product: z.string().optional(),
    journey: z.string().optional(),
    audience: z.string().optional(),
    a11y: z.string().optional(),
    answers: BriefAnswerIdsSchema.optional(),
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
        recipe: z.object({ id: z.string(), title: z.string(), matchedBy: z.enum(RECIPE_MATCHED_BY) }).optional(),
        parts: z.array(Part),
        verify: z.object({ pass: z.boolean(), retired: z.array(z.string()), unresolved: z.array(z.string()) }),
        openItems: z.array(z.string()),
      }),
    ).min(1),
    decisions: z.object({
      recorded: z.boolean(),
      picks: z.array(DecisionPickSchema),
      rejected: z.array(DecisionRejectSchema),
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

/**
 * A decision record may go into the export only when it is this handoff's record: kind handoff, the same screens,
 * and every pick a part that handoff.json lists on that screen. Anything else is refused, never exported.
 */
export function assertRecordMatchesHandoff(pack: Extract<HandoffPack, { ok: true }>, record: DecisionRecord, handoffAnswers?: DecisionRecord["answers"]): void {
  if (record.kind !== "handoff") throw new Error(`decision.json is a ${record.kind} record, not a handoff record.`);
  const names = pack.screens.map((screen) => screen.screen.name);
  if (JSON.stringify(record.screens ?? []) !== JSON.stringify(names)) {
    throw new Error(`decision.json is for ${(record.screens ?? []).join(", ") || "no screen"}, but handoff.json is for ${names.join(", ")}.`);
  }
  const label = (pick: DecisionPick) => `"${pick.name}"${pick.figmaNodeId ? ` (${pick.figmaNodeId})` : ""}${pick.screen ? ` on ${pick.screen}` : ""}`;
  const key = (pick: DecisionPick) => [pick.screen, pick.fileKey, pick.figmaNodeId, pick.name].join("|");
  const seen = new Set<string>();
  for (const pick of record.picks) {
    if (seen.has(key(pick))) throw new Error(`decision.json picks ${label(pick)} twice.`);
    seen.add(key(pick));
  }
  // The record must be exactly what recordFromHandoff builds from this handoff.json: same picks (ids, match, why) and rejections.
  const expected = recordFromHandoff({ pack, ...(handoffAnswers ? { answers: handoffAnswers } : {}), createdAt: record.createdAt });
  for (const field of ["request", "assumptions", "openQuestions", "asked", "answers"] as const) {
    if (isDeepStrictEqual(record[field], expected[field])) continue;
    if (field === "request") throw new Error("decision.json changes request; handoff records must not set request.");
    throw new Error(`decision.json changes ${field}; handoff.json gives ${JSON.stringify(expected[field] ?? null)}.`);
  }
  for (const pick of record.picks) {
    const twin = expected.picks.find((row) => key(row) === key(pick));
    if (!twin) throw new Error(`decision.json picks ${label(pick)}, which is not a part in handoff.json.`);
    if (!isDeepStrictEqual({ ...twin }, { ...pick })) {
      const field = (["id", "match", "source", "why", "slot"] as const).find((name) => twin[name] !== pick[name]) ?? "a field";
      throw new Error(`decision.json changes ${field} of ${label(pick)}; handoff.json gives ${JSON.stringify(twin[field as keyof DecisionPick] ?? null)}.`);
    }
  }
  if (record.picks.length !== expected.picks.length) {
    throw new Error(`decision.json has ${record.picks.length} picks, but handoff.json has ${expected.picks.length} parts. Run handoff --out again.`);
  }
  if (!isDeepStrictEqual(record.rejected, expected.rejected)) throw new Error("decision.json rejects different parts than handoff.json shows. Run handoff --out again.");
}

/** Handoff (+ its decision record, when one was written) to the AIDLC contract. Validated before it is returned. */
export function aidlcExport(pack: Extract<HandoffPack, { ok: true }>, record?: DecisionRecord, handoffAnswers?: DecisionRecord["answers"]): AidlcHandoff {
  if (record) assertRecordMatchesHandoff(pack, record, handoffAnswers);
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
      answers: record?.answers ?? handoffAnswers,
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
            codeStatus: row.code === "unmapped" || row.code === "unknown" ? row.code : "mapped",
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
