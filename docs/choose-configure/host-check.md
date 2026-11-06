# Host check for choose-and-configure guidance

`#v0.2.0` does not contain this revision. Do not install `github:TANISHQBAFNA/resolve#v0.2.0` and expect `configure`, the guidelines file, or the handoff removal. That tag was cut earlier and has not moved.

Test `main` after this pull request is merged. Do not install `github:TANISHQBAFNA/resolve#v0.2.0` for this check, and do not point the scratch project at an `npx` cache path.

1. In the checkout: `npm run build:server` once, so `dist-server/mcp.mjs` exists.
2. In a scratch project (that folder is not the checkout): `node /absolute/path/to/resolve/bin/resolve-setup.mjs`.
3. `.mcp.json` has `mcpServers.resolve.command` set to that same Node binary and `args` set to `/absolute/path/to/resolve/dist-server/mcp.mjs`. There is no `cwd`. `.cursor/mcp.json` is the same server without `type` and `env`.
4. `.claude/commands/resolve-status.md` contains that Node binary and `/absolute/path/to/resolve/bin/resolve-cli.mjs`, and does not contain `#v0.2.0`. Run the command in the scratch project. The absolute path is what finds this checkout.

What a file check can prove: the skill folder holds `SKILL.md` and `guidelines.md`, setup copies both into `.claude/skills/resolve-configure/`, the Cursor plugin `skills` field is `./skills`, and `.cursor/skills/resolve-configure` is a symlink to that folder. Session start prints the skill descriptions, including the line that names `guidelines.md`. It does not paste the principles. None of that proves a signed-in Claude or Cursor session loaded the file.

## On a Mac, signed in, after this revision is what you are running

1. In a scratch project, with `RESOLVE_HANDOFF` unset, run the checkout setup from step 2 above.
2. Confirm `.claude/skills/resolve-configure/guidelines.md` is present and `.claude/commands/handoff.md` is absent. Confirm `.mcp.json` points at this checkout's `dist-server/mcp.mjs`.
3. Open Claude Code in that project. Ask it to choose a button for a sign-in screen. See whether it reads `guidelines.md` and calls `configure`. That is the check this repo cannot make.
4. In Cursor, open that scratch project. The server to use is the project entry setup wrote. The repository files `mcp.json` and `.mcp.json` still name `#v0.2.0` for a plugin install of the published tag. Confirm the command list has `/configure` and does not have `/handoff`. Ask the same question.

Do not copy a token into the repo. Do not start a paid model run for the formative eval. `node scripts/choose-configure-eval.mjs` with no files prints `not run`.
