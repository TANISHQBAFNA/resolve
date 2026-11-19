import type { CatalogEntry, CatalogProperty, CatalogSpec } from "./scan.ts";
import { tokens } from "./words.ts";

/**
 * Jobs and stand-ins read from a component file: properties, parts, a11y
 * roles, built-from links, and do/don't lines. A name is not a job.
 * An edge extracted from those lines counts. An AI suggestion would not,
 * and this file does not invent one.
 */

export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  source: "code" | "screen" | "ai";
  file?: string;
  field?: string;
}

export interface CatalogEdge {
  kind: "built-from" | "stands-in-for" | "instead-of";
  from: string;
  to: string;
  job?: string;
  provenance: Provenance;
  evidence: string;
  confidence: number;
  review: "extracted" | "proposed";
}

export interface GraphPick {
  name: string;
  settings: Record<string, string>;
  /** States the component can show. The ask does not have to name each one. */
  states: string[];
  reasons: { job?: string; constraint?: string; context?: string };
  confidence: Confidence;
  edges: CatalogEdge[];
  score: number;
}

interface NodeFacts {
  entry: CatalogEntry;
  spec: CatalogSpec;
  jobs: { id: string; evidence: string; confidence: number }[];
  field: boolean;
  display: boolean;
  notEmpty: boolean;
  notForStatus: boolean;
}

const COUNTS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
const STATE_NAMES = ["error", "empty", "loading", "disabled", "view", "readonly", "base"];

function lines(spec: CatalogSpec): string {
  return [spec.summary, ...spec.a11y, ...spec.do, ...spec.dont].join("\n");
}

function prop(spec: CatalogSpec, name: string): CatalogProperty | undefined {
  const key = name.toLowerCase();
  return spec.properties.find((item) => item.name.toLowerCase() === key);
}

function option(spec: CatalogSpec, property: string, value: string): boolean {
  const found = prop(spec, property);
  return Boolean(found?.options?.some((item) => item.value.toLowerCase() === value.toLowerCase()));
}

function cite(spec: CatalogSpec, field: string): Provenance {
  return { source: "code", file: spec.file, field };
}

