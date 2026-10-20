import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Angular package in, inventory out.
 * Reads Ivy `ɵɵComponentDeclaration` metadata from `.d.ts` with the TypeScript compiler API.
 * A component that is not in the declarations is read from the `@Component` decorator in source.
 */

export interface AngularIo {
  name: string;
  /** Template name when it differs from the class field. */
  alias?: string;
  signal?: true;
}

export interface AngularComponentRecord {
  component: string;
  selector: string;
  standalone?: true;
  /** NgModule that declares it, when it is not standalone. */
  module?: string;
  inputs: AngularIo[];
  outputs: AngularIo[];
  /** Path inside the package. */
  file: string;
  from: "dts" | "source";
  /** Text after `@deprecated`, when the class comment has that tag. */
  deprecated?: string;
}

export interface AngularInventory {
  packageName: string;
  packageVersion: string;
  components: AngularComponentRecord[];
}

const HTML_TAGS = new Set(["a", "button", "div", "h1", "h2", "h3", "img", "input", "label", "li", "p", "span", "ul"]);

/** Scan a package path or a package name Node can resolve from `fromDir`. */
export function scanAngularPackage(packageOrPath: string, fromDir = process.cwd()): AngularInventory {
  const root = resolvePackage(packageOrPath, fromDir);
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`No package.json at ${root}. Pass the Angular package directory.`);
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    throw new Error(`package.json at ${root} is not valid JSON.`);
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error(`package.json at ${root} is not an object.`);
  const record = pkg as Record<string, unknown>;
  const packageName = typeof record["name"] === "string" && record["name"].trim() ? record["name"].trim() : "";
  const packageVersion = typeof record["version"] === "string" && record["version"].trim() ? record["version"].trim() : "";
  if (!packageName) throw new Error(`package.json at ${root} needs a name.`);
  if (!packageVersion) throw new Error(`package.json at ${root} needs a version.`);

  const files = walk(root);
  const byName = new Map<string, AngularComponentRecord>();
  const modules = new Map<string, string>();
  for (const file of files.filter((item) => item.endsWith(".d.ts"))) {
    readFile(root, file, true, byName, modules);
  }
  for (const file of files.filter((item) => item.endsWith(".ts") && !item.endsWith(".d.ts") && !item.endsWith(".spec.ts"))) {
    readFile(root, file, false, byName, modules);
  }
  for (const [component, module] of modules) {
    const row = byName.get(component);
    if (row && !row.standalone && !row.module) row.module = module;
  }
  const components = [...byName.values()].sort((a, b) => a.component.localeCompare(b.component) || a.selector.localeCompare(b.selector));
  return { packageName, packageVersion, components };
}

function resolvePackage(spec: string, fromDir: string): string {
  const direct = resolve(fromDir, spec);
  if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
  if (existsSync(spec) && statSync(spec).isDirectory()) return resolve(spec);
  const req = createRequire(join(fromDir, "package.json"));
  try {
    return dirname(req.resolve(join(spec, "package.json")));
  } catch {
    throw new Error(`No Angular package at ${spec}. Pass a path to the package, or a name Node can resolve.`);
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (name.endsWith(".ts")) out.push(relative(root, path));
    }
  };
  visit(root);
  return out.sort();
}

