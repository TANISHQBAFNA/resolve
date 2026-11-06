export const MCP_ENTRY: { command: string; args: string[] };

export function quoteArg(value: string): string;

export function isCheckout(root: string): boolean;

export interface InstallRuntime {
  kind: "checkout" | "release";
  mcp: { command: string; args: string[] };
  cli: string;
  setup: string;
}

export function runtimeFor(root?: string): InstallRuntime;

export function bindCommandText(text: string, runtime: Pick<InstallRuntime, "cli" | "setup">): string;
