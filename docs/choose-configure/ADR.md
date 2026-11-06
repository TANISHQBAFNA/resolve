# ADR: choose and configure

Status: accepted for this slice. Date: 6 Nov 2026.

## Problem

Resolve can rank a component. It does not yet walk an AI through choosing and configuring that component for a screen, with the evidence and the gaps in one place. Guidance for that job is not a file the Claude Code or Cursor loaders install.

## Decision

Ship one feature, `resolve-configure`. Guidance has one owner. Logic will sit beside the graph code it calls, not inside the skill the agent reads.

### Before

```
skills/resolve/SKILL.md
skills/resolve-figma/SKILL.md
skills/resolve-code/SKILL.md
.cursor/skills/resolve/SKILL.md        # second copy of the same file
.cursor/skills/resolve-figma/SKILL.md  # second copy
.cursor/skills/resolve-code/SKILL.md   # second copy
rules/resolve.mdc
rules/resolve-figma.mdc
rules/resolve-code.mdc
src/core/query/                        # ranking, properties, usage
commands/                              # slash text
```

Those `.cursor/skills` copies stay. Tests require them to match `skills/`, and this slice does not rewrite every pack.

### After

```
skills/resolve-configure/SKILL.md       # when/how and the evidence contract
skills/resolve-configure/guidelines.md  # the only copy of the principles
.cursor/skills/resolve-configure        # symlink, not a second file
rules/resolve-configure.mdc             # one sentence
src/core/chooseConfigure/configure.ts   # the choice
src/server/configureCommand.ts          # CLI and MCP call that function
commands/configure.md                   # slash text for the same function
```

Shared identity, the graph, Figma ingest, and the store stay in `src/core/model`, `src/core/query`, `src/core/ingestion`, and `src/server/store`. `configure.ts` calls them. There is no barrel.

### Copies that stay

These are loader files, not a second copy of the configure principles. Tests require the pairs to match, or require the same Figma path phrases in each:

```
skills/resolve/SKILL.md == .cursor/skills/resolve/SKILL.md
skills/resolve-figma/SKILL.md == .cursor/skills/resolve-figma/SKILL.md
skills/resolve-code/SKILL.md == .cursor/skills/resolve-code/SKILL.md
rules/resolve-figma.mdc
AGENTS.md
docs/AGENTS-RESOLVE-SECTION.md
bin/resolve-setup.mjs CLAUDE_BLOCK
src/server/instructions.ts
```

The Figma skill and the Figma rule now point at `resolve-configure` for choosing and configuring one component. They do not restate `guidelines.md`. The recommend step stays, because placing a frame still ranks a slot that way.

No configure file was deleted in the folder pass. The duplicate that was avoided is a second `guidelines.md` under `.cursor/skills`. `cmp` on the symlink target is one inode.

### One implementation

CLI, MCP, and `/configure` call `configureChoice`. The adapter resolves the graph once. The result is for the designer. It does not write an engineering export. Screen map and learn-from-screens stay optional. Missing facts are warnings with `next:`, never a block. Optional advisory readiness stays the existing brief check. It is not part of this command.

### Why this boundary

A reader looking for "how do I choose and configure" opens `skills/resolve-configure/`. A reader looking for "what code runs" opens `src/core/chooseConfigure/`. The skill folder is what Claude Code and the Cursor plugin load (`skills` is `./skills` in the Cursor plugin, and `resolve-setup` copies that folder into `.claude/skills/`). The symlink is there because Cursor also reads `.cursor/skills` inside this repo. It is not a second document.

### Loaders

- Claude Code: `resolve-setup` copies `SKILL.md` and `guidelines.md` into `.claude/skills/resolve-configure/`. A file you wrote, with no Resolve markers, is kept.
- Cursor plugin: `skills` is `./skills`, so `skills/resolve-configure` is the package skill.
- Cursor in this repo: `.cursor/skills/resolve-configure` is the same directory.
- Session start prints the core skill description, which names `resolve-configure`. It does not paste the guidelines.

## Not in this slice

- Learn-from-screens (on hold).
- Screen map (open PRs 148–155, not merged).
- Ranking changes (open PRs 146–147, not merged).
- A Claude role layer. No such commits are on GitHub. This slice does not invent one.
- A signed-in Claude or Cursor session. Setup and hook checks are not that.

## Public names

DSCK, DSCI, and Acme examples only.