function readFile(
  root: string,
  file: string,
  dts: boolean,
  byName: Map<string, AngularComponentRecord>,
  modules: Map<string, string>,
): void {
  const text = readFileSync(join(root, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const cmp = dts ? declarationOf(node, "ComponentDeclaration") ?? declarationOf(node, "DirectiveDeclaration") : undefined;
      const mod = dts ? declarationOf(node, "NgModuleDeclaration") : undefined;
      if (cmp) {
        const row = fromDeclaration(className, cmp, file, deprecatedOf(node, source));
        if (row) keep(byName, row);
      }
      if (mod) {
        for (const declared of tupleNames(mod.typeArguments?.[1])) modules.set(declared, className);
      }
      if (!dts && !byName.has(className)) {
        const row = fromDecorator(node, className, file, deprecatedOf(node, source));
        if (row) keep(byName, row);
        const declared = ngModuleDeclarations(node);
        if (declared) for (const name of declared) modules.set(name, className);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function keep(byName: Map<string, AngularComponentRecord>, row: AngularComponentRecord): void {
  if (byName.has(row.component)) return;
  const selector = row.selector.trim();
  for (const have of byName.values()) if (have.selector.trim() === selector) return;
  byName.set(row.component, row);
}

function declarationOf(node: ts.ClassDeclaration, kind: "ComponentDeclaration" | "DirectiveDeclaration" | "NgModuleDeclaration"): ts.TypeReferenceNode | undefined {
  const want = kind === "ComponentDeclaration" ? "ɵcmp" : kind === "DirectiveDeclaration" ? "ɵdir" : "ɵmod";
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name) || member.name.text !== want) continue;
    const type = member.type;
    if (!type || !ts.isTypeReferenceNode(type)) continue;
    const called = typeName(type.typeName);
    if (called === kind || called === `ɵɵ${kind}`) return type;
  }
  return undefined;
}

function typeName(node: ts.EntityName): string {
  if (ts.isIdentifier(node)) return node.text;
  return node.right.text;
}

function fromDeclaration(className: string, type: ts.TypeReferenceNode, file: string, deprecated?: string): AngularComponentRecord | undefined {
  const args = type.typeArguments ?? [];
  const selector = stringFromType(args[1]);
  if (!selector) return undefined;
  const standalone = boolFromType(args[7]);
  const inputs = ioFromType(args[3]);
  const outputs = ioFromType(args[4]);
  return {
    component: className,
    selector,
    ...(standalone ? { standalone: true as const } : {}),
    inputs,
    outputs,
    file,
    from: "dts",
    ...(deprecated ? { deprecated } : {}),
  };
}

function deprecatedOf(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isClassDeclaration(node)) {
    const tag = ts.getJSDocDeprecatedTag(node);
    if (tag) {
      const comment = typeof tag.comment === "string" ? tag.comment : "";
      return comment.trim() || "deprecated";
    }
  }
  const text = source.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, node.getStart(source)) ?? [];
  for (const range of ranges) {
    const comment = text.slice(range.pos, range.end);
    const at = comment.toLowerCase().indexOf("@deprecated");
    if (at < 0) continue;
    const reason = comment
      .slice(at)
      .replace(/^@deprecated\s*/i, "")
      .replace(/\*\/[\s\S]*$/, "")
      .replace(/^\s*\*\s?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();
    return reason || "deprecated";
  }
  return undefined;
}

function literalText(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return undefined;
}

function fromDecorator(node: ts.ClassDeclaration, className: string, file: string, deprecated?: string): AngularComponentRecord | undefined {
  const decorator = decoratorCall(node, "Component") ?? decoratorCall(node, "Directive");
  if (!decorator) return undefined;
  const arg = decorator.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  const selector = literalText(objectProp(arg, "selector"));
  if (!selector) return undefined;
  const standaloneExpr = objectProp(arg, "standalone");
  const standalone = standaloneExpr && standaloneExpr.kind === ts.SyntaxKind.TrueKeyword;
  const inputs: AngularIo[] = [];
  const outputs: AngularIo[] = [];
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
    const field = member.name.text;
    const inputAlias = decoratorAlias(member, "Input");
    const outputAlias = decoratorAlias(member, "Output");
    const init = member.initializer && ts.isCallExpression(member.initializer) ? callName(member.initializer.expression) : undefined;
    if (inputAlias !== undefined || init === "input" || init === "input.required" || init === "model") {
      const signal = init === "input" || init === "input.required" || init === "model";
      const alias = inputAlias || undefined;
      inputs.push({ name: field, ...(alias && alias !== field ? { alias } : {}), ...(signal ? { signal: true as const } : {}) });
    }
    if (outputAlias !== undefined || init === "output" || init === "model") {
      const alias = outputAlias || undefined;
      outputs.push({ name: field, ...(alias && alias !== field ? { alias } : {}) });
    }
  }
  return {
    component: className,
    selector,
    ...(standalone ? { standalone: true as const } : {}),
    inputs,
    outputs,
    file,
    from: "source",
    ...(deprecated ? { deprecated } : {}),
  };
}

function ngModuleDeclarations(node: ts.ClassDeclaration): string[] | undefined {
  const decorator = decoratorCall(node, "NgModule");
  if (!decorator) return undefined;
  const arg = decorator.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  const list = objectProp(arg, "declarations");
  if (!list || !ts.isArrayLiteralExpression(list)) return undefined;
  return list.elements.flatMap((element) => (ts.isIdentifier(element) ? [element.text] : []));
}

function decoratorCall(node: ts.ClassDeclaration | ts.PropertyDeclaration, name: string): ts.CallExpression | undefined {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!decorators) return undefined;
  for (const decorator of decorators) {
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr)) continue;
    if (callName(expr.expression) === name) return expr;
  }
  return undefined;
}

function decoratorAlias(member: ts.PropertyDeclaration, name: string): string | undefined {
  const call = decoratorCall(member, name);
  if (!call) return undefined;
  const arg = call.arguments[0];
  if (!arg) return "";
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isObjectLiteralExpression(arg)) {
    const alias = objectProp(arg, "alias");
    if (alias && ts.isStringLiteral(alias)) return alias.text;
  }
  return "";
}

