import type { IncomingMessage, ServerResponse } from "node:http";
import { governanceView } from "./governance";

export function isGovernancePath(url?: string): boolean {
  return (url?.split("?")[0] ?? "") === "/api/governance";
}

export function writeGovernanceResponse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(governanceView()));
}

/** Read-only /api/governance for Vite dev, Vite preview, and any Node host. */
export function governanceMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (!isGovernancePath(req.url)) {
    next();
    return;
  }
  try {
    writeGovernanceResponse(res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
