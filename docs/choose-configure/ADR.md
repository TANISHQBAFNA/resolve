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
skills/resolve-configure/SKILL.md       # only when/how and the evidence contract
skills/resolve-configure/guidelines.md  # only the decision principles
.cursor/skills/resolve-configure        # symlink to ../../skills/resolve-configure
rules/resolve-configure.mdc             # one sentence; does not restate guidelines
rules/resolve.mdc                       # one sentence that names the rule
skills/resolve/SKILL.md                 # one sentence that names the skill
src/core/chooseConfigure/configure.ts   # next PR: one function for CLI, MCP, slash
commands/configure.md                   # next PR: thin slash text
```

Shared identity, the graph, Figma ingest, and the store stay in `src/core/model`, `src/core/query`, `src/core/ingestion`, and `src/server/store`. `configure.ts` will call them. It will not wrap them in a barrel.

### Why this boundary

A reader looking for "how do I choose and configure" opens `skills/resolve-configure/`. A reader looking for "what code runs" opens `src/core/chooseConfigure/`. The skill folder is what Claude Code and the Cursor plugin load (`skills` is `./skills` in the Cursor plugin, and `resolve-setup` copies that folder into `.claude/skills/`). The symlink is there because Cursor also reads `.cursor/skills` inside this repo. It is not a second document.

The old pattern stores each skill twice. Extending that pattern would make two guidelines files that can drift. The symlink fails the test if the files diverge, because there is only one inode.

### Loaders

- Claude Code: `resolve-setup` copies `SKILL.md` and `guidelines.md` into `.claude/skills/resolve-configure/`. A file you wrote, with no Resolve markers, is kept.
- Cursor plugin: `skills` is `./skills`, so `skills/resolve-configure` is the package skill.
- Cursor in this repo: `.cursor/skills/resolve-configure` is the same directory.
- Session start prints the core skill description, which names `resolve-configure`. It does not paste the guidelines.

### One implementation, next PR

CLI, MCP, and `/configure` will call one function. It reuses recommend, property definitions, and usage counts. The result is for the designer: the component, the configuration, and what could not be verified. It does not write an engineering export. Screen map and learn-from-screens stay optional. Missing facts are warnings with `next:`, never a block. Optional advisory readiness stays the existing brief check. It is not part of this command.

## Not in this slice

- Learn-from-screens (on hold).
- Screen map (open PRs 148–155, not merged).
- Ranking changes (open PRs 146–147, not merged).
- A Claude role layer. No such commits are on GitHub. This slice does not invent one.
- A signed-in Claude or Cursor session. Setup and hook checks are not that.

## Public names

DSCK, DSCI, and Acme examples only.
