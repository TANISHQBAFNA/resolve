const warned = new Set<string>();

/** Tools and commands that stay callable, with a warning, until the next quarter. */
export const DEPRECATED_INSTEAD: Record<string, string> = {
  orient: "recommend or recipe",
  query: "recommend or resolve",
  path: "recommend",
  explain: "the why line on a recommend or resolve card",
  check: "verify",
  check_frame: "verify_frame",
  get_related: "recommend",
  get_subgraph: "recommend",
  get_health: "learn_library",
  find_nodes: "recommend or resolve",
  get_node: "resolve",
  get_screen_inventory: "resolve",
  get_component_usage: "resolve",
  get_recipe: "recipe",
  "context packs": "recipe fields (product, journey, domain)",
  "npm run keyline": "npm run resolve",
  communities: "recommend",
};

export function deprecationNotice(name: string, instead: string): string {
  return `Deprecated: ${name}. This will be removed after a quarter. Use ${instead}.`;
}

export function warnDeprecated(name: string, instead?: string): void {
  const use = instead ?? DEPRECATED_INSTEAD[name];
  if (!use || warned.has(name)) return;
  warned.add(name);
  process.stderr.write(`${deprecationNotice(name, use)}\n`);
}

export function withDeprecation<T>(name: string, result: T): T {
  const instead = DEPRECATED_INSTEAD[name];
  if (!instead) return result;
  warnDeprecated(name, instead);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { deprecation: deprecationNotice(name, instead), ...result };
  }
  return result;
}
