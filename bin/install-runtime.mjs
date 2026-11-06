/**
 * Which server setup should register.
 * A git checkout (this repository on disk) runs its own built server.
 * A packed install, or a copy under node_modules or npx's cache, keeps the published tag.
 * The cache path is not written down: it can disappear when npx finishes.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Last published tag. Not this checkout, and not a claim that main is a release. */
export const MCP_ENTRY = { command: "npx", args: ["-y", "-p", "github:TANISHQBAFNA/resolve#v0.2.0", "resolve-mcp"] };

const RELEASED_FIGMA = "npx -y -p github:TANISHQBAFNA/resolve#v0.2.0 resolve-figma";
const RELEASED_SETUP = "npx -y -p github:TANISHQBAFNA/resolve#v0.2.0 resolve-setup";

export function quoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function volatileCopy(real) {
  const parts = real.split(sep);
  return parts.includes("node_modules") || parts.includes("_npx");
}

/** True when `root` is a durable checkout, not a package cache. */
export function isCheckout(root) {
  let real;
  try {
    real = realpathSync(root);
  } catch {
    return false;
  }
  if (volatileCopy(real)) return false;
  try {
    const git = statSync(join(real, ".git"));
    return git.isDirectory() || git.isFile();
  } catch {
    return false;
  }
}

function releaseRuntime() {
  return {
    kind: "release",
    mcp: { command: MCP_ENTRY.command, args: [...MCP_ENTRY.args] },
    cli: RELEASED_FIGMA,
    setup: RELEASED_SETUP,
  };
}

/**
 * Checkout: absolute node and the built server. No `cwd` — the host's project folder is the working directory.
 * Release: the published npx spec.
 * @param {string} [root]
 */
export function runtimeFor(root = join(here, "..")) {
  if (!isCheckout(root)) return releaseRuntime();
  const real = realpathSync(root);
  const built = join(real, "dist-server", "mcp.mjs");
  if (!existsSync(built)) {
    throw new Error("Resolve MCP is not built. In this repo: npm run build:server");
  }
  const node = process.execPath;
  const cli = realpathSync(join(real, "bin", "resolve-cli.mjs"));
  const setup = realpathSync(join(real, "bin", "resolve-setup.mjs"));
  return {
    kind: "checkout",
    mcp: { command: node, args: [built] },
    cli: `${quoteArg(node)} ${quoteArg(cli)}`,
    setup: `${quoteArg(node)} ${quoteArg(setup)}`,
  };
}

/** Rewrite the published spec in a command file so it matches `runtime`. */
export function bindCommandText(text, runtime) {
  return text.split(RELEASED_FIGMA).join(runtime.cli).split(RELEASED_SETUP).join(runtime.setup);
}
