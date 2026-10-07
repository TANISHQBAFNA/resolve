# Install Resolve (instructions for an AI agent)

You are an AI agent (Claude Code, Cursor or Codex). A user asked you to install Resolve from https://github.com/TANISHQBAFNA/resolve. Follow the steps below in order. Resolve helps AI tools use the real components of a Figma design system. See [README.md](README.md) for what it does. Do not start from the README; this file is the install path.

## Rules (read first)

1. **Project first.** Do everything inside the user's current project folder. Do not touch user-level settings without asking: `~/.claude.json`, `~/.claude/`, `~/.cursor/`, `~/.codex/`. If a step needs one of those, ask the user and wait for a yes. A `claude mcp add ... -s user` command or a `codex mcp add` command writes there, so it needs a yes.
2. **Never print secrets.** Never print a token, and never print or paste the contents of `~/.claude.json`, `~/.cursor/mcp.json` or `~/.codex/config.toml`. To check for something in them, search for a word and answer yes or no. **Never run `claude mcp list` (or `codex mcp list`).** They print the command, arguments and settings of every MCP server the user has, and those can hold secrets. Ask about one server by name instead: `claude mcp get <name>` (or `codex mcp get <name>`).
3. **Safe to repeat.** Check before you add. If something is already there, leave it and say so. Never remove or replace a server the user already has. Never overwrite a file that is not valid JSON; tell the user instead.
4. **Report what changed.** At the end, list every file you created or changed and every command you ran (see step 6).
5. **Do not make the user do your work.** The user should only have to restart the tool, sign in to Figma and paste a Figma file link (step 5).

## Step 0. Check Node

Run `node -v`. It must be 22.12 or newer. If it is not, stop and tell the user to install the current Node from https://nodejs.org (it comes with a new enough npm). Do not continue on an older Node: the install command can fail silently on old npm versions.

## Step 1. Run the setup command (all tools)

In the user's project folder:

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-setup
```

You can add `--dry-run` first to see what it would do. It is safe to run again.

Expected output: lines starting with `create` (or `unchanged` on a repeat run) for `.cursor/rules/resolve.mdc`, `.cursor/mcp.json`, `.mcp.json`, `.claude/skills/resolve/SKILL.md`, `CLAUDE.md`, `.gitignore` and the slash commands (`.claude/commands/` and `.cursor/commands/`, one file each for `design-system`, `find`, `check`, `parts`, `handoff` and `resolve-status`), then a checklist (`Node ok?`, `Figma connected?`, `Library learned?`, `Rule installed?`) and a `Next:` line.

- The slash commands let the designer type `/design-system <Figma link>`, `/find <phrase>`, `/check <link>`, `/parts <screen link>` (what's on this screen and its code twin, or unmapped), `/handoff <link>` (the developer build sheet) and `/resolve-status`. Setup writes them; do not create or edit them by hand. A command file the user wrote (no Resolve markers) is kept, and setup says `skip ... kept your own file`; that is fine, report it, and do not use `--force`. Running setup again updates the Resolve ones. To remove everything Resolve added (only after the user asks): `npx -y -p github:TANISHQBAFNA/resolve resolve-setup --uninstall`.
- Setup adds a marked block to `.gitignore` that ignores only the learned cache (`.resolve/graph.json`, `.resolve/files/`, `.resolve/learn/`, `.resolve/ingest/`). Recipes, the code map and decisions stay committable. If the project already ignores the whole `.resolve` folder, say so: that line also hides the team files.
- This adds the `resolve` server to the project's `.cursor/mcp.json` (Cursor) and `.mcp.json` (Claude Code). It keeps any other servers in those files.
- If it prints `The Resolve connection was NOT added to <file>`, that file is not valid JSON or has an unusual shape, or it already has a different `resolve` entry. Do not overwrite it. Tell the user which file, and in step 2 add the entry by hand only if the file is valid JSON.
- If the command prints nothing and exits with code 127, npm is too old. Go back to step 0.

## Step 2. Connect Resolve and Figma for the user's tool

Do the part for the tool you are running in. If you cannot tell, do the one that matches the folders in the project (`.cursor/` for Cursor, `CLAUDE.md` or `.claude/` for Claude Code, `AGENTS.md` for Codex).

### Claude Code

1. Resolve is already in the project's `.mcp.json` from step 1. Run `claude mcp get resolve`. Expect `resolve:` with `Scope: Project config (shared via .mcp.json)`. `Status: ⏸ Pending approval (run claude to approve)` is normal: the user approves a project server the first time they start `claude`. Tell them in step 5.
2. Figma. Run `claude mcp get figma`. If it prints `figma:` with a `Scope` and a `Status`, skip this. If it answers `No MCP server named "figma"`, Figma is not there yet. Add it to the project (project scope needs no ask):

   ```bash
   claude mcp add --transport http figma https://mcp.figma.com/mcp -s project
   ```

   Expect `Added HTTP MCP server figma ... to project config`. (`-s user` would make it available in all projects, but it writes `~/.claude.json`, so only do that if the user says yes.)
3. Run `claude mcp get figma` again. Expect `figma:` with `Scope: Project config (shared via .mcp.json)` and `Status: ⏸ Pending approval (run claude to approve)`. The user approves it and signs in to Figma in step 5. (Checked: a figma server added at project scope shows `Pending approval`, not `Needs authentication`, until it is approved.)
4. A Claude Code session that is already running does not see the new `.mcp.json`. Tell the user to quit and start `claude` again in the project (step 5).

### Cursor

1. Resolve is already in `.cursor/mcp.json` from step 1.
2. Figma. Check whether a Figma server is already set up: search the project's `.cursor/mcp.json` and, read-only, the user's `~/.cursor/mcp.json` for the word `figma` (answer yes or no; do not print the file). If it is there, skip this.
3. If it is not, add this to the project's `.cursor/mcp.json`, inside `"mcpServers"`, next to the other servers (merge; do not replace the file):

   ```json
   "figma": { "url": "https://mcp.figma.com/mcp" }
   ```

   Keep the file valid JSON. Add a comma where needed.
4. Tell the user to reload the Cursor window (step 5).

### Codex (not verified)

Everything in this part follows OpenAI's Codex documentation and has not been run.

1. Codex reads project instructions from `AGENTS.md`. Append the short section from [docs/AGENTS-RESOLVE-SECTION.md](docs/AGENTS-RESOLVE-SECTION.md) to the project's `AGENTS.md` if it does not already contain a `## Resolve` heading.
2. Codex keeps MCP settings in `config.toml`. Per its documentation, the project file is `.codex/config.toml` (used for trusted projects only) and the user file is `~/.codex/config.toml`. Prefer the project file. If `.codex/config.toml` has no `[mcp_servers.resolve]` table, append:

   ```toml
   [mcp_servers.resolve]
   command = "npx"
   args = ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
   ```

   If the user prefers the user file, or the project is not trusted, ask first, then run `codex mcp add resolve -- npx -y -p github:TANISHQBAFNA/resolve resolve-mcp`.
