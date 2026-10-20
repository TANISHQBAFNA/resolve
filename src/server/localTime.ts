/** Local clock time with a short zone label, for status lines such as `2026-01-01 05:30 GMT+5:30`. */
export function formatLearnedAt(iso?: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "unknown";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")
      ?.value ?? "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${zone}`.trim();
}
