export function installMcp(
  current: string | null,
  options?: { claude?: boolean; force?: boolean; root?: string },
): { action: string; text: string; note?: string };