3. Figma: run `codex mcp get figma` to see if it is set up. (`codex mcp get` exists in Codex's source code; it has not been run here. If `codex mcp --help` does not show `get`, do not list servers: just say so to the user.) If it is missing, ask the user, then run `codex mcp add figma --url https://mcp.figma.com/mcp` (this writes the user file).
4. Run `codex mcp get resolve` to confirm the Resolve entry.

## Step 3. Verify

Run `npx -y -p github:TANISHQBAFNA/resolve resolve-setup` again. Expect `unchanged` lines and a checklist where `Node ok?` and `Rule installed?` say `yes`. `Figma connected?` should say `yes` once Figma is added. (For Claude Code and Cursor it looks at the project files and at the Figma list in `~/.claude.json`, read-only. For Codex it cannot see the Figma entry, so it may say `no`; trust `codex mcp get figma`.) `Library learned?` says `no` until step 5 is done.

## Step 4. If something fails

- Do not retry with `--force` and do not edit user-level files to get around an error. Report the exact message to the user.
- A file that is not valid JSON is the user's file. Do not rewrite it.

## Step 5. Tell the user the only manual steps

Say this in plain words:

1. **Restart the tool.** A session that is already running does not see the new settings files. Claude Code: quit and start `claude` again in the project. Cursor: reload the window (Command Palette, "Developer: Reload Window"). Codex: start a new session.
2. **Sign in to Figma.** Claude Code: start `claude`, say yes to the project's `resolve` server, type `/mcp`, choose figma and log in. Cursor: reload the window, open Settings, MCP, and sign in to Figma. Codex: run `codex mcp login figma` if it asks.
3. **Paste a Figma file link** into this chat, for example: "Learn my Figma design system from this link: (the link)" (or type `/design-system (the link)`). You then call `get_metadata` and `learn_library`. Learning needs a Dev or Full Figma seat; a View or free seat has a small read allowance, and Resolve saves its progress.

After the library is learned, running `resolve-setup` again shows `Library learned? yes`.

For a screen, read the requirements or FSD yourself and pass `product`, `journey`, `domain`, `audience`, and `a11y` only when that document states them. Leave a field off when it does not. Do not invent a product. A context pack is optional: Resolve uses one only on an exact product match, and an exact journey match when the document gives a journey. Do not pass `pack` unless the document names that pack id. Audience, a11y, and density do not change which component is picked.

## Step 6. Report

Finish with a short list:

- Files created or changed (for example `.cursor/mcp.json`, `.mcp.json`, `.cursor/rules/resolve.mdc`, `.claude/skills/resolve/SKILL.md`, `CLAUDE.md`, the slash commands in `.claude/commands/` and `.cursor/commands/`).
- Commands you ran, and whether each succeeded.
- Anything you skipped or left alone, and why.
- The two manual steps from step 5, and that the designer can now type `/design-system <Figma link>` to learn the library, then `/find`, `/check`, `/parts`, `/handoff` and `/resolve-status`.

## If you must edit a JSON file by hand

Merge, never replace. The `resolve` entry for `.cursor/mcp.json` is:

```json
"resolve": { "command": "npx", "args": ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"] }
```

For Claude Code's `.mcp.json` add `"type": "stdio"` and `"env": {}` to that entry.
