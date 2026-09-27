# Resolve next to Figma MCP — plug and play

**Figma rules. Agents resolve.**

You do **not** need a Figma personal access token, a clone of this repo, or a hand-built JSON file. Turn on Figma’s connector and Resolve’s connector in the same AI tool.

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

## What you tell the agent

1. In Figma MCP, call `get_metadata` on a library frame (or a few, for a big file).
2. Call Resolve `learn_library` with that XML, the **file key**, and `role: "library"`.
3. Optional: pass `search_design_system` / `get_libraries` as `libraries` so cards include the **published component key** (`importComponentByKeyAsync`). Without that key the card says **local-only**.
4. `recipe` / `recommend` → place only returned `fileKey` + `nodeId` (and `componentKey` when published) with Figma `use_figma`.
5. `verify_frame`. A pass writes usage into SOCK. Rules never change themselves.

Huge libraries: the [Figma plugin export](../figma-plugin/README.md) or REST ingest (`FIGMA_ACCESS_TOKEN`) are still the better full-file paths. `learn_library` is checkpointed so you can feed frames in several passes.

## What Resolve will not do

- Invent a component id
- Dump the graph into chat
- Promote a pattern seen on only one verified screen (needs 3)
- Promote a deprecated or private (`.` / `_`) master
- Change your rules without a SOCI proposal (list only; approval UI later)

Default tools: `learn_library`, `recipe`, `recommend`, `resolve`, `verify_frame`, `check_cousins`. Set `RESOLVE_MCP_ADVANCED=1` for the rest.
