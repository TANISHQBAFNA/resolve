# Resolve next to Figma MCP — plug and play

**Figma rules. Agents resolve.**

Resolve is for AI tools (Cursor, Claude). Turn on Figma’s connector and Resolve’s connector in the same tool.

Learning a library needs **one** of:

- a **paid Figma seat with MCP access** (Dev or Full), or
- a **Figma access token** (`FIGMA_ACCESS_TOKEN`) for command-line REST ingest.

**View or free seats** get a low Figma read quota. Resolve does not fail the whole library: it saves progress and **resumes** on the next pass. Feed a few frames per session.

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
      "args": ["-y", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
    }
  }
}
```

Local checkout instead of npx:

```json
{
  "mcpServers": {
    "resolve": {
      "command": "node",
      "args": ["dist-server/mcp.mjs"],
      "cwd": "/absolute/path/to/resolve"
    }
  }
}
```

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "figma": {
      "url": "https://mcp.figma.com/mcp"
    },
    "resolve": {
      "command": "npx",
      "args": ["-y", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
    }
  }
}
```

Same store for CLI and MCP: `~/.resolve/default` (or `RESOLVE_WORKSPACE=acme` → `~/.resolve/acme`). Pin a folder with `GRAPHIFY_HOME`. After a learn, the next MCP call sees it — no restart.

## How the agent learns (two paths)

**Primary — Figma MCP.** `get_metadata` on a library frame, then Resolve `learn_library` with that XML, the **file key**, and `role: "library"`. Optional: pass `search_design_system` / `get_libraries` as `libraries` so cards include the published component key. Without that key the card says **local-only**.

**Secondary — REST token.** `npm run resolve -- ingest '<figma-url>' --role library` with `FIGMA_ACCESS_TOKEN`.

**Big libraries.** Do not dump the whole file. Call `learn_library` on a few frames, stop, come back later. Checkpoints survive across sessions. A view/free seat with a low quota uses the same resume path.

Then: `recipe` / `recommend` → place only returned `fileKey` + `nodeId` (and `componentKey` when published) with Figma `use_figma` → `verify_frame`. A pass writes usage into SOCK. Rules never change themselves.

## What Resolve will not do

- Invent a component id
- Dump the graph into chat
- Promote a pattern seen on only one verified screen (needs 3)
- Promote a deprecated or private (`.` / `_`) master
- Change your rules without a SOCI proposal (list only; approval UI later)

Default tools: `learn_library`, `recipe`, `recommend`, `resolve`, `verify_frame`, `check_cousins`. Set `RESOLVE_MCP_ADVANCED=1` for the rest.
