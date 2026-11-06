# Host check for choose-and-configure guidance

`#v0.2.0` does not contain this revision. Do not install `github:TANISHQBAFNA/resolve#v0.2.0` and expect `configure`, the guidelines file, or the handoff removal. That tag was cut earlier and has not moved.

Test the merge-ready branch, or `main` after this pull request is merged. From a checkout of that commit, run `node bin/resolve-setup.mjs` in a scratch project. Do not point the scratch project at the old tag.

What a file check can prove: the skill folder holds `SKILL.md` and `guidelines.md`, setup copies both into `.claude/skills/resolve-configure/`, the Cursor plugin `skills` field is `./skills`, and `.cursor/skills/resolve-configure` is a symlink to that folder. Session start prints the skill descriptions, including the line that names `guidelines.md`. It does not paste the principles. None of that proves a signed-in Claude or Cursor session loaded the file.

## On a Mac, signed in, after this revision is what you are running

1. In a scratch project, with `RESOLVE_HANDOFF` unset, run setup from this checkout: `node /path/to/resolve/bin/resolve-setup.mjs`.
2. Confirm `.claude/skills/resolve-configure/guidelines.md` is present and `.claude/commands/handoff.md` is absent.
3. Open Claude Code in that project. Ask it to choose a button for a sign-in screen. See whether it reads `guidelines.md` and calls `configure`. That is the check this repo cannot make.
4. In Cursor, open the same project with the Resolve plugin from this checkout. Confirm the command list has `/configure` and does not have `/handoff`. Ask the same question.

Do not copy a token into the repo. Do not start a paid model run for the formative eval. `node scripts/choose-configure-eval.mjs` with no files prints `not run`.
