# Host check for choose-and-configure guidance

What this repo can prove: the skill folder holds `SKILL.md` and `guidelines.md`, setup copies both into `.claude/skills/resolve-configure/`, the Cursor plugin `skills` field is `./skills`, and `.cursor/skills/resolve-configure` is a symlink to that folder. Session start prints the skill descriptions, including the line that names `guidelines.md`. It does not paste the principles. A process check of that script is not a signed-in session.

## On a Mac, signed in

1. In a scratch project, with `RESOLVE_HANDOFF` unset, run `npx -y -p github:TANISHQBAFNA/resolve#v0.2.0 resolve-setup`.
2. Confirm `.claude/skills/resolve-configure/guidelines.md` and `.claude/commands/handoff.md` — the guidelines file is there, the handoff command is not.
3. Open Claude Code in that project. Ask it to choose a button for a sign-in screen. It should read `guidelines.md` from the skill folder and call `configure`.
4. In Cursor, open the same project with the Resolve plugin. Confirm the command list has `/configure` and does not have `/handoff`. Ask the same question.

Do not copy a token into the repo. Do not start a paid model run for the formative eval. `node scripts/choose-configure-eval.mjs` with no files prints `not run`.
