/**
 * The shared design-system ID: `ds@<semver>.<tier>.<name>`, for example `ds@1.4.0.core.button`.
 * Figma carries it in the component description (or name). Code carries it in `data-ds-id` or in component.json `dsId`.
 * Two sides with the same ID are the same component. No name is compared.
 */
export interface DsId {
  /** Lowercase, the whole ID. */
  id: string;
  version: string;
  tier: string;
  name: string;
}

const DS_ID = /(?:^|[^\w@])ds@(\d+\.\d+\.\d+)\.([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*[a-z0-9])(?![\w.-]*[a-z0-9])/i;

/** The first shared ID in the text, or undefined. */
export function parseDsId(text: string | undefined): DsId | undefined {
  const hit = text ? DS_ID.exec(text) : null;
  if (!hit) return undefined;
  const [version, tier, name] = [hit[1] as string, (hit[2] as string).toLowerCase(), (hit[3] as string).toLowerCase()];
  return { id: `ds@${version}.${tier}.${name}`, version, tier, name };
}

/** The first text that carries a shared ID wins (description before name). */
export function dsIdOf(...texts: Array<string | undefined>): DsId | undefined {
  for (const text of texts) {
    const found = parseDsId(text);
    if (found) return found;
  }
  return undefined;
}

/** Same tier and name, different version: not a match, but worth a warning. */
export function sameButVersion(a: DsId, b: DsId): boolean {
  return a.tier === b.tier && a.name === b.name && a.version !== b.version;
}
