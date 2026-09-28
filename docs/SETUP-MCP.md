# Resolve next to Figma MCP — plug and play

**Figma rules. Agents resolve.**

Resolve is for AI tools (Cursor, Claude). Turn on Figma’s connector and Resolve’s connector in the same tool.

Learning a library needs **one** of:

- a **paid Figma seat with MCP access** (Dev or Full), or
- a **Figma access token** (`FIGMA_ACCESS_TOKEN`) for command-line REST ingest.

**View or free seats** get a low Figma read quota. Resolve does not fail the whole library: it saves progress and **resumes** on the next pass. Feed a few frames per session.

## Before you start

1. `node -v` must be **22.12 or newer**. If it is older, install the current LTS from [nodejs.org](https://nodejs.org).
2. `git --version`. On a Mac, that command installs the command line tools if they are missing.
3. In Terminal, run this once and wait until you see `[resolve] MCP server ready`:

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-mcp
```

4. If Claude Desktop cannot start Resolve, use the full path from `which npx` as the `command` (keep the same `args`).

## One config line

After `npm run build:server` (once, if you have the repo) or via `npx`:

### Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "figma": {
      "url": "https://mcp.figma.com/mcp"
    },
    "resolve": {
      "command": "npx",
      "args": ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
    }
  }
}
```

Local checkout instead of npx. No `cwd`. Use the absolute path to the built server:

```json
{
  "mcpServers": {
    "resolve": {
      "command": "node",
      "args": ["/absolute/path/to/resolve/dist-server/mcp.mjs"]
    }
  }
}
```

### Claude Desktop

Add Figma in **Settings → Connectors**. Do not put a Figma `url` entry in the config file. That breaks Claude Desktop.

Resolve only. Config file:

- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Or open **Settings → Developer → Edit Config**.

```json
{
  "mcpServers": {
    "resolve": {
      "command": "npx",
      "args": ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
    }
  }
}
```

Quit Claude Desktop with **Cmd+Q** (not the window close button) and reopen. Check that `resolve` is listed under **Settings → Developer**.

### Claude Code

```bash
claude mcp add resolve -s user -- npx -y -p github:TANISHQBAFNA/resolve resolve-mcp
claude mcp add --transport http figma https://mcp.figma.com/mcp -s user
```

Then in Claude Code run `/mcp` and log in to Figma.

A project `.mcp.json` that lists Figma must set `"type": "http"`:

```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    },
    "resolve": {
      "command": "npx",
      "args": ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
    }
  }
}
```

Same store for CLI and MCP: `~/.resolve/default` (or `RESOLVE_WORKSPACE=acme` → `~/.resolve/acme`). Pin a folder with `GRAPHIFY_HOME`. After a learn, the next MCP call sees it — no restart.

## How the agent learns (two paths)

**Primary — Figma MCP.** `get_metadata` on a library frame, then Resolve `learn_library` with that XML, the **file key**, and `role: "library"`. Optional: pass `search_design_system` / `get_libraries` as `libraries` so cards include the published component key. Without that key the card says **local-only**.

**Different file.** Placing a component into a different Figma file needs the library published, plus `search_design_system` output passed as `libraries`. Otherwise build inside the library file. A product screen (`role: "product"`, or any file that is not the library) does not become the approved master list.

**Secondary — REST token.** `npm run resolve -- ingest '<figma-url>' --role library` with `FIGMA_ACCESS_TOKEN`.

**Big libraries.** Do not dump the whole file. Call `learn_library` on a few frames, stop, come back later. The card says `learned X of Y pages; next: …`. Checkpoints survive across sessions. A view/free seat with a low quota uses the same resume path. When a file is stale, `freshness.delta` lists the exact pages/frames to re-fetch.

Then: `recipe` / `recommend` → place only returned `fileKey` + `nodeId` (and `componentKey` when published) with Figma `use_figma` → `verify_frame`. A pass writes usage into SOCK. Rules never change themselves.

## What Resolve will not do

- Invent a component id
- Dump the graph into chat
- Promote a pattern seen on only one verified screen (needs 3)
- Promote a deprecated or private (`.` / `_`) master
- Change your rules without a SOCI proposal — you approve (`resolve approve --who`). SOCI never auto-applies.

Default tools: `learn_library`, `recipe`, `recommend`, `resolve`, `verify_frame`, `check_cousins`. Set `RESOLVE_MCP_ADVANCED=1` for the rest.
