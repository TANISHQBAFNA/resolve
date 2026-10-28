/** Small CSS reader: comments, @imports, class names, custom properties. No dependencies. */

export interface CssRule {
  selector: string;
  /** Comment text written directly above the rule. */
  lead?: string;
  decls: Array<{ prop: string; value: string }>;
}

export interface CssFile {
  comments: string[];
  imports: string[];
  rules: CssRule[];
}

const COMMENT = /\/\*[\s\S]*?\*\//g;

export function stripComments(css: string): string {
  return css.replace(COMMENT, (match) => match.replace(/[^\n]/g, " "));
}

const MARK = /\u0001(\d+)\u0001/g;

function cleanComment(raw: string): string {
  return raw
    .slice(2, -2)
    .split("\n")
    .map((line) => line.replace(/^\s*\*+\s?/, "").trim())
    .filter(Boolean)
    .join("\n");
}

export function parseCss(source: string): CssFile {
  const comments = (source.match(COMMENT) ?? []).map(cleanComment);
  let n = 0;
  const css = source.replace(COMMENT, () => `\u0001${n++}\u0001`);
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g)].map((m) => m[1] as string);

  const rules: CssRule[] = [];
  const stack: CssRule[] = [];
  let buf = "";
  let paren = 0;
  let quote = "";
  const flush = () => {
    const top = stack[stack.length - 1];
    const text = buf.replace(MARK, "").trim();
    buf = "";
    if (!top || !text) return;
    const colon = text.indexOf(":");
    if (colon > 0) top.decls.push({ prop: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() });
  };
  for (const ch of css) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") paren += 1;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (paren === 0 && ch === "{") {
      const lead = [...buf.matchAll(MARK)].map((m) => comments[Number(m[1])]).filter(Boolean).pop();
      const rule: CssRule = { selector: buf.replace(MARK, " ").trim().replace(/\s+/g, " "), ...(lead ? { lead } : {}), decls: [] };
      stack.push(rule);
      rules.push(rule);
      buf = "";
      continue;
    } else if (paren === 0 && ch === ";") {
      flush();
      continue;
    } else if (paren === 0 && ch === "}") {
      flush();
      stack.pop();
      continue;
    }
    buf += ch;
  }
  return { comments, imports, rules };
}

/** Class names in a selector, ignoring attribute strings. Handles escapes like .md\:flex. */
export function selectorClasses(selector: string): string[] {
  if (selector.startsWith("@")) return [];
  const clean = selector.replace(/\[[^\]]*\]/g, "").replace(/(["'])(?:\\.|(?!\1).)*\1/g, "");
  return [...clean.matchAll(/\.((?:\\.|[\w-])+)/g)]
    .filter((m) => !/\d/.test(clean[(m.index ?? 0) - 1] ?? "")) // 0.5, 1.5em: decimals, not classes
    .map((m) => (m[1] as string).replace(/\\(.)/g, "$1"))
    .filter((name) => /^-?[A-Za-z_]/.test(name) && !/^(css|js|json|html?|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)$/i.test(name));
}

export function varRefs(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] as string);
}

export function normHex(value: string): string | undefined {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!m) return undefined;
  const hex = (m[1] as string).toLowerCase();
  if (hex.length === 3 || hex.length === 4) return "#" + [...hex].map((c) => c + c).join("");
  return hex.length === 6 || hex.length === 8 ? "#" + hex : undefined;
}

export function colorLiterals(value: string): string[] {
  const outside = value.replace(/var\([^)]*\)/g, " ");
  return [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)].map((m) => m[0]);
}