function jobsOf(spec: CatalogSpec): NodeFacts["jobs"] {
  const jobs: NodeFacts["jobs"] = [];
  const add = (id: string, evidence: string, confidence = 1) => {
    if (!evidence.trim() || jobs.some((job) => job.id === id)) return;
    jobs.push({ id, evidence: evidence.trim(), confidence });
  };
  const a11y = spec.a11y.join(" ");
  if (/radiogroup/i.test(a11y)) add("choose-one", a11y);
  if (/tablist|role=["']tab["']/i.test(a11y)) add("switch-view", a11y);
  if (/role=["']switch["']/i.test(a11y)) add("on-off", a11y);
  if (/\bdialog\b|alertdialog/i.test(a11y)) add("confirm", a11y);
  if (/listbox|combobox/i.test(a11y)) add("pick-list", a11y);
  if (/navigation/i.test(a11y)) add("navigate", a11y);
  for (const rule of spec.do) {
    if (/side navigation/i.test(rule)) add("navigate", rule);
    if (/app bar/i.test(rule)) add("app-bar", rule);
    if (/system reports|system status/i.test(rule)) add("report-status", rule);
    if (/inside tables/i.test(rule)) add("report-status", rule, 0.9);
    if (/splits by status|filter tabs/i.test(rule)) add("filter-split", rule);
    if (/applies immediately/i.test(rule)) add("on-off", rule);
    if (/one choice|mutually exclusive|two to five/i.test(rule)) add("choose-one", rule, 0.9);
    if (/switch between views/i.test(rule)) add("switch-view", rule, 0.9);
    if (/key figures/i.test(rule)) add("summary", rule);
    if (/layout does not jump/i.test(rule)) add("loading", rule);
    if (/column header|one header/i.test(rule)) add("column", rule, 0.8);
    if (/one type per column|returns a td/i.test(rule)) add("cell", rule);
    if (/plain single-line|typed data/i.test(rule)) add("field", rule, 0.8);
    if (/short question/i.test(rule)) add("confirm", rule, 0.9);
    if (/toggle, filter by or remove|can toggle, filter by or remove/i.test(rule)) add("removable", rule);
  }
  const passwordOption = prop(spec, "dataType")?.options?.find((item) => item.value.toLowerCase() === "password");
  if (passwordOption) add("secret", passwordOption.use || "password");
  else if (/\bpassword\b/i.test(prop(spec, "type")?.use ?? "")) add("secret", prop(spec, "type")?.use || "password", 0.6);
  if (option(spec, "dataType", "radio button")) add("choose-one", prop(spec, "dataType")?.options?.find((item) => item.value.toLowerCase() === "radio button")?.use || "radio button", 0.9);
  if (option(spec, "dataType", "amount")) add("amount", prop(spec, "dataType")?.options?.find((item) => item.value.toLowerCase() === "amount")?.use || "amount");
  if (spec.properties.some((item) => item.name === "type" && item.options?.some((optionRow) => /primary|secondary|negative/i.test(optionRow.value)))) add("action", "A button type.");
  if (/checkbox/i.test(a11y) || /\bcheckbox\b/i.test(spec.summary)) add("check", a11y || spec.summary);
  if (option(spec, "state", "empty") || spec.parts.some((part) => part.name === "empty")) add("empty", spec.do.find((rule) => /state empty/i.test(rule)) || "state empty");
  if (option(spec, "dataType", "dropdown") || option(spec, "filterType", "filter tabs")) add("pick-list", "a list property");
  if (spec.parts.some((part) => part.name === "search") || prop(spec, "searchPlaceholder")) add("search", prop(spec, "searchPlaceholder")?.use || "search");
  if (/\btype search\b|search icon/i.test(lines(spec))) add("search", "search");
  if (spec.parts.some((part) => /flyout|submenu/i.test(part.name))) add("navigate", spec.parts.find((part) => /flyout/i.test(part.name))?.note || "flyout");
  if (/<th\b|column header/i.test(lines(spec))) add("column", "column header");
  return jobs;
}

function factsOf(entry: CatalogEntry): NodeFacts | undefined {
  if (!entry.spec) return undefined;
  const spec = entry.spec;
  return {
    entry,
    spec,
    jobs: jobsOf(spec),
    field: spec.properties.some((item) => /fieldlabel|showlabel/i.test(item.name)),
    display: !spec.properties.some((item) => /fieldlabel/i.test(item.name)) && /money value|display/i.test(spec.summary),
    notEmpty: spec.dont.some((rule) => /empty state/i.test(rule) && /do not|never/i.test(rule)),
    notForStatus: spec.dont.some((rule) => /system status/i.test(rule)),
  };
}

const USE = /use (?:a |an |the )?(?:recipes\/)?([a-z][a-z0-9-]{1,40})/gi;

function targetName(raw: string, names: Set<string>): string | undefined {
  const id = raw.toLowerCase();
  if (names.has(id)) return id;
  if (id === "radio") return [...names].find((name) => name.includes("radio"));
  if (id === "badge") return names.has("badge") ? "badge" : undefined;
  if (id === "tabs") return names.has("tabs") ? "tabs" : undefined;
  return [...names].find((name) => name === id || name.endsWith(`-${id}`));
}

function edgesOf(nodes: NodeFacts[]): CatalogEdge[] {
  const names = new Set(nodes.map((node) => node.entry.name));
  const edges: CatalogEdge[] = [];
  for (const node of nodes) {
    const spec = node.spec;
    for (const used of spec.uses) {
      const to = targetName(used, names);
      if (!to || to === node.entry.name) continue;
      edges.push({
        kind: "built-from",
        from: node.entry.name,
        to,
        provenance: cite(spec, "uses"),
        evidence: used,
        confidence: 1,
        review: "extracted",
      });
    }
    for (const rule of [...spec.dont, ...spec.do].flatMap((line) => line.split(/(?<=\.)\s+/))) {
      USE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = USE.exec(rule))) {
        const to = targetName(match[1] ?? "", names);
        if (!to || to === node.entry.name) continue;
        const job = /status/i.test(rule) ? "report-status" : /password|amount|dropdown|typed data/i.test(rule) ? "field" : /fewer than four|\bradio\b/i.test(rule) ? "choose-one" : /empty/i.test(rule) ? "empty" : /plain (?:single-line|free) text/i.test(rule) ? "plain" : undefined;
        edges.push({
          kind: "instead-of",
          from: node.entry.name,
          to,
          ...(job ? { job } : {}),
          provenance: cite(spec, spec.dont.some((line) => line.includes(rule)) ? "rules.dont" : "rules.do"),
          evidence: rule,
          confidence: 0.9,
          review: "extracted",
        });
      }
    }
    const segmented = spec.properties.flatMap((item) => item.options ?? []).find((item) => /as tabs/i.test(item.use ?? ""));
    if (segmented && names.has("tabs")) {
      edges.push({
        kind: "stands-in-for",
        from: node.entry.name,
        to: "tabs",
        job: "choose-one",
        provenance: cite(spec, "properties"),
        evidence: segmented.use || segmented.value,
        confidence: 0.9,
        review: "extracted",
      });
    }
  }
  return edges;
}

interface Reading {
  jobs: Set<string>;
  context: "form" | "review" | "row" | "filter" | "nav" | "any";
  count?: number;
  wantsEmpty: boolean;
  wantsField: boolean;
  wantsInner: boolean;
  dataType?: string;
  words: string[];
}

function readAsk(ask: string): Reading {
  const q = ask.toLowerCase();
  const jobs = new Set<string>();
  let context: Reading["context"] = "any";
  const countWord = q.match(/\b(?:one of |list of |of )(two|three|four|five|\d+)\b/);
  const count = countWord ? COUNTS[countWord[1] ?? ""] ?? Number(countWord[1]) : undefined;
  if (/\b(segmented|one choice|pick one|choose one|both visible)\b/.test(q)) jobs.add("choose-one");
  if (/\bpassword\b/.test(q)) jobs.add("secret");
  if (/\bamount\b|\bmoney\b/.test(q)) jobs.add("amount");
  if (/\bempty\b/.test(q)) jobs.add("empty");
  if (/\b(loading|fetching)\b/.test(q)) jobs.add("loading");
  if (/\berror\b/.test(q)) jobs.add("field");
  if (/\bremov\w*|\bdismiss\w*/.test(q)) jobs.add("removable");
  if (/\b(status|chip)\b/.test(q) && !jobs.has("removable")) jobs.add("report-status");
  if (/\b(navigation|submenu|destinations)\b/.test(q)) jobs.add("navigate");
  if (/\b(dialog|confirmation)\b/.test(q)) jobs.add("confirm");
  if (/\b(switch|immediately)\b/.test(q)) jobs.add("on-off");
  if (/\b(search box|placeholder)\b/.test(q)) jobs.add("search");
  if (/\bcolumn headers?\b/.test(q)) jobs.add("column");
  if (/\b(body cells|table cells?)\b/.test(q)) jobs.add("cell");
  if (/\b(top bar|application bar|app bar)\b/.test(q)) jobs.add("app-bar");
  if (/\bbutton\b/.test(q)) jobs.add("action");
  if (/\b(review|read-only|headline)\b/.test(q)) context = "review";
  else if (/\b(table row|each row|in a row)\b/.test(q)) context = "row";
  else if (/\b(above the table|splits)\b/.test(q)) context = "filter";
  else if (/\b(navigation|submenu)\b/.test(q)) context = "nav";
  else if (/\b(on the form|editable|required field|labelled field)\b/.test(q)) context = "form";
  if (/\b(field|labelled)\b/.test(q)) jobs.add("field");
  if (/\bcheckbox\b/.test(q)) jobs.add("check");
  const dataType = /\bpassword\b/.test(q) ? "password" : /\bamount\b/.test(q) ? "amount" : /\bemail\b/.test(q) ? "email" : undefined;
  return {
    jobs,
    context,
    ...(count ? { count } : {}),
    wantsEmpty: jobs.has("empty") && !jobs.has("loading"),
    wantsField: context === "form" || /\b(field|labelled|on the form)\b/.test(q),
    wantsInner: /\b(open list|under that|search box|no visible label)\b/.test(q),
    ...(dataType ? { dataType } : {}),
    words: tokens(q),
  };
}

function settingsFor(node: NodeFacts, ask: string, reading: Reading): Record<string, string> {
  const settings: Record<string, string> = {};
  const q = ask.toLowerCase();
  const set = (name: string, value: string) => {
    settings[name] = value;
  };
  if (reading.dataType === "password" && option(node.spec, "dataType", "password")) set("dataType", "password");
  if (reading.dataType === "amount" && option(node.spec, "dataType", "amount")) set("dataType", "amount");
  if (reading.dataType === "email" && /\bemail\b/i.test(prop(node.spec, "type")?.use ?? "")) set("type", "email");
  if (reading.jobs.has("choose-one") && prop(node.spec, "dataType")) {
    const many = (reading.count ?? 0) >= 6 || /\blong list\b/.test(q);
    const few = reading.count !== undefined && reading.count < 4;
    if (few && option(node.spec, "dataType", "radio button")) set("dataType", "radio button");
    else if (many && option(node.spec, "dataType", "dropdown")) set("dataType", "dropdown");
    else if (option(node.spec, "dataType", "radio button") && /\b(segmented|both visible|one choice)\b/.test(q)) set("dataType", "radio button");
  }
  if (reading.context === "review" && option(node.spec, "state", "view")) set("state", "view");
  if (reading.context === "form" && option(node.spec, "state", "base") && !settings["state"]) set("state", "base");
  if (/\berror\b/.test(q) && option(node.spec, "state", "error")) set("state", "error");
  if (/\berror\b/.test(q) && option(node.spec, "helpType", "error")) set("helpType", "error");
  if (reading.wantsEmpty && option(node.spec, "state", "empty")) set("state", "empty");
  if (reading.jobs.has("loading") && option(node.spec, "state", "loading")) set("state", "loading");
  if (reading.context === "row") {
    const text = prop(node.spec, "style")?.options?.find((item) => item.value === "text" && /table/i.test(item.use ?? ""));
    if (text) set("style", "text");
  }
  if (reading.context === "filter") {
    const tabs = prop(node.spec, "filterType")?.options?.find((item) => /split/i.test(item.use ?? ""));
    if (tabs) set("filterType", tabs.value);
  }
  if (reading.context === "review" && reading.jobs.has("amount")) {
    const size = prop(node.spec, "amountSize")?.options?.find((item) => /headline/i.test(item.use ?? "") && /review/i.test(item.use ?? ""));
    if (size) set("amountSize", size.value);
  }
  if (/\brequired\b/.test(q) && prop(node.spec, "showMandatory")) set("showMandatory", "true");
  if (/\bdestructive\b/.test(q)) {
    const negative = prop(node.spec, "type")?.options?.find((item) => item.value === "negative" || /destructive/i.test(item.use ?? ""));
    if (negative) set("type", negative.value);
  } else if (/\bsecondary\b/.test(q) && option(node.spec, "type", "secondary")) set("type", "secondary");
  else if (/\b(main|primary)\b/.test(q) && option(node.spec, "type", "primary")) set("type", "primary");
  if (/\b(centred|centered|short)\b/.test(q) && option(node.spec, "placement", "center")) set("placement", "center");
  if (/\b(short|small)\b/.test(q) && option(node.spec, "size", "small")) set("size", "small");
  if (reading.context === "nav" && option(node.spec, "state", "Unpinned") || (reading.context === "nav" && prop(node.spec, "state")?.options?.some((item) => /unpinned/i.test(item.value) && /flyout/i.test(item.use ?? "")))) {
    const unpinned = prop(node.spec, "state")?.options?.find((item) => /unpinned/i.test(item.value));
    if (unpinned && /submenu|flyout|beside/i.test(q)) set("state", unpinned.value);
  }
  if (/\bno visible label\b/.test(q) && prop(node.spec, "showLabel")) set("showLabel", "false");
  return settings;
}

function statesOf(spec: CatalogSpec): string[] {
  const state = prop(spec, "state");
  const values = new Set<string>();
  for (const item of state?.options ?? []) {
    const value = item.value.toLowerCase();
    if (STATE_NAMES.some((name) => value.includes(name))) values.add(item.value);
  }
  if (/\berror\b/i.test(lines(spec)) && !values.has("error")) values.add("error");
  return [...values];
}

interface Scored {
  node: NodeFacts;
  score: number;
  reasons: { job?: string; constraint?: string; context?: string };
  edges: CatalogEdge[];
}

function rankNodes(nodes: NodeFacts[], edges: CatalogEdge[], ask: string): Scored[] {
  const reading = readAsk(ask);
  const scored: Scored[] = [];
  for (const node of nodes) {
    const reasons: Scored["reasons"] = {};
    const used: CatalogEdge[] = [];
    let score = 0;
    const job = node.jobs.find((item) => reading.jobs.has(item.id));
    if (job) {
      score += 100 * job.confidence;
      reasons.job = job.evidence;
    }
    if (reading.wantsEmpty && node.notEmpty) {
      score -= 120;
      reasons.constraint = node.spec.dont.find((rule) => /empty/i.test(rule));
    }
    if (reading.jobs.has("report-status") && node.notForStatus) {
      score -= 90;
      reasons.constraint = node.spec.dont.find((rule) => /status/i.test(rule));
    }
    const applies = (edge: CatalogEdge) =>
      Boolean(edge.job) &&
      (reading.jobs.has(edge.job!) ||
        (edge.job === "field" && (reading.dataType === "password" || reading.dataType === "amount" || reading.jobs.has("secret"))) ||
        (edge.job === "plain" && reading.jobs.has("field") && !reading.dataType && !reading.jobs.has("amount") && !reading.jobs.has("secret")) ||
        (edge.job === "choose-one" && reading.jobs.has("choose-one") && (reading.count === undefined || reading.count < 4) && !/\blong list\b/.test(ask.toLowerCase())));
    let penalized = false;
    let boosted = false;
    for (const edge of edges) {
      if (edge.review !== "extracted" || edge.kind !== "instead-of" || !applies(edge)) continue;
      if (edge.from === node.entry.name && !penalized) {
        score -= 70;
        reasons.constraint = edge.evidence;
        used.push(edge);
        penalized = true;
      } else if (edge.to === node.entry.name && !boosted) {
        score += 55;
        reasons.constraint = edge.evidence;
        used.push(edge);
        boosted = true;
      }
    }
    if (reading.count !== undefined && reading.count < 4 && node.spec.dont.some((rule) => /fewer than four/i.test(rule))) {
      score -= 80;
      reasons.constraint = node.spec.dont.find((rule) => /fewer than four/i.test(rule));
    }
    if (reading.context === "form" && node.field) {
      score += 40;
      reasons.context = "This is a labelled field.";
    }
    if (reading.context === "form" && node.display) {
      score -= 50;
      reasons.context = "This only displays a value.";
    }
    if (reading.context === "review" && node.field && node.jobs.some((item) => item.id === "amount" || reading.jobs.has("amount") && option(node.spec, "dataType", "amount"))) {
      score += 45;
      reasons.context = node.spec.do.find((rule) => /review/i.test(rule)) || "Review uses the field's view state.";
    }
    if (reading.context === "review" && node.display && reading.jobs.has("amount")) {
      score -= 30;
      reasons.context = "A review amount stays a field in view, not the display alone.";
    }
    if (reading.context === "row" && node.jobs.some((item) => item.id === "report-status") && !node.notForStatus) {
      score += 40;
      reasons.context = node.spec.do.find((rule) => /tables/i.test(rule)) || "A row reports status.";
    }
    if (reading.context === "filter" && node.jobs.some((item) => item.id === "filter-split")) {
      score += 50;
      reasons.context = node.spec.do.find((rule) => /split/i.test(rule)) || node.spec.a11y.find((rule) => /not a tablist/i.test(rule));
    }
    if (reading.context === "filter" && node.jobs.some((item) => item.id === "switch-view") && !node.jobs.some((item) => item.id === "filter-split")) {
      score -= 40;
      reasons.context = "Tabs switch panels. A list split does not.";
    }
    if (reading.context === "nav" && node.jobs.some((item) => item.id === "navigate")) {
      const submenu = node.spec.parts.some((part) => /flyout|submenu/i.test(part.name)) || node.spec.do.some((rule) => /side navigation/i.test(rule));
      score += submenu ? 70 : 15;
      reasons.context = submenu ? "Many destinations, with a submenu." : "A navigation control, not the menu.";
    }
    if (reading.wantsInner && node.field && !reading.jobs.has("search")) score -= 25;
    if (reading.jobs.has("choose-one") && node.jobs.some((item) => item.id === "switch-view") && !node.jobs.some((item) => item.id === "choose-one")) {
      score -= 50;
      reasons.context = reasons.context || "This switches views. The ask is one choice.";
    }
    if (reading.jobs.has("choose-one") && !reading.wantsInner) {
      const wrapsChoice = edges.some((edge) => edge.kind === "built-from" && edge.from === node.entry.name && nodes.some((other) => other.entry.name === edge.to && other.jobs.some((item) => item.id === "choose-one")));
      if (wrapsChoice) {
        score += 50;
        reasons.context = reasons.context || "The field wraps that choice.";
      }
      const wrapped = edges.some((edge) => edge.kind === "built-from" && edge.to === node.entry.name);
      if (wrapped && !node.field) score -= 40;
    }
    if (reading.jobs.has("on-off") && !node.jobs.some((item) => item.id === "on-off") && node.jobs.some((item) => item.id === "action")) score -= 50;
    if (/\bsegmented\b/.test(ask.toLowerCase())) {
      const stand = edges.find((edge) => edge.kind === "stands-in-for" && edge.from === node.entry.name && edge.review === "extracted");
      if (stand) {
        score += 45;
        reasons.job = stand.evidence;
        used.push(stand);
      }
    }
    if (reading.jobs.has("cell") && node.jobs.some((item) => item.id === "cell")) score += 40;
    if (reading.jobs.has("cell") && !node.jobs.some((item) => item.id === "cell") && (node.jobs.some((item) => item.id === "amount") || node.jobs.some((item) => item.id === "field"))) {
      score -= 40;
      reasons.context = "The amount here is a cell, not a field.";
    }
    if (reading.jobs.has("search") && reading.wantsInner) {
      const inside = edges.some((edge) => edge.kind === "built-from" && edge.to === node.entry.name && nodes.some((other) => other.entry.name === edge.from && other.jobs.some((item) => item.id === "search")));
      if (inside && node.field) {
        score += 40;
        reasons.context = "The search box inside the bar.";
      }
      if (node.jobs.some((item) => item.id === "search") && node.spec.uses.length > 1) score -= 40;
      if (node.jobs.some((item) => item.id === "pick-list") && /\bfilter bar\b/.test(ask.toLowerCase())) score -= 50;
    }
    if (reading.jobs.has("secret") && option(node.spec, "dataType", "password")) {
      score += 30;
      reasons.job = reasons.job || "Password is one of its data types.";
    }
    if (reading.wantsEmpty && !reading.wantsInner && (node.jobs.some((item) => item.id === "pick-list") || node.jobs.some((item) => item.id === "empty"))) {
      score -= 100;
      reasons.context = "An empty menu is not an empty list.";
    }
    if (reading.jobs.has("loading") && node.jobs.some((item) => item.id === "loading")) score += 40;
    if (reading.jobs.has("loading") && !node.jobs.some((item) => item.id === "loading") && node.jobs.some((item) => item.id === "pick-list" || item.id === "search")) score -= 40;
    const plainType = prop(node.spec, "type")?.use ?? "";
    if (reading.dataType && reading.dataType !== "password" && reading.dataType !== "amount" && plainType.toLowerCase().includes(reading.dataType) && !option(node.spec, "dataType", reading.dataType)) {
      score += node.field && prop(node.spec, "type") ? 45 : -25;
    }
    if (/\blong list\b/.test(ask.toLowerCase()) && node.spec.dont.some((rule) => /more than five/i.test(rule))) {
      score -= 80;
      reasons.constraint = node.spec.dont.find((rule) => /more than five/i.test(rule));
    }
    if (/\blong list\b/.test(ask.toLowerCase()) && option(node.spec, "dataType", "dropdown")) score += 35;
    if (score > 0) scored.push({ node, score, reasons, edges: used });
  }
  scored.sort((a, b) => b.score - a.score || (a.node.entry.name < b.node.entry.name ? -1 : 1));
  return scored;
}

function confidenceOf(row: Scored, next: Scored | undefined): Confidence {
  const dims = [row.reasons.job, row.reasons.constraint, row.reasons.context].filter(Boolean).length;
  if (dims >= 2 && row.score - (next?.score ?? 0) >= 20) return "high";
  if (dims >= 1 && row.score >= 40) return "medium";
  return "low";
}

/** Rank a coded catalog. At most three. Lexical overlap is not a job. */
export function pickByCatalog(entries: CatalogEntry[], ask: string): GraphPick[] {
  const nodes = entries.flatMap((entry) => {
    const facts = factsOf(entry);
    return facts ? [facts] : [];
  });
  if (!nodes.length) return [];
  const edges = edgesOf(nodes);
  return rankNodes(nodes, edges, ask).slice(0, 3).map((row, index, all) => ({
    name: row.node.entry.name,
    settings: settingsFor(row.node, ask, readAsk(ask)),
    states: statesOf(row.node.spec).slice(0, 8),
    reasons: row.reasons,
    confidence: confidenceOf(row, all[index + 1]),
    edges: row.edges,
    score: Math.round(row.score),
  }));
}