function callName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = callName(expr.expression);
    return left ? `${left}.${expr.name.text}` : expr.name.text;
  }
  return undefined;
}

function objectProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (propName(prop.name) === name) return prop.initializer;
  }
  return undefined;
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function stringFromType(node: ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text;
  if (ts.isUnionTypeNode(node)) {
    const parts = node.types.flatMap((part) => {
      const text = stringFromType(part);
      return text ? [text] : [];
    });
    return parts.length ? parts.join(", ") : undefined;
  }
  return undefined;
}

function boolFromType(node: ts.TypeNode | undefined): boolean | undefined {
  if (!node || !ts.isLiteralTypeNode(node)) return undefined;
  if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function ioFromType(node: ts.TypeNode | undefined): AngularIo[] {
  if (!node || node.kind === ts.SyntaxKind.NeverKeyword || !ts.isTypeLiteralNode(node)) return [];
  const out: AngularIo[] = [];
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = propName(member.name);
    if (!name || !member.type) continue;
    if (ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) {
      const alias = member.type.literal.text;
      out.push(alias === name ? { name } : { name, alias });
      continue;
    }
    if (ts.isTypeLiteralNode(member.type)) {
      const aliasType = typeMember(member.type, "alias");
      const alias = aliasType ? stringFromType(aliasType) : undefined;
      const signal = boolFromType(typeMember(member.type, "isSignal")) === true;
      out.push({ name, ...(alias && alias !== name ? { alias } : {}), ...(signal ? { signal: true as const } : {}) });
      continue;
    }
    out.push({ name });
  }
  return out;
}

function typeMember(node: ts.TypeLiteralNode, name: string): ts.TypeNode | undefined {
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
    if (propName(member.name) === name) return member.type;
  }
  return undefined;
}

function tupleNames(node: ts.TypeNode | undefined): string[] {
  if (!node || node.kind === ts.SyntaxKind.NeverKeyword || !ts.isTupleTypeNode(node)) return [];
  const names: string[] = [];
  for (const element of node.elements) {
    if (!ts.isTypeQueryNode(element)) continue;
    const expr = element.exprName;
    if (ts.isIdentifier(expr)) names.push(expr.text);
    else if (ts.isQualifiedName(expr)) names.push(expr.right.text);
  }
  return names;
}

/** One ordered word list per comma-separated selector. Order is the order written. */
export function selectorAlternatives(selector: string): string[][] {
  return selector.split(",").map((part) => partWords(part.trim())).filter((words) => words.length > 0);
}

/** Words in a selector, without the HTML tag when an attribute or class is present. Used by tests and suggest. */
export function selectorWords(selector: string): string[] {
  return unique(selectorAlternatives(selector).flat().filter((word) => word !== "acme"));
}

function partWords(text: string): string[] {
  const words: string[] = [];
  {
    let i = 0;
    const readName = () => {
      let name = "";
      while (i < text.length) {
        const ch = text[i]!;
        if (isNameChar(ch)) {
          name += ch;
          i += 1;
        } else break;
      }
      return name;
    };
    const element = readName();
    const hasRest = i < text.length;
    if (element && !(HTML_TAGS.has(element.toLowerCase()) && hasRest)) words.push(...splitWords(element));
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "[") {
        i += 1;
        const start = i;
        while (i < text.length && text[i] !== "]") i += 1;
        const inside = text.slice(start, i);
        const eq = inside.indexOf("=");
        words.push(...splitWords((eq === -1 ? inside : inside.slice(0, eq)).trim()));
        if (text[i] === "]") i += 1;
      } else if (ch === ".") {
        i += 1;
        words.push(...splitWords(readName()));
      } else if (ch === ":") {
        i += 1;
        readName();
        if (text[i] === "(") {
          i += 1;
          let depth = 1;
          while (i < text.length && depth > 0) {
            if (text[i] === "(") depth += 1;
            else if (text[i] === ")") depth -= 1;
            i += 1;
          }
        }
      } else i += 1;
    }
  }
  return words.filter((word) => word && word !== "acme" && word !== "component" && word !== "module");
}

export function splitWords(raw: string): string[] {
  const words: string[] = [];
  let word = "";
  const push = () => {
    if (word) words.push(word.toLowerCase());
    word = "";
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    const letter = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
    if (!letter) {
      push();
      continue;
    }
    const prev = i > 0 ? raw[i - 1]! : "";
    const prevLower = prev >= "a" && prev <= "z";
    const currUpper = ch >= "A" && ch <= "Z";
    if (word && prevLower && currUpper) push();
    word += ch;
  }
  push();
  return words;
}

function isNameChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_";
}

function unique(words: string[]): string[] {
  return [...new Set(words.filter((word) => word && word !== "component" && word !== "module"))];
}
