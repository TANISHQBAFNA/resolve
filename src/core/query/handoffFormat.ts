import { angularText, type AngularTwin } from "./codeMap";
import { formatPropertyLines } from "./componentProperties";
import { clean, kebab, NAME_GUESS, where, type HandoffPack, type HandoffPart, type HandoffScreen, type InputHint } from "./handoff";


/**
 * Text from Figma or the stores, made inert in markdown: backslash, backticks, `*`, raw HTML (`<` `>`), table pipes, word-edge `_`,
 * and `](` (so `[x](y)` is never a link). Plain `[ACMEUI 30:40]` stays readable.
 */
const md = (s: string) =>
  clean(s)
    .replace(/[\\`*<>|]/g, (c) => `\\${c}`)
    .replace(/_/g, (c, at: number, all: string) => (/[\p{L}\p{N}]/u.test(all[at - 1] ?? "") && /[\p{L}\p{N}]/u.test(all[at + 1] ?? "") ? c : `\\${c}`))
    .replace(/\]\(/g, "]\\(");
/** Link text: also every bracket, so a `]` in a name cannot end the link early. */
const mdLink = (s: string) => md(s).replace(/[[\]]/g, (c) => `\\${c}`);
/** A Figma node id (`12:34`, `I12:34;56:78`), not a pseudo id such as `mcp-name:Button`. */
const figmaId = (id?: string) => (id && /^I?\d+[:-]\d+([;:-]\d+)*$/.test(id) ? id : undefined);
/** `2026-02-03 10:00 UTC`: the decision time with its zone. */
const whenText = (when: string) => {
  const t = Date.parse(when);
  return Number.isNaN(t) ? md(when) : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};
const inputText = (h: InputHint) => (/^(true|false)$/.test(h.value) ? `[${h.input}]="${h.value}"` : `${h.input}="${h.value}"`);
const ng = (a: AngularTwin, full = false) => `\`${angularText(a, full)}\``;
const codeLine = (code: string, angular?: AngularTwin) => (code === "unmapped" ? "unmapped (no code-map entry)" : `\`${code}\`${angular ? `, ${ng(angular)}` : ""}`);

function partLines(parts: HandoffPart[], indent: string): string[] {
  return parts.flatMap((p) => {
    const tag = [
      p.code ? `code: \`${p.code}\`${p.angular ? `, ${ng(p.angular)}` : ""}` : p.status === "current" ? "unmapped" : "",
      p.status === "retired" ? `retired${p.use ? `; use ${md(p.use)}${p.useCode ? ` (\`${p.useCode}\`)` : ""}` : ""}` : "",
      p.identity ? "guess from layer name" : "",
      p.status === "other-library" ? "from a library file that is not learned" : "",
      p.status === "not-found" ? "component not found" : "",
      p.inside ? `${p.inside} parts inside, not shown` : "",
    ].filter(Boolean).join("; ");
    const line = `${indent}- ${md(p.name)}${p.count > 1 ? ` ×${p.count}` : ""}${figmaId(p.figmaNodeId) ? ` [${md(where(p.fileKey, p.figmaNodeId))}]` : ""}${tag ? ` (${tag})` : ""}`;
    return [line, ...partLines(p.parts ?? [], `${indent}  `)];
  });
}

/** The developer's screen sheet (screen-<name>.md). */
export function formatHandoffScreen(s: HandoffScreen, draft: boolean): string {
  const out: string[] = [];
  out.push(`# Handoff: ${md(s.screen.name)}${draft ? " (DRAFT)" : ""}`, "");
  if (s.verify.note?.includes("library node")) out.push(`> ${md(s.verify.note)}`, "");
  if (draft) {
    const weak = [
      s.summary.nameGuesses ? `${s.summary.nameGuesses} name guess${s.summary.nameGuesses === 1 ? "" : "es"} (marked \`name-guess\`; confirm with Figma REST or design_context)` : "",
      s.summary.notFound ? `${s.summary.notFound} component${s.summary.notFound === 1 ? "" : "s"} not in the learned library (marked \`not-found\`; learn the library file that holds ${s.summary.notFound === 1 ? "it" : "them"}, or replace the cop${s.summary.notFound === 1 ? "y" : "ies"})` : "",
    ].filter(Boolean);
    out.push(`> **Draft, not for build.** ${weak.length ? `Below: ${weak.join("; ")}. Fix these, then run handoff without --draft.` : "Nothing below is weak; run handoff without --draft for the copy to build from."}`, "");
  }
  out.push(`- Screen: ${md(s.screen.name)} [${md(where(s.screen.fileKey, s.screen.figmaNodeId))}]${s.screen.link ? ` (${s.screen.link})` : ""}`);
  if (s.matchedFrame) out.push(`- Frame: ${md(s.matchedFrame)}. Pass the exact name or Figma id to be sure.`);
  if (s.context) {
    const c = s.context;
    if (c.id) out.push(`- Context pack: ${md(c.id)}${[c.product, c.journey, c.domain].filter(Boolean).length ? ` (${[c.product, c.journey, c.domain].filter(Boolean).map((x) => md(x!)).join(", ")})` : ""}`);
    else {
      if (c.product) out.push(`- Product: ${md(c.product)}`);
      if (c.journey) out.push(`- Journey: ${md(c.journey)}`);
    }
    if (c.audience) out.push(`- Audience: ${md(c.audience)}`);
    if (c.a11y || c.accessibility) out.push(`- Accessibility (a11y): ${md(c.a11y || c.accessibility || "")}`);
  }
  out.push(`- ${s.summary.components} component${s.summary.components === 1 ? "" : "s"} placed (${s.summary.copies} cop${s.summary.copies === 1 ? "y" : "ies"}), ${s.summary.linkedToCode} linked to code, ${s.summary.unmapped} unmapped. ${s.summary.parts} part${s.summary.parts === 1 ? "" : "s"} inside, ${s.summary.partsLinkedToCode} linked to code.${s.summary.otherLibrary ? ` ${s.summary.otherLibrary} from a library file that is not learned.` : ""}`);
  if (s.note) out.push(`- Note: ${md(s.note)}`);
  out.push("", "## Recipe", "");
  if (s.recipe) {
    out.push(`${md(s.recipe.title)} (\`${s.recipe.id}\`)${s.recipe.matchedBy === "screen name" ? ", matched from the screen name; pass --recipe <id> to pick another" : ""}`, "", "| Slot | Required | Recipe status | Component | On this screen |", "|---|---|---|---|---|");
    for (const sl of s.recipe.slots) {
      out.push(`| ${md(sl.role)} | ${sl.required ? "yes" : "no"} | ${md(sl.status)} | ${sl.component ? `${md(sl.component.name)} [${md(where(sl.component.fileKey, sl.component.figmaNodeId))}]` : "none bound"} | ${sl.state === "placed" ? "placed" : sl.state === "inside" ? `inside ${md(sl.insideOf ?? "a placed component")}` : sl.state === "missing" ? (sl.sharedWith ? `missing (its placed copy fills ${md(sl.sharedWith)})` : "missing") : "-"} |`);
    }
    const cov = s.recipe.coverage;
    out.push("", `${cov.covered}/${cov.slots} slots covered (${cov.placed} placed, ${cov.inside} inside another component).`);
  } else out.push(md(s.recipeNote ?? "No recipe."));
  out.push("", `## Components (${s.components.length})`, "");
  for (const c of s.components) {
    out.push(`### ${md(c.name)}${c.variant ? ` / ${md(c.variant)}` : ""}${c.count > 1 ? ` ×${c.count}` : ""}`, "");
    const placed = c.copies.length ? ` (placed: ${md(c.copies.join(", "))}${c.count > c.copies.length ? `, +${c.count - c.copies.length} more` : ""})` : "";
    const figma =
      c.status === "other-library"
        ? "its component is in a library file that is not learned (no Figma id in the learned files)"
        : figmaId(c.figmaNodeId)
          ? md(where(c.fileKey, c.figmaNodeId))
          : c.status === "not-found"
            ? "component not in the learned library"
            : "no Figma component id (known by its layer name only)";
    out.push(c.status === "other-library" && placed ? `- Figma: placed as ${md(c.copies.join(", "))}${c.count > c.copies.length ? `, +${c.count - c.copies.length} more` : ""}; ${figma}${c.slot ? `; recipe slot: ${md(c.slot)}` : ""}` : `- Figma: ${figma}${placed}${c.slot ? `; recipe slot: ${md(c.slot)}` : ""}`);
    if (c.identity === NAME_GUESS) out.push("- Identity: **name-guess** (from the layer name, not confirmed)");
    if (c.identity === "not-found") out.push("- Identity: **not-found** (the copy's component is in no learned file)");
    out.push(`- Code: ${c.status === "other-library" ? "unknown (its library file is not learned)" : c.code === "unknown" ? "unknown (its component is not in the learned files)" : codeLine(c.code, undefined)}`);
    if (c.angular) out.push(`- Angular: ${ng(c.angular, true)}${c.angular.standalone ? " (add the component to `imports`)" : c.angular.module ? ` (import \`${c.angular.module}\` from '${c.angular.importPath}')` : ""}`);
    if (c.figmaProps) {
      const hints = c.inputs?.length ? ` → inputs (suggested): ${c.inputs.map(inputText).map(md).join(", ")}` : "";
      out.push(`- Figma properties: ${Object.entries(c.figmaProps).map(([k, v]) => `${md(k)}=${md(v)}`).join(", ")}${hints}`);
    }
    if (c.properties?.length) {
      out.push("- Properties:");
      for (const line of formatPropertyLines(c.properties)) out.push(`  ${line}`);
    }
    if (c.template) out.push(`- Template (suggested): \`${c.template.replace(/`/g, "'")}\``);
    if (c.states) out.push(`- Other variants in Figma (states to build): ${Object.entries(c.states).map(([k, vs]) => `${md(k)}: ${vs.map(md).join(", ")}`).join("; ")}`);
    if (c.parts.length) {
      out.push(`- Parts inside${c.partsFrom ? ` (${c.partsFrom})` : ""}:`);
      out.push(...partLines(c.parts, "  "));
      if (c.partsCut) out.push(`  - (cut: ${md(c.partsCut)})`);
    } else out.push("- Parts inside: none (a base part)");
    out.push("");
  }
  const imports = new Map<string, string>();
  for (const c of s.components) {
    if (c.code === "unmapped" || c.code === "unknown") continue;
    const a = c.angular;
    imports.set(c.code, a ? `\`${c.code}\` (${a.standalone ? "standalone" : a.module ? `module \`${a.module}\`` : "Angular"})` : `\`${c.code}\``);
  }
  out.push("## Code to import", "");
  out.push(...(imports.size ? [...imports.values()].map((x) => `- ${x}`) : ["- Nothing mapped yet."]), "");
  out.push(`## Ingredients (${s.ingredients.length} parts)`, "");
  if (s.ingredients.length) {
    out.push("| Part | Figma | Code | Status | Used by |", "|---|---|---|---|---|");
    for (const i of s.ingredients) out.push(`| ${md(i.name)} | ${figmaId(i.figmaNodeId) ? md(where(i.fileKey, i.figmaNodeId)) : "-"} | ${i.code === "unmapped" || i.code === "unknown" ? i.code : `\`${i.code}\`${i.angular ? `, ${ng(i.angular)}` : ""}`} | ${i.status} | ${i.usedBy.map(md).join(", ")} |`);
  } else out.push("No parts inside the placed components.");
  out.push("", "## Verify", "");
  if (s.verify.checked) out.push("Checked as a component list (this screen is one copy).", "");
  if (s.verify.note && !s.verify.note.includes("library node")) out.push(`Note: ${md(s.verify.note)}`, "");
  out.push(`${s.verify.pass ? "PASS" : "FAIL"}: ${s.verify.approved} approved component${s.verify.approved === 1 ? "" : "s"}.${s.verify.retired.length ? ` Retired: ${s.verify.retired.map(md).join(", ")}.` : ""}${s.verify.invents.length ? ` Flagged: ${s.verify.invents.map(md).join(", ")}.` : ""}${s.verify.unresolved.length ? ` Unresolved: ${s.verify.unresolved.map(md).join(", ")}.` : ""}`);
  out.push("", "## Decisions", "");
  if (s.decisions.length) for (const d of s.decisions) out.push(`- ${whenText(d.when)}, ${md(d.who)}: ${md(d.summary)}${d.why !== d.summary ? ` Why: ${md(d.why)}` : ""} (\`${d.proposalId}\`)`);
  else out.push("None approved for this screen yet.");
  out.push("", "## Open questions", "");
  out.push(...(s.openQuestions.length ? s.openQuestions.map((q) => `- ${md(q)}`) : ["None."]));
  return `${out.join("\n")}\n`;
}

