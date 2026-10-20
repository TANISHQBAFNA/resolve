/** One-letter slips that apply to any name word. No word lists. */

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** Keys close on a QWERTY keyboard: up to two apart on one row ("o" for "u"), or touching on the next row. */
function nearKeys(a: string, b: string): boolean {
  const at = (ch: string): [number, number] => {
    const row = ROWS.findIndex((keys) => keys.includes(ch));
    return [row, row < 0 ? -1 : ROWS[row]!.indexOf(ch)];
  };
  const [ra, ca] = at(a);
  const [rb, cb] = at(b);
  if (ra < 0 || rb < 0) return false;
  if (ra === rb) return Math.abs(ca - cb) <= 2;
  if (Math.abs(ra - rb) !== 1) return false;
  // Each lower row sits half a key to the right, so key c sits under keys c and c+1 of the row above.
  const [upper, lower] = ra < rb ? [ca, cb] : [cb, ca];
  return upper === lower || upper === lower + 1;
}

/** Two neighbouring letters swapped: "tabel" for "table". */
export function adjacentSwap(query: string, name: string): boolean {
  if (query.length !== name.length || query.length < 2) return false;
  let i = 0;
  while (i < query.length && query[i] === name[i]) i += 1;
  if (i >= query.length - 1) return false;
  if (query[i] !== name[i + 1] || query[i + 1] !== name[i]) return false;
  return query.slice(i + 2) === name.slice(i + 2);
}

/** One letter missing or extra inside the word, never the first or last: "chekbox", "buttton". "tablet" is not "table". */
export function innerGap(query: string, name: string): boolean {
  const [shorter, longer] = query.length < name.length ? [query, name] : [name, query];
  if (shorter.length + 1 !== longer.length) return false;
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i += 1;
  return i > 0 && i < shorter.length && shorter.slice(i) === longer.slice(i + 1);
}

/**
 * One wrong letter, first letter kept: "botton" for "button", "expantion" for "expansion".
 * 6 or 7 letters: only a nearby key, since a far key is a different word ("swatch", "switch").
 * 8+ letters: any letter, since long words rarely sit one letter apart. Under 6 is too close to real
 * words ("moral", "modal").
 */
export function keySlip(query: string, name: string): boolean {
  if (query.length !== name.length || query.length < 6 || query[0] !== name[0]) return false;
  const diffs = [...query].flatMap((ch, i) => (ch === name[i] ? [] : [i]));
  if (diffs.length !== 1) return false;
  return query.length >= 8 || nearKeys(query[diffs[0]!]!, name[diffs[0]!]!);
}

/** Any one-letter slip on a name word of 5+ letters: a swap, an inner missing or extra letter, or a near key. */
export function wordSlip(query: string, name: string): boolean {
  if (query === name || query.length < 5 || name.length < 5) return false;
  return adjacentSwap(query, name) || innerGap(query, name) || keySlip(query, name);
}

/**
 * A one-letter slip counts only when every other word is known. Two slips, or a slip beside an unknown word,
 * make a typo-heavy ask that stays empty: "lodaing spinnr", "pyament screeen tabel". "primary botton" stays.
 */
export function typoHeavy(
  words: readonly string[],
  exact: (word: string) => boolean,
  slips: (word: string) => boolean,
  known: (word: string) => boolean,
): boolean {
  const slipOnly = (word: string) => !exact(word) && slips(word);
  const count = words.filter(slipOnly).length;
  if (!count) return false;
  return count > 1 || words.some((word) => !slipOnly(word) && !exact(word) && !known(word));
}
