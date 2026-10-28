/** Small HTML reader for prototypes: tags, classes, inline styles, <style> blocks, linked CSS. */

export interface HtmlTag {
  tag: string;
  line: number;
  attrs: Record<string, string>;
  classes: string[];
  /** Class names found in quoted strings of :class / x-bind:class expressions. */
  dynamicClasses: string[];
}

export interface HtmlDoc {
  tags: HtmlTag[];
  styles: Array<{ css: string; line: number }>;
  links: string[];
}

const FILE_EXT = /\.(css|scss|js|mjs|ts|json|html?|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|md)$/i;

/** A real class token: no template syntax, no bare numbers, no file names, no half-built prefixes like "filter-". */
export function validClass(token: string): boolean {
  return /^-?[A-Za-z_][\w:/.%#\[\]-]*$/.test(token) && !/[-_:/.]$/.test(token) && !FILE_EXT.test(token);
}

/**
 * Class names a :class / x-bind:class expression always or sometimes applies: plain string literals, object keys, array items.
 * Skipped: strings joined with + or inside ${}, comparisons, function arguments, index access and object values.
 */
export function classLiterals(expr: string): string[] {
  type Tok = { t: "str" | "id" | "p"; v: string; depth: string };
  const toks: Tok[] = [];
  const stack: string[] = [];
  const depth = () => stack[stack.length - 1] ?? "";
  for (let i = 0; i < expr.length; ) {
    const ch = expr[i] as string;
    if (/\s/.test(ch)) i += 1;
    else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== ch) j += expr[j] === "\\" ? 2 : 1;
      const body = expr.slice(i + 1, j);
      toks.push({ t: ch === "`" && body.includes("${") ? "p" : "str", v: ch === "`" && body.includes("${") ? "`" : body, depth: depth() });
      i = j + 1;
    } else if (/[\w$]/.test(ch)) {
      const m = /^[\w$]+/.exec(expr.slice(i)) as RegExpExecArray;
      toks.push({ t: "id", v: m[0], depth: depth() });
      i += m[0].length;
    } else if (/[=!<>&|?+*%-]/.test(ch)) {
      const m = /^[=!<>&|?+*%-]+/.exec(expr.slice(i)) as RegExpExecArray;
      toks.push({ t: "p", v: m[0], depth: depth() });
      i += m[0].length;
    } else {
      const last = toks[toks.length - 1];
      if ("([{".includes(ch)) stack.push(ch === "[" && last && (last.t !== "p" || ")]".includes(last.v)) ? "i" : ch); // "i": obj['key'] index access
      toks.push({ t: "p", v: ch, depth: depth() });
      if (")]}".includes(ch)) stack.pop();
      i += 1;
    }
  }
  const out: string[] = [];
  toks.forEach((tok, i) => {
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const op = (x?: Tok) => x?.t === "p" && /^(\+|[=!<>]+|\*|%)$/.test(x.v);
    if (tok.t === "p" || op(prev) || op(next)) return;
    if (tok.depth === "{") {
      if (next?.v !== ":" || !(prev?.v === "{" || prev?.v === ",")) return; // only object keys
    } else if (tok.depth === "(" || tok.depth === "i" || tok.t === "id") return;
    if (prev?.v === "." || next?.v === "(" || next?.v === ".") return;
    for (const part of tok.v.split(/\s+/)) if (part && validClass(part)) out.push(part);
  });
  return out;
}

const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function blank(text: string, re: RegExp): string {
  return text.replace(re, (match) => match.replace(/[^\n]/g, " "));
}

export function parseHtml(source: string): HtmlDoc {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const noComments = blank(source, /<!--[\s\S]*?-->/g);
  const styles = [...noComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => ({
    css: m[1] as string,
    line: lineAt((m.index ?? 0) + m[0].indexOf(m[1] as string)),
  }));
  const text = blank(blank(noComments, /<style\b[\s\S]*?<\/style>/gi), /<script\b[\s\S]*?<\/script>/gi);

  const tags: HtmlTag[] = [];
  const links: string[] = [];
  for (const match of text.matchAll(TAG)) {
    const attrs: Record<string, string> = {};
    for (const a of (match[2] as string).matchAll(ATTR)) attrs[(a[1] as string).toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const tag = (match[1] as string).toLowerCase();
    if (tag === "link" && /stylesheet/i.test(attrs["rel"] ?? "") && attrs["href"]) links.push(attrs["href"]);
    const dynamic = [attrs[":class"], attrs["x-bind:class"]].flatMap((value) => (value ? classLiterals(value) : []));
    tags.push({
      tag,
      line: lineAt(match.index ?? 0),
      attrs,
      classes: (attrs["class"] ?? "").split(/\s+/).filter(validClass),
      dynamicClasses: dynamic,
    });
  }
  return { tags, styles, links };
}