/** ingredients.md for a pack: every part once, its code, and which screens and components use it. */
export function formatHandoffIngredients(pack: Extract<HandoffPack, { ok: true }>): string {
  const out = [`# Ingredients${pack.draft ? " (DRAFT)" : ""}`, ""];
  if (!pack.ingredients.length) return `${[...out, "No parts inside the placed components."].join("\n")}\n`;
  out.push("| Part | Figma | Code | Status | Used by | Screens |", "|---|---|---|---|---|---|");
  for (const i of pack.ingredients) {
    out.push(`| ${md(i.name)} | ${figmaId(i.figmaNodeId) ? md(where(i.fileKey, i.figmaNodeId)) : "-"} | ${i.code === "unmapped" || i.code === "unknown" ? i.code : `\`${i.code}\`${i.angular ? `, ${ng(i.angular)}` : ""}`} | ${i.status} | ${i.usedBy.map(md).join(", ")} | ${(i.screens ?? []).map(md).join(", ")} |`);
  }
  return `${out.join("\n")}\n`;
}

/** handoff.md: the index of a pack. */
export function formatHandoffIndex(pack: Extract<HandoffPack, { ok: true }>, files: string[]): string {
  const out = [`# Handoff${pack.draft ? " (DRAFT, not for build)" : ""}`, ""];
  for (const [n, s] of pack.screens.entries()) {
    out.push(`- [${mdLink(s.screen.name)}](${files[n]}): ${s.summary.components} component${s.summary.components === 1 ? "" : "s"}, ${s.summary.linkedToCode} linked to code, verify ${s.verify.pass ? "PASS" : "FAIL"}, ${s.openQuestions.length} open question${s.openQuestions.length === 1 ? "" : "s"}`);
  }
  out.push("- [Ingredients](ingredients.md)", "- [handoff.json](handoff.json)");
  return `${out.join("\n")}\n`;
}

/** Refusal, as text. */
export function formatHandoffRefusal(pack: Extract<HandoffPack, { ok: false }>): string {
  return [`Handoff refused${pack.draft ? " (draft)" : ""}. Nothing written.`, ...pack.refused.map((r) => `- ${r.screen || "(no frame)"}: ${r.message}`), pack.hint].filter(Boolean).join("\n");
}

/** `send-money` for file names. */
export const screenSlug = (name: string) => kebab(name).slice(0, 60) || "screen";
