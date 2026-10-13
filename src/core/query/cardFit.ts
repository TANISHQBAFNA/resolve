/** Shrink a card until it fits its character budget. */
import type { BindRuleWarning } from "./bindRules";
import { EXACT_COMPONENT_HINT } from "./cardCopy";
import { type AgentCost, withCost } from "./cost";
import type { ContentWarning } from "./examples";
import type { RecommendHit } from "./recommendSupport";

const ECHO_KEYS = ["product", "domain", "id", "client", "audience", "a11y", "productFrom", "domainFrom", "clientFrom", "audienceFrom", "a11yFrom"] as const;
/** Drop echo fields before a candidate is removed. Journey is deleted whole, never cut mid-word. */
export function shedEcho(context: Record<string, unknown> | undefined, over: () => boolean): void {
  if (!context) return;
  const drop = ["a11y", "a11yFrom", "audience", "audienceFrom", "files", "client", "clientFrom"];
  for (const key of drop) {
    if (!over()) return;
    if (key in context) delete context[key];
  }
}
/** Shorten echoed context and the matches-clause before any name cut. */
export function fitEcho(
  payload: { candidates?: RecommendHit[]; hint?: string },
  context: Record<string, unknown> | undefined,
  bag: { hint?: string },
  budget: number,
  hard = false,
): void {
  let guard = 0;
  const floor = hard ? 8 : 48;
  const size = () => JSON.stringify(payload).length;
  while (size() > budget && guard < 48) {
    guard += 1;
    const hint = bag.hint ?? payload.hint;
    if (typeof hint === "string" && hint.includes("If stale, learn_library. ")) {
      bag.hint = hint.replace("If stale, learn_library. ", "");
      payload.hint = bag.hint;
      continue;
    }
    if (hard && typeof hint === "string" && hint.includes(" Do not Read graph.json.")) {
      bag.hint = hint.replace(" Do not Read graph.json.", "");
      payload.hint = bag.hint;
      continue;
    }
    if (context) {
      let cut = false;
      for (const key of ECHO_KEYS) {
        const value = context[key];
        if (typeof value !== "string" || value.length <= floor) continue;
        const nextLen = Math.max(floor, value.length - Math.max(8, size() - budget));
        context[key] = `${value.slice(0, nextLen - 1)}…`;
        cut = true;
        break;
      }
      if (cut) continue;
      const files = context["files"];
      if (Array.isArray(files)) {
        const long = files.findIndex((item) => typeof item === "string" && item.length > floor);
        if (long >= 0) {
          const value = files[long] as string;
          const nextLen = Math.max(floor, value.length - Math.max(8, size() - budget));
          files[long] = `${value.slice(0, nextLen - 1)}…`;
          continue;
        }
        if (hard && files.length > 1) {
          context["files"] = files.slice(0, 1);
          continue;
        }
      }
    }
    const lead = payload.candidates?.[0];
    if (lead && "why" in lead && typeof lead.why === "string" && lead.why.includes("matches ")) {
      const next = lead.why.replace(/matches [^;]{8,}/, (part) => {
        const body = part.slice("matches ".length);
        const keep = Math.max(8, body.length - Math.max(8, size() - budget));
        return `matches ${body.slice(0, keep - 1)}…`;
      });
      if (next !== lead.why) {
        lead.why = next;
        continue;
      }
    }
    break;
  }
}
export const WARNING_OVERFLOW = (count: number) => `and ${count} more warnings`;
export const NAME_FLOOR = 16;
/** Real master names stay intact. Only oversized labels shrink, so a cut never invents a name. */
const COMPONENT_NAME_FLOOR = 80;
/** Drop `given` when it repeats `name`. Only called once a card is already over budget. */
function dropEchoedGiven(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) dropEchoedGiven(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["given"] === "string" && record["given"] === record["name"]) {
    delete record["given"];
  }
  for (const child of Object.values(record)) dropEchoedGiven(child);
}
function collectNameSlots(
  value: unknown,
  slots: Array<{ parent: Record<string, unknown>; key: string }>,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNameSlots(item, slots);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "hint" || key === "why" || key === "cost" || key === "ex" || key === "properties" || key === "apply") continue;
    if ((key === "name" || key === "given") && typeof child === "string") slots.push({ parent: record, key });
    else collectNameSlots(child, slots);
  }
}
/** Shorten the longest `name` / `given` fields until `size(payload)` fits. Ids stay intact. */
export function shrinkNameFields(
  payload: object,
  budget: number,
  size: (value: object) => number = (value) => JSON.stringify(value).length,
): void {
  let droppedEcho = false;
  let deepNames = false;
  let guard = 0;
  while (size(payload) > budget && guard < 240) {
    guard += 1;
    if (!droppedEcho) {
      dropEchoedGiven(payload);
      droppedEcho = true;
      continue;
    }
    const slots: Array<{ parent: Record<string, unknown>; key: string }> = [];
    collectNameSlots(payload, slots);
    const floorOf = (key: string) =>
      key === "name" ? (deepNames ? NAME_FLOOR : COMPONENT_NAME_FLOOR) : NAME_FLOOR;
    const long = slots
      .filter((slot) => {
        const text = slot.parent[slot.key];
        return typeof text === "string" && text.length > floorOf(slot.key);
      })
      .sort((a, b) => (b.parent[b.key] as string).length - (a.parent[a.key] as string).length)[0];
    if (long) {
      const text = long.parent[long.key] as string;
      const floor = floorOf(long.key);
      const overflow = size(payload) - budget;
      const target = Math.max(floor, text.length - overflow);
      if (target >= text.length) {
        if (!deepNames) {
          deepNames = true;
          continue;
        }
        break;
      }
      const next = `${text.slice(0, target - 1)}…`;
      if (next.length >= text.length) {
        if (!deepNames) {
          deepNames = true;
          continue;
        }
        break;
      }
      long.parent[long.key] = next;
      continue;
    }
    const hinted = payload as { hint?: string };
    if (typeof hinted.hint === "string") {
      const floor = hinted.hint.includes(EXACT_COMPONENT_HINT)
        ? EXACT_COMPONENT_HINT.length
        : 48;
      if (hinted.hint.length > floor) {
        hinted.hint = `${hinted.hint.slice(0, floor - 1)}…`;
        continue;
      }
    }
    if (!deepNames) {
      deepNames = true;
      continue;
    }
    break;
  }
}
/** Size the verify card after `cost` is attached so the serialized card stays inside the budget. */
export function fitCardAfterCost<T extends object>(
  base: T,
  bindWarnings: BindRuleWarning[] | undefined,
  contentWarnings: ContentWarning[] | undefined,
  budgetChars: number,
): T & {
  cost: AgentCost;
  warnings?: ContentWarning[];
  bindRuleWarnings?: BindRuleWarning[];
  warningNote?: string;
} {
  shrinkNameFields(base, budgetChars, (value) => JSON.stringify(withCost(value)).length);
  const binds = bindWarnings ?? [];
  const content = contentWarnings ?? [];
  const cardFor = (contentCount: number, bindCount: number) => {
    const more = content.length - contentCount + (binds.length - bindCount);
    const fitted: Record<string, unknown> = {};
    if (contentCount > 0) fitted["warnings"] = content.slice(0, contentCount);
    if (bindCount > 0) fitted["bindRuleWarnings"] = binds.slice(0, bindCount);
    if (more > 0) fitted["warningNote"] = WARNING_OVERFLOW(more);
    if (!contentCount && !bindCount && !more) return withCost(base);
    return withCost({ ...base, ...fitted });
  };
  for (let contentCount = content.length; contentCount >= 0; contentCount -= 1) {
    for (let bindCount = binds.length; bindCount >= 0; bindCount -= 1) {
      const card = cardFor(contentCount, bindCount);
      if (JSON.stringify(card).length <= budgetChars) return card;
    }
  }
  return withCost(base);
}
