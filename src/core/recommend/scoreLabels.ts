/** Top-3 is a rate only when at least this many cards offered 3 or more candidates. */
export const TOP3_REPORT_MIN = 10;

export function top1Label(count: number, base: number): string {
  if (!base) return "n/a";
  return `${count}/${base}`;
}

export function top3Label(count: number, base: number): string {
  if (!base) return "n/a (N=0)";
  if (base < TOP3_REPORT_MIN) return `n/a (N=${base})`;
  return `${count}/${base}`;
}
