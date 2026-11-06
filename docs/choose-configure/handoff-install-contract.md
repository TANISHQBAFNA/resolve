# Proposed test contract: handoff is not a default slash command

Status: not applied. Needs Tanishk's approval before any assertion below is edited.

The installer now skips `commands/handoff.md` unless `RESOLVE_HANDOFF=1`. MCP prompts do the same. The legacy file stays in `commands/` so the existing assertions below still pass. Those assertions were not changed.

## Why the current assertions still pass

`tests/noAmbientStore.ts` sets `RESOLVE_HANDOFF=1` for the whole vitest process. A setup run inside that process still installs the command. That is the opt-in path, not a machine where the variable is unset.

## Old behaviour the assertions lock

Default `resolve-setup` copies every file in `commands/`, including `handoff.md`, into `.claude/commands` and `.cursor/commands`. MCP `prompts/list` returns that name. The Cursor plugin `commands` field is the whole `commands/` directory, so a plugin install publishes `/handoff` too. `scripts/fresh-install-kit.mjs` plans a run for every command file.

## Desired behaviour

With `RESOLVE_HANDOFF` unset:

- setup does not write `.claude/commands/handoff.md` or `.cursor/commands/handoff.md`
- `prompts/list` does not include `handoff`
- setup `--help` does not name `/handoff`
- the Cursor plugin command directory does not publish `/handoff`
- the fresh-install kit does not plan `/handoff`

With `RESOLVE_HANDOFF=1`, the legacy command is installed, listed, and runnable. The implementation stays.

## Assertions that would have to change

Not edited in this PR.

`tests/server.setup.test.ts`, the packed-install check:

```diff
- expect(existsSync(join(installDir, ".claude/commands/handoff.md"))).toBe(true);
+ expect(existsSync(join(installDir, ".claude/commands/handoff.md"))).toBe(false);
+ expect(existsSync(join(installDir, ".claude/commands/configure.md"))).toBe(true);
```

That child process currently inherits the vitest environment, so the new line is false only after the pack command is given an environment without `RESOLVE_HANDOFF`.

`tests/plugin.manifest.test.ts` lists `handoff.md` inside `commands/`. Moving the file out of that directory (so the Cursor plugin stops publishing it) changes this exact list. Leave the file until that move is approved.

`tests/freshInstallKit.test.ts` requires `commandPlan()` names to equal every `commands/*.md` file. Omitting `handoff` from the default plan fails that equality. Leave the plan until that assertion is approved.

`tests/server.slashCommands.test.ts` reads every non-code command after setup, including `handoff`, and checks its phrases. That loop passes today because the harness sets `RESOLVE_HANDOFF=1`. A default-off loop should skip `handoff` unless the test sets the flag itself.
