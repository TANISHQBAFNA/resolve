# Handoff install contract

Status: applied. Tanishk approved the assertion changes that take the developer export out of default discovery.

## What changed

`commands/handoff.md` moved to `legacy/commands/handoff.md`. The Cursor plugin `commands` field is `./commands`, so that directory is the published command list. The legacy file is outside it.

`resolve-setup` copies `commands/*.md` always. It copies the legacy file only when `RESOLVE_HANDOFF=1`. Uninstall still deletes `.claude/commands/handoff.md` and `.cursor/commands/handoff.md` if an older install wrote them.

MCP prompts read `commands/` always, and the legacy file only when the flag is set.

`commandPlan()` omits `handoff` unless `RESOLVE_HANDOFF=1` or the caller passes that env.

`tests/noAmbientStore.ts` no longer sets `RESOLVE_HANDOFF`. Tests that run the legacy command set the flag in that file.

## Assertions

| Test | Before | After |
| --- | --- | --- |
| `tests/server.setup.test.ts` packed install | `handoff.md` exists | `handoff.md` is absent, `configure.md` exists, and the child env has the flag removed |
| `tests/plugin.manifest.test.ts` | command list includes `handoff.md` | list matches `commands/` and does not include `handoff.md`; `legacy/commands/handoff.md` exists |
| `tests/freshInstallKit.test.ts` | default plan includes `handoff` | default plan equals `commands/` and has no `handoff`; a plan with `RESOLVE_HANDOFF=1` includes it |
| `tests/server.slashCommands.test.ts` | install loop reads every command, including handoff, because the harness flag was on | default install does not write `handoff.md`; the loop checks the commands that are actually shipped |
| `tests/server.cards.test.ts`, `tests/query.specMap.test.ts`, `tests/server.mcpSurface.test.ts` | advanced tool list length 18, because the harness flag included `get_handoff` | `TOOLS` still has 18 entries, including `get_handoff`. With the flag unset, `listToolDefinitions(true)` is 17 and does not name it. `tests/handoff.optIn.test.ts` checks the flag turns that 18th tool back on |

The legacy CLI, MCP tool, and command text stay. They are not on the default install path.
