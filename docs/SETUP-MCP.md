# Resolve next to Figma MCP — plug and play

**Figma rules. Agents resolve.**

Resolve is for AI tools (Cursor, Claude). Turn on Figma’s connector and Resolve’s connector in the same tool.

Resolve works best when the Figma connection is active and there is a design system, library, or existing screens for it to learn from. If either is missing, the agent should tell you in plain words what is missing and how to add it. It should not invent a component.

Claude Code cuts each MCP server’s instructions at 2,048 characters. Resolve keeps that text under 1,500 so the “call Resolve first” trigger survives. The longer workflow is an MCP resource, `resolve://workflow`.

Learning a library needs **one** of:

- a **paid Figma seat with MCP access** (Dev or Full), or
- a **Figma access token** (`FIGMA_ACCESS_TOKEN`) for command-line REST ingest.

**View or free seats** get a low Figma read quota. Resolve does not fail the whole library: it saves progress and **resumes** on the next pass. Feed a few frames per session.

## Before you start

1. `node -v` must be **22.12 or newer**. If it is older, install the current LTS from [nodejs.org](https://nodejs.org).
2. `git --version`. On a Mac, that command installs the command line tools if they are missing.
3. Do not start the server in a terminal, and do not wait for a ready line. The design app starts Resolve. You do not leave a terminal running.

4. Once, in the project, so the agent calls Resolve on every design task:

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-setup
```

That writes `.cursor/rules/resolve.mdc`, `.claude/skills/resolve/SKILL.md`, and a marked block in `CLAUDE.md` in this project. Cursor needs that project rule. It does not load a rule from your home folder. A second run only edits inside a complete pair of markers. `--global` is for Claude only (`~/.claude/skills/resolve/SKILL.md` and `~/.claude/CLAUDE.md`). It prints those home-folder paths and exits unless you pass `--yes`. Claude Desktop does not read rule files, skills, or `CLAUDE.md`. It only gets the MCP instructions.

5. If Claude Desktop cannot start Resolve, use the full path from `which npx` as the `command` (keep the same `args`).

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

Plugin installs read the server from `.claude-plugin/plugin.json`. If you write a Claude Code project config that lists Figma, set `"type": "http"`:

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

Same store for CLI and MCP: `~/.resolve/default` (or `RESOLVE_WORKSPACE=acme` → `~/.resolve/acme`). Pin a folder with `RESOLVE_HOME`. After a learn, the next MCP call sees it — no restart.

## How the agent learns (two paths)

**Primary — Figma MCP.** `get_metadata` on a library frame, then Resolve `learn_library` with that XML, the **file key**, and `role: "library"`. Optional: pass `search_design_system` / `get_libraries` as `libraries` so cards include the published component key. Without that key the card says **local-only**.

`get_metadata` has layer names, not confirmed component ids. A renamed layer is not the component. Pass `get_design_context` as `designContext` (on learn and on verify) for exact ids: HTML `componentId` / `componentKey` / `data-component-id`, or JSON `"componentId"`. That `componentId` is a plain node id like `14:101`. Stamped `fileKey:nodeId` works with `--components`; the same form inside a design-context `componentId` is treated as a guess. REST ingest with `FIGMA_ACCESS_TOKEN` also has exact ids. Do not put a token in the repo.

**Different file.** Placing a component into a different Figma file needs the library published, plus `search_design_system` output passed as `libraries`. Otherwise build inside the library file. A product screen (`role: "product"`, or any file that is not the library) does not become the approved master list.

**Secondary — REST token.** `npm run resolve -- ingest '<figma-url>' --role library` with `FIGMA_ACCESS_TOKEN`. Never store that token in the repo.

**Big libraries.** Do not dump the whole file. Call `learn_library` on a few frames, stop, come back later. The card says `learned X of Y pages; next: …`. Checkpoints survive across sessions. A view/free seat with a low quota uses the same resume path. When a file is stale, `freshness.delta` lists the exact pages/frames to re-fetch.

Then: `recipe` (`query` or `intent`) / `recommend` → `get_example` (`ex` is on the top pick; call `get_example` for the others) → clone that instance and replace content; do not start from the default variant → place only returned `fileKey` + `nodeId` (and `componentKey` when published) with Figma `use_figma` → before verify, fetch the frame's design context so Resolve can read the text → `verify_frame` with that `designContext`. A real master id in `components` is checked as that master (an empty same-name stub in another file does not replace it). Pass the same kind of design context to `learn_library` so the component default is stored. `get_metadata` does not carry text characters. `textChecked` is true only when the instance text and that default were both read; otherwise the card says `partial`, `false`, or `n/a`. `texts` only fills empty layers inside the frame. A pass writes usage into SOCK. The same populated shape on 3 verified screens becomes the preferred example. Rules never change themselves. Team template strings go in `.resolve/placeholders.json`. Same store for CLI and MCP: `RESOLVE_HOME` also holds scoreboard history.

## What Resolve will not do

- Invent a component id
- Dump the graph into chat
- Promote a pattern seen on only one verified screen (needs 3)
- Promote a deprecated or private (`.` / `_`) master
- Change your rules without a SOCI proposal — you approve (`resolve approve --who`). SOCI never auto-applies.

Default tools: `learn_library`, `recipe`, `recommend`, `resolve`, `get_example`, `verify_frame`, `check_cousins`. Set `RESOLVE_MCP_ADVANCED=1` for the rest.
