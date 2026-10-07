# Resolve

> Figma rules. Agents resolve.

[github.com/TANISHQBAFNA/resolve](https://github.com/TANISHQBAFNA/resolve) · MIT licensed · free to use

Every example in this file is made up. "Acme" is a pretend company, the "Payments app" is a pretend product, and the components (Button, Text field, Payee picker) are pretend. None of it comes from a real design system.

**Quick start:** open your project in Claude Code, Cursor or Codex and paste: *Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md*. The AI-facing checklist is [`INSTALL-FOR-AI.md`](INSTALL-FOR-AI.md); the plain steps are under [Set it up](#set-it-up).

You can read this file from top to bottom without knowing any code. The first half is for designers. The second half, under **For engineers and testers**, is reference detail that you can skip.

## The story in one minute

**The problem.** You ask an AI tool (Claude, Cursor or Codex) to draw a screen in Figma. It is fast, but it guesses. It may draw a button from scratch instead of using the Button in your design system. It may pick a component your team retired, because the name looks right. It may even invent a part that does not exist. The screen looks fine at a glance, but it is not built from your design system, so it slowly drifts away from it.

**Without Resolve.** You ask Claude for a "Send money" screen in the Acme Payments app. Claude draws a rounded rectangle that looks like a button. It places "Old Button", a component Acme retired last year. It adds a part called "Payee dropdown" that is not in the library at all. Nobody notices until an engineer tries to build the screen.

**With Resolve.** You ask the same thing. Before it draws anything, Claude asks Resolve, "Which component do I use for a payee picker?" Resolve answers: "The Acme Payee picker. Here is where it lives in Figma, and here is a real example of it to copy." Claude places that real component. When the screen is drawn, Claude asks Resolve to check it. Resolve says: "Fail. This screen uses the retired Old Button. Use Button instead." Claude fixes it. If you ask for something the library does not have, Resolve says "no match", and Claude tells you, instead of making one up.

**What you see.** You do not open Resolve, and there is nothing to click. You see it in your AI tool's chat: Claude says which library components it chose, and it tells you the result of the check ("passed" or "failed, because..."). In Figma you get a screen made of real library components.

**What Resolve is not.** It is not a Figma plugin. It does not draw anything; your AI tool draws. It never changes your Figma file; it only reads. It never guesses: no match means no answer. And it never changes your team's rules (for example "on the pay step, use this Button") by itself; a person approves every change.

## Slash commands

Once Resolve is installed, type these in the chat of Claude Code or Cursor. Each one tells your AI tool exactly what to ask Resolve, and what to show you. You paste a Figma link where it says `<link>`; a link to a single screen (it has `node-id=20-40` in it) works everywhere a screen is asked for. In every case, if Resolve has no match it says so. It never makes a component up.

| Type | What happens | What you see |
|---|---|---|
| `/design-system <link>` | Resolve learns that Figma file (or page, or frame) and saves its components on your computer. A very big file is learned page by page. | What was learned (file name, how many components), what is still left, and where it is saved. |
| `/find <phrase>` | Resolve picks the right component for your words, for example `/find payee picker`. | The best component with its Figma id and a one-line reason, plus up to two other options. Or "no match". |
| `/check <link>` | Resolve checks a finished screen. | Three short lists: **Retired** (old components still on the screen), **Wrong** (a lookalike from the wrong family) and **Unknown** (not in the library). Or "passed". |
| `/parts <component>` | Shows what is inside a component, for example `/parts Payee picker`. | The parts it is built from (Avatar, Button), each with its code component, or "no code link yet". |
| `/handoff <link>` | Writes the developer handoff sheet for a screen. | Every component with its Figma id and code, the parts inside, which recipe slots are filled, the check result and open questions. Or the reason it refused. |
| `/resolve-status` | Shows what Resolve has learned. | Each learned file, when it was last learned, and how much of the library links to code. |

Setup (`resolve-setup`) puts these files in your project: `.claude/commands/` for Claude Code and `.cursor/commands/` for Cursor. Your AI tool shows them when you type `/`. Codex has no project commands; with Codex, say the same thing in words ("check this screen with Resolve: link"). Other tools can read the same commands as MCP prompts. To update them, run setup again. To remove everything Resolve added, ask your AI tool to run `resolve-setup --uninstall`; your own files and text stay.

## What Resolve does, one piece at a time

- **It learns your library.** You give it your design system file once. It reads the file and writes down what is in it: every component, its variants (for example Primary and Secondary), and where each one is used on real screens. You can repeat this whenever the library changes. This step has two names: **learn** (when your AI tool does it) and **ingest** (when you do it by hand). They mean the same thing: read a Figma file and remember it.
- **It recommends.** You describe what you need in plain words ("payee picker", "primary button"). Resolve picks the best matching component. It looks at the name and your words first. If the match is only partial, it says "weak match" and offers up to three options, instead of pretending to be sure.
- **It shows a real example.** With the pick, Resolve points to a real, filled-in copy of that component on a real screen. The AI tool clones it and swaps the content, which looks far better than starting from a bare default.
- **It checks the finished screen.** Resolve looks at every piece on the screen and answers pass or fail. It flags parts that are not in the library, parts that are retired, and leftover template text such as "Lorem ipsum". It checks by each component's real Figma id (a hidden number every component has), not just by its layer name (the label you see in Figma's layers list), because a layer called "Button" can be anything.
- **It knows what is retired.** A **retired** component is one your team no longer wants on new screens, although old screens may still use it. Resolve does not recommend retired parts, and flags one if it comes up. A check fails when a screen uses one. It also says what to use instead.
- **It knows your team's words (optional).** If your team says "beneficiary" and the library says "Payee picker", you can teach Resolve that those mean the same.
- **It knows the code twin (optional).** Engineers can write a short file, called a **code map**, that says "this Figma Button is this Button in our code". When it is there, Resolve adds the code component to its answer, for example `PayeePicker from '@acme/payments'`. Resolve never guesses a code twin.
- **It shows what is inside a component.** Ask "what is inside the Payee picker?" and Resolve lists the library parts it is built from (for example Avatar and Button), each with its code component when the code map has one. A part with no code link says so. It never guesses one.
- **It writes the developer handoff (optional).** For a finished screen, Resolve writes one sheet: every component on it, its Figma id, its code (React or Angular), the parts inside it, the check result, decisions the team approved, and open questions. It refuses when the screen still uses a retired component.
- **It knows screen recipes (optional).** A recipe is a checklist of the parts a kind of screen usually needs (header, list, main button, input). Resolve fills each slot with a real component.

Resolve keeps everything it learned in a folder on your computer. This folder is called the **store**. Nothing is sent anywhere. Resolve only talks to Figma when you ask it to read a file.

## Set it up

Plan on about ten minutes. You do not type commands: your AI tool does the installing. The steps tell you what to expect, so you can tell it worked.

**Before you start, you need three things:**

1. **Node, version 22.12 or newer.** Node is a free program that runs Resolve in the background. To check, open a terminal (the Terminal app on Mac) and type `node -v`. You should see a number such as `v22.12.0` or higher. If you get an error or a lower number, install the current version from [nodejs.org](https://nodejs.org).
2. **An AI tool**: Claude Code, Cursor or Codex.
3. **A Figma seat that allows AI tools to read your files.** For learning you need a **Dev or Full seat**, a paid seat type. A View or free seat has a small read allowance; Resolve saves its progress and carries on in the next session.

### Step 1. Ask your AI tool to install Resolve

Open your project in Claude Code, Cursor or Codex, and paste this into the chat:

> Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md

The tool reads [`INSTALL-FOR-AI.md`](INSTALL-FOR-AI.md), a checklist written for AI tools, and does the work. In plain words, it will:

1. Run one setup command in your project. That command writes a short instruction file the tool reads every time ("for any Figma task, ask Resolve first"), and a small settings file that tells the tool how to start Resolve. (Different tools call these a **Cursor rule**, a **Claude skill**, and a **project connection**. If you already have such a settings file, Resolve adds itself and keeps everything else in it.)
2. Connect the tool to Figma if that is not done yet. **MCP** (Model Context Protocol) is the plug that lets an AI tool talk to helper programs. Resolve is one helper and Figma has one too.
3. Check that it worked, and tell you what it changed.
4. Ask you before it changes anything in settings that live in your home folder, and never show you or copy any password or token.

**What you should see:** a short report listing the files it created (for example `.cursor/mcp.json`, `.mcp.json`, a Cursor rule and a Claude skill), the commands it ran, and two things only you can do: sign in to Figma, and paste a Figma link (Step 2). For Claude Code, you also say yes the first time it asks about the project's `resolve` server.

Checked on a test machine: every command in `INSTALL-FOR-AI.md` was run exactly as written, for Claude Code and for Cursor, in a scratch project with a scratch home folder (details in the engineer section below). **Not verified:** a real AI tool following the file in a live chat, Codex (not installed here), the Figma sign-in, and the Cursor app screens.

### Step 2. Teach it your library

1. Restart the tool so it sees the new settings (Claude Code: quit and start `claude` again in the project. Cursor: reload the window). Then sign in to Figma when it asks (Claude Code: type `/mcp`, choose figma, log in. Cursor: **Settings → MCP** and sign in).
2. In the chat, write: "Learn my Figma design system from this link: (paste the Figma file link)".
3. The tool reads the file through Figma and hands it to Resolve (behind the scenes it calls a Resolve tool named `learn_library`). Big libraries can take a few minutes. The exact words in the chat differ from tool to tool.
4. **What you should see:** the tool says it has learned the library and roughly how many components it found. To double-check, ask the tool to run the setup check again (`resolve-setup`): `Library learned?` now says `yes`, `Figma connected?` says `yes`, and the last line reads `Next: Ask Resolve for the screen.` (Checked on a test machine with the made-up Acme file and a Figma server in the project settings. The Figma part of this step was not run, because it needs a Figma account.)

Upgrading from an older version of Resolve? Read [Upgrading from the old names](#upgrading-from-the-old-names) first.

<details>
<summary>If you prefer to do it by hand</summary>

These are the same steps, typed by you. Use them if you would rather not let your AI tool run commands.

**Step A. Set up your project (once per project).**

An AI tool forgets things between chats, so it needs a short written instruction that it reads every time: "for any Figma task, ask Resolve first." Different tools call this file different names. In Cursor it is a **Cursor rule**. In Claude it is a **Claude skill**, plus a small note in a file called `CLAUDE.md`. The same command also adds the **project connection**: a small settings file that tells Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`) how to start Resolve. You do not have to create that file yourself. Open a terminal in your project folder and run:

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-setup
```

1. Paste the command and press Enter.
2. **What you should see:** five lines starting with `create` (the Cursor rule, `.cursor/mcp.json`, `.mcp.json`, the Claude skill and `CLAUDE.md`), then a short checklist: `Node ok?`, `Figma connected?`, `Library learned?`, `Rule installed?`, and a last line starting `Next:` that tells you what to do next. At this point `Library learned?` says `no`, and that is fine. `Figma connected?` says `no` until Figma is connected (Step B).
3. It is safe to run again; it only touches its own lines. If you already have a `.cursor/mcp.json` or `.mcp.json`, Resolve adds itself and keeps everything else in it. If such a file is not valid JSON, Resolve leaves it alone and tells you which file to fix. To look first without changing anything, add `--dry-run` at the end.
4. If you only use one of the two tools, the other settings file is harmless; delete it if you like. Resolve never changes settings that live in your home folder (`~/.claude.json`, `~/.cursor`, `~/.codex`); the steps below that touch those are yours to run.

**Step B. Connect Figma and check Resolve.**

**MCP** (Model Context Protocol) is the plug that lets an AI tool talk to helper programs. Resolve is one such helper, and Figma has one too. "Connecting" simply means telling your tool how to start each helper. Step A already did that for Resolve in this project. Pick the tool you use.

**Claude Code**

1. Connect Figma (Claude Code keeps this one in your home folder, so Resolve does not write it for you). Run:

   ```bash
   claude mcp add --transport http figma https://mcp.figma.com/mcp -s user
   ```

   **What you should see:** `Added HTTP MCP server figma ... to user config`.
2. Run `claude mcp get resolve` in your project. **What you should see:** `resolve:` with `Scope: Project config (shared via .mcp.json)` and `Status: ⏸ Pending approval (run `claude` to approve)`. Claude Code asks you to approve a project's settings file the first time. Then run `claude mcp get figma`: it shows the Figma server with its status (it needs a login). Both are expected.
3. Start `claude`. Say yes when it asks about the project's `resolve` server. Then type `/mcp`, choose **figma** and log in to Figma in the browser window that opens. **What you should see:** both servers show as connected.

Checked on a test machine with Claude Code 2.1: the `claude mcp add` line and `claude mcp get` gave the lines above. Not run: the approval question and the Figma login (they need a live Claude session and a Figma account).

**Cursor**

1. Step A already created `.cursor/mcp.json` with the `resolve` server. (The dot at the start of `.cursor` is part of the folder name. Finder on Mac hides such folders; Cmd+Shift+. shows them.)
2. In Cursor, open **Settings → MCP**, add Figma there, and sign in to Figma.
3. Reload the Cursor window. **What you should see:** `resolve` in the MCP list with a green dot, and the `resolve` rule from Step A under **Settings → Rules**.

Checked on a test machine: Step A writes the Cursor rule (`.cursor/rules/resolve.mdc`, set to always apply) and `.cursor/mcp.json`, and the command in that file starts Resolve. **Not verified here:** the Cursor app itself (the screens in steps 2 and 3). More steps: [`docs/CURSOR-RESOLVE.md`](docs/CURSOR-RESOLVE.md).

**Codex**

**Not verified here.** Codex is not installed on the machine used to test this README. The steps follow OpenAI's Codex documentation, which says MCP servers are added with a command or by editing `~/.codex/config.toml`.

1. Run:

   ```bash
   codex mcp add resolve -- npx -y -p github:TANISHQBAFNA/resolve resolve-mcp
   ```

   Or, instead, add this to the file `~/.codex/config.toml`:

   ```toml
   [mcp_servers.resolve]
   command = "npx"
   args = ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"]
   ```

   Codex's documentation also allows a project-level `.codex/config.toml` (trusted projects only) with the same `[mcp_servers.resolve]` lines. Not verified here.

2. Start Codex and type `/mcp`. **What you should see (not verified):** `resolve` in the list.
3. Step A does not write anything for Codex, because Codex reads a file called `AGENTS.md` instead. Copy the short section in [`docs/AGENTS-RESOLVE-SECTION.md`](docs/AGENTS-RESOLVE-SECTION.md) into your project's `AGENTS.md`.

Using the Claude desktop app instead? See [Setup in detail](#setup-in-detail).

**Other ways to connect, by hand.**

**Claude Code, for all projects at once.** Instead of the project file, add Resolve to your home folder settings:

```bash
claude mcp add resolve -s user -- npx -y -p github:TANISHQBAFNA/resolve resolve-mcp
```

**What you should see:** `Added stdio MCP server resolve ... to user config`, and later `claude mcp get resolve` shows `Status: ✔ Connected`.

**Cursor, one project.** Create a folder called `.cursor` in your project's top folder, and inside it a file called `mcp.json` with this inside:

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

If the file already has other servers, add only the `"resolve": { ... }` part next to them.

</details>

## Two asks to try

These use the made-up Acme library. Type them into your AI tool once Step 2 is done.

1. **"Which component should I use for a payee picker on the Send money screen?"** Resolve answers with the Acme "Payee picker": where it lives in Figma, and a real example to copy. If your engineers filed a code map, it also names the code component (`PayeePicker from '@acme/payments'`). Your tool then places that component, instead of drawing one.
2. **"Check the Send money screen."** Resolve answers that the check failed, because the screen uses the retired "Old Button". It says what to use instead (Button) and what the code is (`OldButton from '@acme/ui-legacy'`).

The exact, word-for-word answers for both are shown further down, under [recommend](#recommend) and [verify](#verify).

## Check that Resolve understands your words

Designers do not ask for "Button Primary". They say "payee picker" or "6 digit OTP box". Resolve can test itself on phrases like that.

You give it a list of phrases, and for each one the part you expect. Say Acme's library has a part called "Payee picker". Your list could say:

- "payee picker" should find **Payee picker**.
- "choose a payee" should also find **Payee picker**.
- "6 digit OTP box" should find **nothing**, because Acme has no such part yet.
- "old style button" should never offer the retired **Old Button**.

Then run `npm run resolve -- score phrases`. The first lines are plain English, for example "Resolve tried 118 designer phrases against your library. It put the right part first for 66/88 (75%)." Below that is a table by kind of phrase, so you can see which wording it understands least. A part that is made up, or a retired part that is offered, fails the run.

To test your own library, put a `.json` file of your phrases in the `scoreboard/phrases` folder inside your store (`resolve where` prints the store). You do not need to change the Resolve repo. When that folder has phrases, only your phrases are scored. The 118 built-in phrases are written for the sample library, so they only run on it; on your library with no phrases of your own yet, Resolve says so instead of giving a score. The file format is under [score](#score).

## Questions designers ask

**Does it change my Figma file?** No. Resolve only reads, and only when you ask it to learn a file. Your AI tool does the drawing.

**Do I need a Figma token?** Not when your AI tool is connected to Figma. The tool reads the file and hands it to Resolve. A token (a personal password for Figma's programming interface) is only needed to read a live Figma link from the command line. Never put a token in a file you share.

**What if my library has no component for what I asked?** Resolve says "No master matched" (a master is a component in your library) and returns nothing. Your AI tool should tell you, not make one up.

**What does "weak match" mean?** The words in your ask only partly matched. You get up to three possible parts instead of one confident pick. Look before you place.

**Why did the check say "nothing checked"?** The screen (a *frame*, in Figma's words) had nothing Resolve could match to a library component by its real id, for example a hand-drawn shape or an empty screen. A layer name alone is only a label, so it never counts as a pass.

**Where is my data?** In the store folder on your computer. Nothing is uploaded.

## Words used here

These are explained where they first appear. This list is a reminder, and you do not need it to follow the setup.

- **Library:** the Figma file that holds your design system's components.
- **Master:** one real component in the library (for example "Button"). A button you drew on a screen is an *instance* of a master. A master that has variants (Primary, Secondary) is called a *set*.
- **Node id:** the number Figma gives every layer, such as `30:10`. A master is found by its **file key** (the id in the Figma URL) plus its node id.
- **MCP:** the standard plug that lets an AI tool talk to helper programs. Resolve is one helper; the Figma connector is another.
- **Store:** the folder on your computer where Resolve keeps what it learned (and your team's config files). `resolve where` prints it. You can pin it with the `RESOLVE_HOME` setting (see [Setup in detail](#setup-in-detail)).
- **Ingest** (or **learn**): read a Figma file into the store.
- **Rule file:** a short instruction the AI tool reads every time. A **Cursor rule** is one for Cursor. A **Claude skill** is one for Claude. Both say "ask Resolve first".
- **Seat (Dev or Full):** a type of paid Figma seat that lets AI tools read your files.
- **Retired:** a component the team no longer wants on new screens. Old screens may still use it. See [Retired and old components](#retired-and-old-components).
- **Code twin / code map:** the code component that matches a Figma master, for example `Button from '@acme/ui'`. The code map is the file where engineers list those pairs. The team says which; Resolve never guesses.
- **Card:** a short answer Resolve gives to one question. It is a small block of structured text, kept short so an AI tool can read it quickly.
- **Frame:** a screen (or a section of one) drawn in Figma, for example "Send money".
- **Graph:** the map of your library that learning builds from the Figma file. It is a file in the store (`graph.json`). Every answer comes from it, so Resolve never needs to open Figma to answer.
- **Stub:** an empty placeholder for a component that lives in another Figma file. It has a name but no variants and no details here. Resolve ignores a stub when a real component has the same name.
- **Bind rule:** a human-written rule such as "on the pay step, use this Button".
- **SOCI** (System of Connected Intelligence): the part of Resolve that watches which components pass the check on real screens and *suggests* a rule or recipe. It never applies a suggestion; a person approves or rejects it. **SOCK** (System of Connected Knowledge) is the learned facts about your library that those suggestions come from.

---

## For engineers and testers

Everything below is reference detail: setup options, every command and flag, config files, exact rules, limits, accuracy numbers and version history. You do not need it to use Resolve.

- [Upgrading from the old names](#upgrading-from-the-old-names)
- [Setup in detail](#setup-in-detail)
- [Every command](#every-command)
- [Team config files](#team-config-files)
- [Retired and old components](#retired-and-old-components)
- [Accuracy and honesty rules](#accuracy-and-honesty-rules)
- [Limits: what is not tested yet](#limits-what-is-not-tested-yet)
- [Version history](#version-history)
- [FAQ](#faq)
- [For developers](#for-developers)

### Upgrading from the old names

Older versions used the setting `GRAPHIFY_HOME` and a project folder named `.graphify/`. Both still work: if the new `RESOLVE_HOME` / `.resolve/` exist they win, otherwise the old ones are read. Nothing is moved or deleted for you. To switch, rename the whole old folder to `.resolve/` (for example `mv .graphify .resolve`) and set `RESOLVE_HOME` if you used the old setting. Do not keep both folders. Resolve reads each file from the new folder first. For some files it falls back to the old folder when the new one does not have them: `code-map.json`, `synonyms.json`, `icon-libraries.json`, and the learned library itself. A stale old file of those kinds could keep applying. The other team files (`recipes.json`, `bind-rules.json`, `context-packs.json`, `library-rules.json`) are read only from the folder that holds the learned library, so once `.resolve` has one, the old copies are ignored.

### Setup in detail

The plain steps for Claude Code, Cursor and Codex are near the top of this file. This section adds the options.

**AI install guide.** [`INSTALL-FOR-AI.md`](INSTALL-FOR-AI.md) is the ordered checklist an AI agent follows (Claude Code, Cursor, Codex). It says: run `resolve-setup`, add the Resolve and Figma servers at project scope, verify with `claude mcp get <name>` or `resolve-setup`, ask before touching home-folder settings, never print tokens, report what changed. Its Codex part is not verified.

**Project files (`resolve-setup`).** It writes `.cursor/rules/resolve.mdc`, `.claude/skills/resolve/SKILL.md`, a marked block in `CLAUDE.md`, the six slash commands (`.claude/commands/<name>.md` and `.cursor/commands/<name>.md`), and adds the `resolve` server (`npx -y -p github:TANISHQBAFNA/resolve resolve-mcp`) to `.cursor/mcp.json` and `.mcp.json`. Run it again any time; it only changes its own block and its own server entry. In the two JSON files it keeps every other key and server, keeps your indentation, and leaves the file alone (with a message) if it is not valid JSON or does not have the usual `mcpServers` object. A different existing `resolve` entry (for example one that points at a local build) is also left alone. `--dry-run` shows what it would do. `--global` writes to `~/.claude` instead (Claude only), writes no MCP file, and does nothing until you add `--yes`. `--force` replaces a file that has no Resolve markers, and replaces only the `resolve` entry in an MCP file. It never writes `~/.claude.json`, `~/.cursor` or `~/.codex`.

**Slash commands, update and uninstall.** Every file Resolve writes (the rule, the skill, each command) carries `<!-- resolve-setup:begin -->` and `<!-- resolve-setup:end -->` around Resolve's text. That marker is how Resolve knows a file is its own. Running setup again rewrites only the text between the markers (anything you add outside them stays), and leaves a file byte-identical when nothing changed. A command file that has no markers, for example your own `.claude/commands/find.md`, is kept as it is: setup prints `skip ... (kept your own file ...)` and carries on; `--force` replaces it. `CLAUDE.md` is handled the same way, using the same markers around one short block. `--uninstall` removes only Resolve's marked blocks, then a file that has nothing else in it, and the `resolve` entry of `.mcp.json` / `.cursor/mcp.json` when it is exactly the one setup wrote (other servers stay). Files without markers are never touched. `--uninstall --dry-run` lists what it would do; with `--global` it needs `--yes`. Claude Code commands go in the project (`.claude/commands`), next to the project's `.mcp.json` and skill, so they are shared with the team and removed with the project; `--global` puts them in `~/.claude/commands` instead. A command is not a skill: a command runs only when you type it, a skill can be picked by the AI tool on its own. Over MCP the same six commands are prompts (`prompts/list`, `prompts/get`, argument `input`); prompts are not tools, so the tool count does not change. A command that runs the command line (`/parts`, `/handoff`, `/resolve-status`) calls `npx -y -p github:TANISHQBAFNA/resolve resolve-figma ...` in your project folder, so it reads the same store as Resolve's MCP server. It reads `~/.claude.json` read-only, only to see whether a Figma server is listed (for `Figma connected?`); it never prints that file.

**Claude Desktop.** Add Figma under **Settings → Connectors**. Then open **Settings → Developer → Edit Config** and add Resolve:

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

Quit Claude Desktop with Cmd+Q (not the window close button) and reopen. If Claude Desktop cannot start Resolve, use the full path from `which npx` as `command`. Claude Desktop does not read rule files, skills or `CLAUDE.md`; it only gets the short MCP instructions.

**Learning from the command line.** Learning through the AI tool needs a Dev or Full Figma seat. For command-line ingest you can use a Figma access token instead:

```bash
export FIGMA_ACCESS_TOKEN=...   # your own token; never commit it
npm run resolve -- ingest 'https://www.figma.com/design/ACMEUI/Acme-UI' --role library
```

The first file you ingest is the library by default. Later files default to `product`. Full details: [`docs/SETUP-MCP.md`](docs/SETUP-MCP.md).

**Where the data lives.** In a store folder: `RESOLVE_HOME` if you set it, otherwise the nearest `.resolve/` folder going up from where you run. (For older setups see [Upgrading from the old names](#upgrading-from-the-old-names).) The AI tool's MCP server and your command line must use the same folder. `resolve where` prints it.

### Every command

In a checkout of this repo, run commands as `npm run resolve -- <command>`. The installed package exposes the same command line as `resolve-figma`. The examples use a pretend Acme library with a "Button" set, a "Text field" set, "Payee picker", "Avatar", "Payment method row", and a retired "Old Button", plus screens such as "Send money". To follow along, use the made-up library in this repo, [`docs/examples/acme-ui.json`](docs/examples/acme-ui.json). Its "Send money" screen (a frame) holds one Payee picker, one Button and one Old Button, which is retired (its description says `status: deprecated` and `replacedBy: Button`):

```bash
export RESOLVE_HOME=$(mktemp -d)        # a throwaway store
npm run resolve -- ingest docs/examples/acme-ui.json --role library --file-key ACMEUI --name "Acme UI"
```

Then put the code map shown in [`code-map.json`](#resolvecode-mapjson--figma-to-code-twins) below into `$RESOLVE_HOME/code-map.json`. The code map and output shown are real output from that made-up library (a few long fields are cut, and it says so).

| Command | What it does |
| --- | --- |
| `ingest <file.json \| file.xml \| figma-url \| file-key>` | Reads a Figma file and adds it to the workspace. |
| `learn --file-key <key>` | Same as the MCP `learn_library` tool: load a file from Figma `get_metadata` XML. |
| `recipe [list \| "<name>"]` | Screen packs: the list of components a screen of that kind usually needs. |
| `recommend "<intent>"` | Ranked library components for a plain-words ask. |
| `example "<name>"` | The real, filled-in instance behind a pick, to copy. |
| `resolve "<name>"` | "I know the name, give me the id." |
| `verify "<frame>"` | Pass/fail check of a drawn frame or a list of components. |
| `ingredients "<name>"` | What is inside a component: its parts, each with its code component or "no code link yet". |
| `handoff "<frame>"` | One sheet a developer can build a screen from: recipe slots, every placed component with its Figma id and code, the parts inside, verify, decisions and open questions. Refuses a screen with a retired component, or with layer-name guesses or missing components unless `--draft`. |
| `code-map [--json \| --retired]` | Report on your Figma-to-code map; `--retired` lists retired parts with their code and replacement. `--init` writes a spreadsheet (CSV) to fill in; `--import <file.csv>` turns it into the map (`--force` keeps entries the CSV has no row for, `--replace` drops them). |
| `rules` | Lists the bind rules people wrote. |
| `soci` | Lists pending SOCI proposals (suggested rules and recipes). |
| `approve <id> --who <name>` / `reject <id> --who <name>` | A person says yes or no to a proposal. |
| `cousins "<frame>"` | Finds look-alike copies of library parts in product files. Needs a frame name, or `--components a,b`. |
| `workspace` | Linked files and store location. |
| `orient`, `query`, `path`, `explain`, `check` | Optional exploration of the stored graph. |
| `list`, `reindex`, `rm --yes`, `where` | Look after the store. |
| `score` | Accuracy check against a golden set. |

#### ingest

```bash
npm run resolve -- ingest acme-ui.json --role library --file-key ACMEUI --name "Acme UI"
```

Takes a REST JSON body, an MCP capture, a graph, raw `get_metadata` XML, a Figma URL, or a file key. XML needs `--from-metadata` **and** `--file-key` (the id in the Figma URL): `npm run resolve -- ingest acme-ui.xml --from-metadata --file-key ACMEUI --name "Acme UI" --role library`. A URL with a `node-id` reads just that node. `--scope file` reads the whole file in one request (safer on a low Figma tier). Changing the `--role` of a file already in the workspace is refused unless you add `--force-role`. Roles: `library`, `product`, `client`.

#### learn

```bash
npm run resolve -- learn --file-key ACMEUI --from-metadata acme-ui.xml --design-context acme-ui-context.txt
```

Same as `learn_library` in the MCP server. Pass the design context too, so each component's default text is stored (this lets `verify` spot leftover template text).

#### recipe

```bash
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
```

A recipe is a list of slots (header, line list, primary action, input). Each slot is filled with a real component from your library, or is marked `unbound` or `missing`, with the next `recommend` to run. It never invents an id. Your own recipes go in `.resolve/recipes.json` and win over the built-in ones. See [`docs/RECIPES.md`](docs/RECIPES.md).

#### recommend

```bash
npm run resolve -- recommend "payee picker"
```

```json
{
  "intent": "payee picker",
  "candidates": [
    {
      "id": "node:30:30",
      "name": "Payee picker",
      "type": "MAIN_COMPONENT",
      "nodeId": "30:30",
      "figmaNodeId": "30:30",
      "fileKey": "ACMEUI",
      "componentKey": "payee-picker-key",
      "published": true,
      "publishState": "published",
      "deprecated": false,
      "instances": 4,
      "whereUsed": [],
      "score": 1000000038,
      "why": "used 4× in file",
      "hint": "Place fileKey + nodeId.",
      "ex": "20:31"
    }
  ],
  "truncated": false,
  "hint": "Place fileKey+nodeId. If stale, learn_library. Do not Read graph.json.",
  "code": "PayeePicker from '@acme/payments'",
  "cost": {
    "chars": 520,
    "approxTokens": 130
  }
}
```

The name or words in the ask come first (exact name, word match, synonym). Screen and usage only break ties. The card is at most 600 characters (the `cost.chars` figure is the card without the `cost` field itself). The `code` line appears only when your team filed a code map, the top pick is mapped, it is a good match and not retired, and the line fits in 600 characters without dropping a candidate; otherwise it is left out without a message. Nothing matches? You get an empty list and "No master matched. Do not invent." (When a code map exists and the only match is retired, the hint says `Only match is retired: <Name>. Use <replacement or none>.` instead.) A loose match carries "Weak match." and up to three parts instead of one confident guess. Options: `--budget <chars>`, `--pack`, `--product`, `--journey`, `--domain`, `--screen-type`.

#### example

```bash
npm run resolve -- example "Payee picker"
```

Returns the real instance (file key, node id, screen, variant, size) so the AI tool can clone it and replace the content, instead of starting from the bare default. If no real example is known, it says so.

#### resolve

```bash
npm run resolve -- resolve "Text field"
```

Use this when you already know the name. An exact master always comes back with `id`, `fileKey` and `figmaNodeId`, even if it is used nowhere. Retired names come back flagged `deprecated: true` with the live replacement. Private parts (names starting with `_` or `.`) come back only on an exact name. A miss says so and points at `recommend`. If a code map covers a current part, its `code` line is added when it fits.

#### verify

```bash
npm run resolve -- verify "Send money"
npm run resolve -- verify "Send money" --components Button,Gold
```

Checks a frame, or a list of component names/ids, after drawing. `pass` is true only when at least one placed piece was checked by its own component id or key and nothing failed. It reports `invents` (not in the library), `deprecated` (retired parts), `unresolved` (with a "did you mean"), bind-rule misses, lorem-ipsum filler, and leftover template text. Matching by layer name alone is labelled `name-only` and is not a pass. With `--components Button,Gold`, "Gold" is reported as an invent because there is no such component. A failed check exits non-zero.

Card size: a check that finds a problem aims for 600 characters (the largest in the repo's test set is 559). A check that passes many components, or a frame with many warnings, can be longer (about 760 characters for five components). That is how it behaved before the code map and it has not changed.

Retired parts used in the frame: **a retired part fails the check**, whether the library marks it retired or your code map does. With a code map, the card also shows, for each retired part (up to three, then `+N more`), what it maps to and what to use instead. In the Acme library the "Send money" frame (see [Every command](#every-command) for how to load it) holds a Payee picker, a Button and the retired "Old Button". Real output:

```json
{
  "pass": false,
  "approved": 2,
  "resolved": [],
  "invents": [],
  "deprecated": [
    {
      "name": "Old Button",
      "id": "node:30:50",
      "figmaNodeId": "30:50",
      "fileKey": "ACMEUI",
      "status": "deprecated"
    }
  ],
  "unresolved": [],
  "frame": {
    "id": "node:20:40",
    "name": "Send money",
    "type": "FRAME",
    "figmaNodeId": "20:40",
    "fileKey": "ACMEUI"
  },
  "hint": "Fail — invents/deprecated/unresolved listed. Replace invents with recommend() figmaNodeIds. If stale, learn_library. Do not Read graph.json.",
  "textChecked": "n/a",
  "retired": [
    "retired Old Button -> use Button (old code: OldButton from '@acme/ui-legacy')"
  ],
  "cost": {
    "chars": 550,
    "approxTokens": 138
  }
}
```

A retired part is never left out of the answer. If the card is crowded, Resolve first removes lower-value text (the timestamp, the renamed-layers list, look-alike names, warnings, detail on the frame, then everything in the hint after its first sentence, then detail on the failing parts), and shows at most three retired lines then `+N more, run \`resolve code-map --retired\` for the list`. The reason for the failure always stays. If even one line does not fit, the card says `+N retired, run \`resolve code-map --retired\` for the list`. That short pointer is the floor: it is always there. A card with very many failures (for example about 17 invented names) is longer than 600 characters whatever the retired part does; that is how `verify` already behaved before the code map, and the pointer is added to it unchanged. With no code map, none of this happens and the card is exactly what it was before.

Pass `--design-context <file>` (Figma `get_design_context` for the frame) so Resolve can read real text, and `--texts '<json>'` (the JSON itself, for example `'{"1:3":"Pay now"}'`, not a file name) to fill empty layers.

#### code-map

```bash
npm run resolve -- code-map
npm run resolve -- code-map --retired
```

```
Code map: 6 components: 2 mapped, 1 retired (kept mapped), 3 unmapped, 0 ambiguous, 0 conflict. 0 stale, 0 ignored entries.
Unmapped: Text field [ACMEUI 30:20]; Avatar [ACMEUI 30:40]; Payment method row [ACMEUI 30:60]
Retired: Old Button [ACMEUI 30:50] -> use Button (old code: OldButton from '@acme/ui-legacy')
```

**Fill the map from a spreadsheet.** Hand-editing JSON is not needed:

```bash
npm run resolve -- code-map --init                       # writes code-map.csv next to code-map.json
npm run resolve -- code-map --import code-map.csv --dry-run   # shows the JSON it would write
npm run resolve -- code-map --import code-map.csv        # writes code-map.json
npm run resolve -- code-map --import code-map.csv --force   # updates an existing code-map.json
```

`--init` writes one row per library component (`fileKey`, `id`, `name`, then the columns to fill: `component`, `importPath`, `framework`, `selector`, `module`, `standalone`, `inputs`, `outputs`, `status`, `replacedBy`). Rows the map already knows come filled in. `--import` skips rows with no `component` and no `importPath`, checks every other row with the same rules as the map itself, and writes nothing if any row is wrong. It lists them by spreadsheet row, counting blank rows, for example `row 5: importPath must be a package path like @acme/ui`. Columns Resolve does not use (`notes`, `owner`, ...) are ignored, and the output names them. List several `inputs` or `outputs` with spaces or commas; Angular's `label: ariaLabel` form is kept as one input. A filled-in example is [`docs/examples/acme-code-map-angular.csv`](docs/examples/acme-code-map-angular.csv). `--init` does not replace an existing CSV unless you add `--force`.

**Updating an existing map.** `--import` does not touch an existing `code-map.json` unless you say how:

- `--force` updates it and keeps every entry the CSV has no row for (entries for another file, hand-added or stale entries), and lists them: `Kept 2 existing entries the CSV has no row for (use --replace to drop them): OTHERLIB 1:1, ...`. This is the safer choice, so nothing is lost without a word.
- `--replace` writes only the CSV's entries, and lists what it dropped.
- Either way, a filled row replaces the old entry for that component, and a row you emptied removes it. Both are listed (`Replaced ...`, `Removed ...`), so every old entry that is not written back as it was is named. `--dry-run` shows the JSON `--force` would write.
- A row and an old entry are the same component when they have the same file key and id. An old entry with no id matches a row of the same name in the same file; an entry with no file key and no id (name only) matches a row of that name in any file. An entry for another file, or with a different id, is never matched by name alone, even when the names agree.
- A header that names a column twice (`component` twice), or an unnamed column that holds values, is refused. Unknown `code-map` options are refused too.

`--retired` prints every retired part with its code and replacement, one per line (`Retired: 1`, then `Old Button [ACMEUI 30:50] -> use Button (old code: OldButton from '@acme/ui-legacy')`). `--json` prints the same data with the same keys whether or not there is a map (`configured` is `true` or `false`; the lists are `unmapped`, `ambiguous`, `conflicts`, `retired`, `stale`, `replacements`, `ignored`). Two keys appear only with Angular entries: `angular` (counts) and `angularIgnored` (entries whose Angular fields were dropped). A part with a bad `replacedBy` is listed under `Bad replacedBy` / `replacements`. Details are in [`code-map.json`](#resolvecode-mapjson--figma-to-code-twins) below. With no map, it prints `No code map. Add .resolve/code-map.json next to synonyms.json.`

#### ingredients

```bash
npm run resolve -- ingredients "Payee picker"
npm run resolve -- ingredients "Button" --variant "Variant=Danger"
npm run resolve -- ingredients --all
```

```
Payee picker [ACMEUI 30:30]
Code: PayeePicker from '@acme/payments'
Inside it:
  - Avatar [30:40] (code: no code link yet)
  - Button / Variant=Primary, Size=Medium [30:11] (code: Button from '@acme/ui')
Payee picker is built from 2 parts. 1 linked to code, 1 with no code link yet.
```

It lists the library parts placed directly inside a component (a part inside a part is shown with `--depth 2` or `3`). It reads the links the graph already has, so nothing is guessed:

- **Variants.** Each variant can hold different parts. Resolve follows the variant you name with `--variant` (properties like `"Size=Medium"`, or the variant's name). Otherwise it uses the first variant in the set and names the other variants that use a different set of parts. Give it the id of a copy placed on a screen (`fileKey:nodeId`) and it reads that copy's own parts at every level it shows, so a swap made on the screen shows. Where a copy's insides were not learned, it shows the main component's parts and marks them `from the main component, not checked on this screen`. Two copies of one part that hold different insides get a line each (`insides differ between copies`), so the counts always match what is listed. `--variant` is refused for a placed copy, because the copy already uses one variant.
- **Code.** Each part shows its code component from your code map, or `no code link yet`. With no code map at all, it says so. The header shows the file key and node id (`[ACMEUI 30:30]`). For an Angular map entry the part also shows its selector and module (`<acme-button>, AcmeButtonModule`), and the header adds an `Angular:` line with inputs and outputs (see [Angular entries](#angular-entries)).
- **Swaps inside a component.** A component's own card reads the copies placed inside it too, so a swap made inside the component (for example a different icon in each of five buttons) shows as it really is. When copies of one part differ, each kind gets its own line marked `1 of 5 copies` (and so on) and `insides differ between copies`; at the last level shown the line names what that copy holds. Where the copy inside a component has no learned insides, its parts come from its main component and say `from the main component, not checked on the copy inside this component`.
- **Honest labels.** A retired part shows its old code and what to use instead, with that part's code when the map has it (`retired, code: OldButton from '@acme/ui-legacy'; use Button (code: Button from '@acme/ui')`). A part known only from its layer name is marked `guess from layer name, not confirmed`. A part from a library file you have not learned says so; if you have learned that library, Resolve finds the real part by its published component key. A copy whose component is missing is `component not found`.
- **Names.** Exact name (letter case ignored) or id only. Anything else says "Nothing named ..." and exits with an error; use `recommend` to find the name first. A name or a bare node id found in two learned files is listed, not picked; ask again with `fileKey:nodeId`.

`--json` prints the card as data (`parts`, each with `status`: `current`, `retired`, `unconfirmed`, `other-library` or `not-found`, `code` or `null`, and `use` / `useCode` for a retired part; `angular` for an Angular entry; `insideFrom` marks insides read from the main component). `--all` counts the whole library: how many components are built from other parts, and how many of those parts link to code. The MCP version is `get_ingredients`. It is off by default, so the agent tool list stays at seven; set `RESOLVE_MCP_ADVANCED=1` to turn it on. Over MCP a card larger than 12,000 characters is cut so it does not flood the agent: it is shown one level less deep at a time, then with fewer parts per level, and `cut.reason` says what was left out (ask a part by name for its own card). The command line always prints the whole card.

#### handoff

```bash
npm run resolve -- handoff "Send money"
npm run resolve -- handoff "Send money" "Confirm payment" --out artifacts/acme-142/handoff
npm run resolve -- handoff "Home" --draft
```

One sheet a developer can build a designed screen from. For each screen it lists:

- **The screen**: file key, frame id and a Figma link.
- **The recipe and its slots**: each slot's component and one of three states. `placed`: a copy of that component is placed on the screen, or is a direct child of a screen that is one placed copy. `inside <Component>`: it is only a part of a placed component, for example `inside section-header`. `missing`: neither. One placed copy fills at most one slot (two slots that want a Button need two Buttons; a second slot with no copy left says `missing (its placed copy fills primary-cta)`). A line below the table counts them: `3/3 slots covered (0 placed, 3 inside another component)`; `placed` and `inside` both count as covered. Only `missing` raises an open question; an `inside` slot asks you to check the part is meant to fill that slot. In the JSON each slot has `state`, `insideOf` and `sharedWith`, and `onScreen` is true only for `placed`; the recipe has `coverage`. The recipe is used when its id, title or alias is exactly the screen's name, or when you pick it with `--recipe <id>`. A looser name match is only named ("the closest by name is ..."), not checked.
- **Every component placed on the screen**, once per variant, with how many copies and their ids (the first 10, then `+N more`). Each one shows:
  - its code from the code map: the React import, or the Angular selector, module or standalone, inputs and outputs. A component with no map entry says `unmapped`; code is never guessed.
  - the Figma variant properties. When the Angular entry has an input of the same name, it suggests the value (`Variant=Secondary` becomes `variant="secondary"`) and a one-line template. If the selector pins that attribute to another value (`acme-button[variant="primary"]` on a Secondary copy), no value is written for it and an open question says "the selector only matches variant="primary"; this copy is Secondary". For example for example `<acme-button variant="secondary" size="medium" [disabled]="…" (pressed)="…"></acme-button>`. An input paired with an `...Change` output is shown as `[(selected)]`. Both are labelled "suggested".
  - the other variants in Figma (states to build), leaving out the placed one. In the JSON this list is the field `states`: it holds the OTHER values, not the placed one (the name is kept so nothing breaks).
  - the parts inside it, up to 3 levels (`--depth`), each with its code.
- **Ingredients**: every part once, with its code, its status (`mapped`, `unmapped`, `retired`, `name-guess`, `other-library`, `not-found`) and which components use it.
- **Verify**: the same check as `verify`.
- **Decisions**: approved SOCI decisions about this screen, its recipe or the components placed on it, with who, when (with its time zone, for example `2026-02-03 10:00 UTC`) and why (from the approval audit line). It says "None approved for this screen yet" until the first approval.
- **Open questions**: unmapped components and parts, components and parts from libraries you have not learned, required recipe slots that are not on the screen, and anything verify flagged.

A component from a library file you have not learned is `status: "other-library"`: it has no Figma id of this file and its code is unknown, so the sheet says to learn that library rather than to map it. It does not block the handoff. In the JSON its `code` is `"unknown"` (as is a `not-found` one in a draft), not `"unmapped"`, and `summary.unmapped` does not count it.

Three gates keep a handoff honest:

- **A retired component anywhere on the screen refuses it**, and names the replacement and its code. This includes a retired part inside the main component of a copy whose own insides were not learned (`Retired component Old Button is inside Payee picker [ACMEUI 30:30] (read from its main component ...)`). `--draft` does not skip this.
- **A component known only from its layer name refuses it**: `MCP metadata insufficient for component X. Use Figma REST or design_context.`
- **A copy whose component is in no learned file refuses it** (kind `not-found`): `The component of Legacy badge (copy ACMEUI 20:36) is not in the learned library ...`, with the fix: learn the library file that holds it, or replace the copy. This includes a part like that inside a library component's definition (read from its main component), the same as a retired part there.

For the last two, `--draft` (MCP `allowWeak: true`) makes a draft instead. A draft says `draft: true`, marks those components `identity: "name-guess"` or `identity: "not-found"`, and opens with "Draft, not for build".

A refused handoff writes nothing and exits with an error. On the Acme sample, `handoff "Send money"` is refused because of the retired Old Button. With that copy swapped for Button, it exports cleanly; the golden output is in [`tests/fixtures/handoff/send-money.md`](tests/fixtures/handoff/send-money.md).

Without `--out` it prints the sheet (`--json` prints the data). `--out <dir>` writes `handoff.md` (an index), one `screen-<name>.md` per screen, `ingredients.md` (every part across the screens) and `handoff.json`. If the folder already holds any of these files it refuses unless you add `--force`; with `--force`, older `screen-*.md` files from an earlier handoff there are removed (and listed). Other files in the folder are left alone. A path that is a file, or a folder you cannot write to, gives a one-line error. A screen found by a loose name match (not its exact name or id) says so at the top. Names from Figma are escaped in the markdown, so a name cannot add links or HTML.

A screen that is one placed copy (for example a page shell shared as the screen) is its own single component, with everything on it listed as its parts. The MCP version is `get_handoff`; like `get_ingredients` it is off by default (`RESOLVE_MCP_ADVANCED=1`). Over MCP a handoff larger than 40,000 characters lists its parts one level less deep at a time until it fits; the open questions and the summary still come from the full sheet, and `cut` says how many parts are listed (`35 of 62 parts are listed`). A `depth` that is not 1, 2 or 3 is clamped, and `depthNote` says so.

#### rules, soci, approve, reject

```bash
npm run resolve -- rules
npm run resolve -- soci
npm run resolve -- approve <proposal-id> --who "Priya"
npm run resolve -- reject <proposal-id> --who "Priya"
```

`rules` lists human-written bind rules (must use / must not use / prefer; see [`docs/BIND-RULES.md`](docs/BIND-RULES.md)). `soci` lists suggestions made from real use. Nothing is ever applied automatically. `approve` and `reject` record who decided (see [`docs/SOCI.md`](docs/SOCI.md)).

#### cousins

```bash
npm run resolve -- cousins "Send money"
npm run resolve -- cousins --components Button,Avatar
```

A "cousin" is a product file's own copy of a library part, such as a hand-built "Price" next to the library's "Price". Needs a frame name or `--components a,b` (with neither it prints a usage line and exits with an error), and a library-role file in the workspace. When unsure it says so.

#### status, workspace, where, list, reindex, rm

```bash
npm run resolve -- status       # learned files, when each was last learned, code-map coverage (--json for data)
npm run resolve -- workspace    # linked files and store path
npm run resolve -- where        # store path, graph.json, builtAt
npm run resolve -- list         # what is stored
npm run resolve -- reindex      # checks graph.json loads
npm run resolve -- rm --yes     # deletes the learned graph (asks you to confirm first)
```

#### orient, query, path, explain, check

```bash
npm run resolve -- orient
npm run resolve -- query "payee"
npm run resolve -- path "Button" "Send money"
npm run resolve -- explain "Button"
npm run resolve -- check "button"
```

Optional. They look around the stored graph: a summary, a small related set, the shortest relationship between two things, a short brief on one node, and a variant to use plus retired ones to avoid. Agents should prefer `recommend` and `resolve`.

#### score

```bash
export RESOLVE_HOME=$(mktemp -d)        # a scratch store, so your real one is untouched
npm run resolve -- ingest scoreboard/fixture/library.json --role library --name "Scoreboard fixture"
npm run resolve -- score --golden scoreboard/golden --workspace fixture
```

Runs a set of asks with known right answers through `recommend`, `resolve`, `recipe` and `verify` and prints a table. It scores the library that is in the store, so ingest the sample library first (as above); on an empty store, or on a library without the parts the set asks for, it stops with an error. `--workspace <name>` is only the name the run is saved under (`RESOLVE_HOME/scoreboard`). It exits non-zero if anything was invented or a card is over its size. `npm run resolve -- score --init` writes a starter set from the library you already learned. See [`docs/SCOREBOARD.md`](docs/SCOREBOARD.md).

`npm run resolve -- score phrases [--phrases <path>] [--json]` scores designer-worded phrases against `recommend`. It reads the team's own `<store>/scoreboard/phrases/*.json` when there are any. Otherwise it reads the built-in `scoreboard/phrases/*.json` in the checkout, but only when the store holds the sample library (`scoreboard/fixture`); on any other library it stops and asks for team phrases. The two sets are never added together. `--phrases` reads only that path. `score phrase` and `score Phrases` work too; any other word after `score` is an error. Each phrase has an `id`, a `phrase`, a `type` and an `expect`: part names, `"none"`, or `"weak"` (empty, or a pick named in `accept`). It reports top-1, top-3, correct-empty, false-empty, wrong-cousin, retired-recommended and invent, per type. It exits non-zero on any invent or retired-recommended. A phrase naming a part the library lacks is skipped and listed, and a run where nothing could be scored fails. Details in [`docs/SCOREBOARD.md`](docs/SCOREBOARD.md#designer-phrase-set).

#### The seven MCP tools

The same abilities are offered to AI tools as seven MCP tools: `learn_library`, `recommend`, `check_cousins`, `resolve`, `get_example`, `verify_frame` and `recipe`. They return the same cards as the command line. Two more tools, `get_ingredients` (see [ingredients](#ingredients)) and `get_handoff` (see [handoff](#handoff)), are off by default. The six [slash commands](#slash-commands) are also offered as MCP prompts (`prompts/list`, `prompts/get`); prompts are not tools and do not change the count.

### Team config files

Each team keeps its own files in its store folder (`RESOLVE_HOME`, or the nearest `.resolve/`). Missing files mean "use the defaults". Files are read on every ask, so an edit applies on the next ask with no rebuild. Never put your company or design-system name in this repository; keep it in your own store.

#### `.resolve/synonyms.json` — your team's words

**Owner:** the design system team (whoever knows how people on the team talk).

Shape: a list of `groups`, each with `terms` (two or more words that mean the same) and an optional `reason`.

```json
{
  "groups": [
    { "terms": ["beneficiary", "payee"], "reason": "Acme says beneficiary for payee" }
  ]
}
```

Before this file, `recommend "beneficiary"` returns nothing. After it, it returns Payee picker. A broken file changes nothing. Words that are one word long are matched alone; built-in groups cover common words such as button/cta, search/find and price/amount.

#### `.resolve/icon-libraries.json` — icon-only libraries

**Owner:** the design system team.

Lists Figma libraries that hold only icons, so icons never outrank a real control for a generic ask. Each entry matches a **file name, file key, or page name** (case-insensitive). An entry is a string or `{ "name" | "fileKey" | "page": ... }`.

```json
{
  "libraries": ["Acme Icons", { "fileKey": "ICONS01" }, { "page": "Acme Icons Page" }]
}
```

Icons come back when the ask is for an icon, or when you give the icon's exact distinctive name. An entry that matches nothing prints one line on stderr (once per run, never inside a card), including when the remote lookup failed. A file that is not valid JSON is ignored and prints `icon-libraries.json is malformed; ignored`. An entry that matches your main library is ignored, with a message, because it would hide real components. With no file, Resolve falls back to a name guess (`word-NNN-word`, or a name that starts or ends with icon/glyph/symbol). Remote icon masters (published in another Figma file) are matched through a lookup that needs `FIGMA_ACCESS_TOKEN`; if that lookup fails, ingest still succeeds. Repeated 503 or 429 responses on that lookup stop after a short budget instead of retrying for minutes. The main file fetch is unchanged.

#### `.resolve/code-map.json` — Figma-to-code twins

**Owner:** the engineers who own the code components. Resolve never guesses this file. It only writes it when you run `code-map --import` on a CSV you filled in.

It says "this Figma component is this code component". Shape:

```json
{
  "entries": [
    {
      "fileKey": "ACMEUI",
      "id": "30:10",
      "code": { "import": "import { Button } from '@acme/ui'", "component": "Button" }
    },
    {
      "fileKey": "ACMEUI",
      "name": "Payee picker",
      "code": { "import": "import { PayeePicker } from '@acme/payments'", "component": "PayeePicker" }
    },
    {
      "fileKey": "ACMEUI",
      "id": "30:50",
      "status": "retired",
      "replacedBy": "Button",
      "code": { "import": "import { OldButton } from '@acme/ui-legacy'", "component": "OldButton" }
    }
  ]
}
```

The rules, in plain words:

- **Which component.** `fileKey` plus `id` (the exact Figma node id) is the key. A whole-id match is required: `1:1` never matches `11:1`. `name` works instead only when that name is unique in the file, and the letters must match exactly. Two components with the same name are `ambiguous` and get no code line, whatever order the file lists them in. An explicit `id` entry for one of them still works.
- **Variants.** A variant (for example `Button / Primary`) uses the code twin of its set.
- **`code`.** `component` must be a plain name like `Button`. `import` must end with `from '<module>'`. Anything else is ignored with a reason (Resolve rejects a bad value rather than quietly changing it).
- **`status`** is `current` or `retired`. If you leave it out, Resolve uses the library's own flag (see the next section). `replacedBy` is optional: the Figma name or id of the part to use instead. It must be a current component or set in the library. A variant (for example `size=small`) or a stub (an empty placeholder from another file) is refused, and `code-map` says so under `Bad replacedBy` (`replacedBy is a variant`, `replacedBy is a remote stub`). If a real set and a stub share the name, the real set is used. If that part is itself retired, Resolve follows its `replacedBy` (at most 3 steps, never in a circle) to a current part. If it finds none (unknown name, a variant or stub, two real parts with that name, the part itself, a circle, or a chain that is too long) it says "no current replacement" and `code-map` lists the entry under `Bad replacedBy`. Resolve never points at a retired part.
- **Two entries for one component** are not settled by file order. If one says current and the other says retired, the current one wins, and the clash is still reported: the part is listed under `conflicts` ("retired and current entries; the current one is used") and one line is printed on stderr (once per run). If both say the same thing, they merge. If they disagree otherwise, the component is a `conflict` and shows no code line.
- **Unknown fields.** Any field that is not in the shape above makes that entry ignored, with the reason shown (for example `unsupported field 'key'`). `props`, `source` and `key` are not supported. A top-level `namingRule` ("auto-map a PascalCase name") is planned and not built yet; it is ignored and reported as such.
- **A missing, empty, or byte-order-mark-only file** is simply "no map", with no message. A file that is not valid JSON prints one line on stderr (`code-map.json is malformed; ignored`).
- **A file with nothing usable** says `code-map.json has no usable entries.` and lists why each entry was ignored.
- **Where the code line shows.** It is added to the `recommend` card (for the top pick only), the `resolve` card, and the MCP versions of both, only if it fits inside the card limit without dropping a candidate. When it does not fit it is left out without a message (the part is still counted as mapped in `code-map`). It is never added to a weak match, and never to a retired part. A part that lives in another Figma file (a remote stub, for example a published icon) cannot be mapped here; map it in the file where it lives. The code line is cleaned of control characters, so a bad file cannot sneak text into an agent's prompt. Without a map, every card is byte-for-byte what it was before.

##### Angular entries

An entry can describe an Angular component. Add `framework`, `selector` and, if you know them, `module` or `standalone`, `inputs` and `outputs` inside `code`. Entries without these fields (like the ones above) work exactly as before, and one file can mix both kinds. A made-up Acme example with an Angular package, [`docs/examples/acme-code-map-angular.json`](docs/examples/acme-code-map-angular.json):

```json
{
  "fileKey": "ACMEUI",
  "id": "30:10",
  "code": {
    "framework": "angular",
    "import": "import { AcmeButtonComponent } from '@acme/ui-angular'",
    "component": "AcmeButtonComponent",
    "selector": "acme-button",
    "module": "AcmeButtonModule",
    "inputs": ["variant", "size", "disabled"],
    "outputs": ["pressed"]
  }
}
```

- **`selector`** is required for an Angular entry. Real Angular forms work: an element name with a dash (`acme-button`), an attribute (`[acmeTooltip]`), an attribute with a value (`[type="submit"]`), a class (`.acme-card`), combinations (`button[mat-button]`, `input[acmeField]:not([readonly])`) and comma lists (`button[mat-button], a[mat-button]`). An element name alone needs a dash. A selector alone marks the entry as Angular; `"framework": "angular"` says it outright.
- **`module`** is the NgModule to import (`AcmeButtonModule`). For a standalone component, use `"standalone": true` instead. Giving both is refused.
- **`inputs`** and **`outputs`** are optional lists of names (`["variant", "size"]`). Angular's alias form `"label: ariaLabel"` is accepted; the alias is what a template binds to. A name listed twice is kept once.
- **The import path** comes from the `import` line (`@acme/ui-angular`), as before.
- A bad Angular value drops only the Angular fields of that entry, never its code line. The reason is listed under `Angular fields ignored (code line still used)` in `code-map` (`angularIgnored` in JSON), for example `selector must look like acme-button, [acmeTooltip] or button[mat-button], a[mat-button]`, `use module or standalone: true, not both`, `'module' needs an Angular selector`, or `'selector' is an Angular field; set framework to angular` (on a `"framework": "react"` entry). Nothing is quietly changed. The CSV import is stricter: a bad Angular value there is a row error, so it gets fixed before the map is written.
- One component, one entry: a React and an Angular entry for the same component are a `conflict` ("a React and an Angular entry disagree; keep one entry per component"). The exception is the usual retired rule: if one of the two is retired and the other current, the current one is used.

Where the Angular fields show: the ingredient card (text and `angular` in JSON, also `useAngular` for a retired part's replacement), the `resolve` card (`angular`, next to `code`), the `recommend` card (a short `angular` line such as `<acme-button>, AcmeButtonModule`, only when it fits in 600 characters), the `verify` retired lines, `code-map` (an `Angular:` count line such as `Angular: 4 components have a selector (incl. 1 retired): ...`, and the selector on retired lines), and the [handoff sheet](#handoff). Retired lines say `(old code: ...)`, so the old part's code is not read as the replacement's. With no Angular entries, the cards and reports read as they did before PR #36, except for that `old code` wording.

`resolve code-map` reports `mapped`, `retired`, `unmapped`, `ambiguous`, `conflict`, `stale` (an entry whose component is not in the library, with its file key), `ignored`, plus lists of retired parts (with code and replacement) and bad `replacedBy`. Only real components and component sets are counted: variants, remote stubs and `_`/`base` parts are not.

#### Other optional files

`bind-rules.json` (must use / must not use / prefer; see [`docs/BIND-RULES.md`](docs/BIND-RULES.md)), `library-rules.json` (a simple allow/deny list of names), `recipes.json` and `context-packs.json` (your own recipes and product/journey packs; see [`docs/RECIPES.md`](docs/RECIPES.md)), and `placeholders.json` (template sentences that must not be left in a final screen; see [`docs/GUIDE.md`](docs/GUIDE.md)).

### Retired and old components

Old screens still use old components, so Resolve cannot forget them. But new screens must not use them. The rule has two halves:

- **Retired parts stay known.** They stay in the graph and in the code map, and `verify` recognises them on an existing frame, shows what they map to, and names the replacement.
- **Retired parts are not recommended for a new screen.**

How a part counts as retired:

1. **The library says so.** A name with `[deprecated]` or `legacy`, a set tagged deprecated, a description such as `status: deprecated`, or a description that starts with words like "retired" or "no longer supported". A description that is only `Legacy`, `Legacy.`, or `Legacy: will be removed…` also retires the part. `Legacy users still see this`, `Do not use inside tables`, and `Supports legacy browsers` stay live. A retired set makes all its variants retired. "The old design is retired. This one is current." does not retire a part, and neither does "Do not use inside forms".
2. **Your code map says so.** `"status": "retired"` on an entry. Variants follow their set.
3. **A map cannot bring a part back.** `"status": "current"` does not revive a part the library itself retired.

What Resolve does, exactly. It depends on whether you have a code map:

| | No code map (the default) | With a code map |
| --- | --- | --- |
| `recommend` | Never offers a retired part as the pick. Asking for a retired name returns the live replacement. If the only match is retired, the hint says `Only match is retired: Old Button. Use none.` | Never offers a retired part, whether the library or the map retired it. The note `Old Button is retired, use Button.` is added when the best match was retired and it fits in 600 characters without dropping a candidate. If the only match is retired the hint says `Only match is retired: Old Button. Use Button.` (or `Use none.`) instead of "No master matched". |
| `resolve` | Answers an exact retired name flagged `deprecated: true`, with the replacement. | Same, plus map-retired parts. It is an answer to "I know the name", not a recommendation, so it still answers; it prints no code line for a retired part. |
| `verify` | A retired part fails the check (listed under `deprecated`). | The same, for library-retired and map-retired parts alike (a map-retired part is not a pass-with-warning). Each retired part also gets a line: `retired Old Button -> use Button (old code: OldButton from '@acme/ui-legacy')`. |

- A retired part's replacement is a *current* part, found through `replacedBy` (followed up to 3 steps) or, without it, the library's own name guess. A guess is never shown as a firm answer: it reads `closest current part (guess): Button`. If there is none the line says `no current replacement`. Resolve never points at a retired part, and never suggests an icon as the replacement. A recipe content slot (content, body, detail, message) is never filled with an icon; if icons are the only candidates, that slot stays empty.
- Recipes skip a map-retired part and take the live one.
- `resolve code-map --retired` lists every retired part, with code and replacement. `example` and `cousins` do not use the map.

### Accuracy and honesty rules

- **It never invents.** An id or component name in an answer is always one that exists in the stored library. "Invent rate" must be 0%.
- **It says "no match".** Asks the library cannot answer (for example "color picker" when there is none) return an empty list and "No master matched. Do not invent."
- **A loose match is labelled.** "Weak match" and up to three parts, instead of one confident guess.
- **A pass means something.** `verify` says "Verified" only when at least one placed piece was checked by its own component id or key. A layer-name match is "name-only" and a bare list or an empty frame is "nothing checked". Neither is a pass. A layer renamed on the canvas still verifies by id, and the card says the label differs.
- **Retired parts and private parts.** Private parts (names starting with `_` or `.`) come back only when you ask for that exact name. Retired parts are never the pick `recommend` tells you to place, with or without a code map. Asking for a retired name returns the live replacement and says so. A retired part with no live replacement comes back as "Use none" — it is not placed. Exact case-sensitive `resolve` of that name still returns the retired master, flagged. Exact rules are in [Retired and old components](#retired-and-old-components).
- **Only people change rules.** Bind rules, recipes, synonyms and code maps change when a person edits them or approves a proposal.
- **Small cards.** `recommend` stays within 600 characters, `resolve` within 2,000 and `recipe` within 2,000. `verify` aims for 600 when it finds a problem; a check that passes many components can be longer (about 760 for five). The largest seen on the repo's test set: recommend 600, verify 559, resolve 978, recipe 964. A verify card that shows retired parts stays within 600 unless the failures alone are longer (about 17 invented names); then the card is as long as it was before the code map, plus the short pointer to `resolve code-map --retired`.
- **No token in the repo.** Never store a Figma token in files.

Numbers from the repo's own checks (run `npm test` and `score` to reproduce):

| Check | Result |
| --- | --- |
| Repo golden set (top-1) | 118/118, invent 0, leak 0 |
| Phrase set (regression) | 96/96 |
| Designer phrase set (118 phrases, written after the ranker) | top-1 66/88 (75%), top-3 68/88 (77%), honest no-match 30/30, invent 0, retired offered 0. Weakest: paraphrase, 20/39 right first, 14 got nothing back |
| 8-screen Material-like library, alone, and with a product screen learned | top-1 41/41, top-3 41/41, honest no-match 14/14, false no-match 0/41, synonyms 18/18, invent 0 |
| Ingredient card (Acme example library) | Payee picker = Avatar + Button, Payment method row = Avatar + Button; invented parts 0; unmapped parts shown as unmapped |
| Angular code map (Acme example) | 4 Angular entries load with 0 ignored; the CSV example imports to the same map; 14 bad Angular values dropped with a reason while the code line stays; 5 real selector forms and input aliases accepted |
| Handoff sheet (Acme example) | Send money refused for the retired Old Button (draft or not); after the fix, 3 components, 3 linked to code, 2 parts, verify PASS, matches the golden file; 0 invented code lines. Receipt refused as `not-found` (Legacy badge's component is in no learned file); Payment methods' Brand mark labelled `other-library` |
| Tests | 742 passing |

**Top-1** means the first component returned is the right one. **Invent** means a component not in the library. **Leak** means a retired or private component offered as a pick. The golden and phrase sets were written alongside the code, so they are a regression guard and not proof about unseen wording. How the sets are built: [`docs/SCOREBOARD.md`](docs/SCOREBOARD.md).

### Limits: what is not tested yet

- Not proven on a real company library over time. The checks above use a sample library and a Material-like test library. An earlier independent blind test on a sample library moved top-1 on unseen asks from 38% to 83% after PR #19.
- Code twins are only as good as the map: Resolve does not check that the code component exists or that its props match the Figma variants.
- The map has no per-variant props, no source path, and no automatic same-name rule yet (all planned).
- If two entries for one part are both current (or both retired) and disagree, you get "conflict" and no code line; there is no tie-break on purpose.
- The code line on `recommend` and `resolve` is left out, silently, when the card is full. The part still counts as mapped in `code-map`. It also cannot appear for a part that lives in another Figma file (a remote stub).
- A `verify` card that is already full of failures keeps the retired lines by removing lower-value text. If a single retired line is still too long (for example a part name of several hundred characters) the card says to run `resolve code-map --retired`. The failing parts are always listed.
- A replacement chain is followed up to 3 steps; a longer one counts as "no current replacement".
- With or without a code map, `recommend` does not offer a retired part as the pick to place. An exact retired name with no live replacement says "Use none". `resolve` of that exact name still returns the retired master, flagged.
- `example` and `cousins` do not use the code map and do not say a part is retired.
- The code map's Angular fields and the handoff sheet's suggested inputs are tested on the made-up Acme map only; a real Angular map waits on access to the real Angular code. Suggested input values are the Figma value in lower case with dashes, keeping letters of any language (`Warn Light` becomes `warn-light`, `Größe` becomes `größe`); check them against the code. An attribute the selector already sets (`acme-button[variant="primary"]`) is not repeated.
- The handoff sheet reads one copy per variant on a screen for the parts list; two copies of one variant with different insides show the first one's parts. It uses a recipe from the screen name only on an exact name; a looser match is named, not checked.
- SOCI does not compare journeys across products yet.
- Linking several design systems into one is a later step.
- Large-library speed is measured only on generated test graphs (`npm run bench`).
- Not run for this README: anything that needs a Figma account (reading a live Figma link, the published-icon lookup, the Figma login), Codex, the Cursor app and the Claude desktop app. The `npx` install from GitHub, `claude mcp add`, `claude mcp get` and `resolve-setup` were run on a test machine.

### Version history

Newest first. Dates are the day each pull request was merged on GitHub (UTC). "Tests" is the number of tests in the repo at that change (counted by running the suite on the commit).

- **Oct 7, 2026 — slash commands (branch `stage1-slash-commands`, not yet a pull request).** `resolve-setup` now installs six slash commands for Claude Code (`.claude/commands/`) and Cursor (`.cursor/commands/`): `/design-system <link>`, `/find <phrase>`, `/check <link>`, `/parts <component>`, `/handoff <link>` and `/resolve-status`. Each tells the agent which Resolve tool or command to call, what to show, and not to invent a component. Files Resolve writes carry begin/end markers; setup again updates only those, a command or rule you wrote yourself is kept, and the new `resolve-setup --uninstall` removes only what Resolve wrote. The same commands are MCP prompts (not tools; the default stays 7 tools). New `resolve status`. A pasted Figma link with `node-id` works wherever a frame is asked for (`verify`, `cousins`, `handoff`). Handoff fixes from the PR #37 retest: a Figma value that contradicts a selector-pinned attribute gets no template value and an open question; recipe slots are `placed`, `inside <Component>` or `missing`, one copy fills one slot, with a `N/M slots covered` count; a not-found part inside a library component's definition refuses like a retired one; other-library and not-found parts are `code: "unknown"` (not `unmapped`) in the JSON; `states` is documented as the other values. Ranking is unchanged. 742 tests.
- **Oct 6, 2026 — [PR #37](https://github.com/TANISHQBAFNA/resolve/pull/37) (draft, not merged).** New `resolve handoff "<frame>"` (MCP `get_handoff`, off by default): one sheet per screen with recipe slots, every placed component with its Figma id and code, suggested Angular inputs from Figma variants, the parts inside, verify, approved decisions and open questions. A retired component refuses the handoff, including a retired part read from a main component; a layer-name guess, or a copy whose component is in no learned file (kind `not-found`), refuses it unless `--draft`. A component from a library file that is not learned is labelled `other-library` (no Figma id, code unknown). Over MCP, a cut handoff keeps every open question and the true part count. The code map keeps an entry's code line when its Angular fields are bad, and accepts real Angular selectors and input aliases. `code-map --import --force` keeps and lists entries the CSV has no row for (`--replace` drops them); a row matches another file's entry, or one with a different id, never by name alone, and every replaced or removed entry is listed. Duplicate CSV headers and unknown `code-map` options are refused. `--out` refuses over any earlier handoff file and removes stale screen files with `--force`; names are escaped in the markdown; loose frame matches are labelled; decision times carry their zone. Also: CSV rows are numbered as in the spreadsheet, extra columns are ignored, a friendly message when nothing is learned yet, clearer Angular counts, and retired lines say `old code`. Ranking is unchanged. 727 tests.
- **Oct 6, 2026 — [PR #36](https://github.com/TANISHQBAFNA/resolve/pull/36).** The code map takes Angular entries (`selector`, `module` or `standalone`, `inputs`, `outputs`); they show on the ingredient, `resolve` and `recommend` cards, `verify` retired lines and `code-map`. New `code-map --init` / `--import` fill the map from a CSV. Over MCP, very large ingredient cards are cut and say so. React entries are unchanged. One ingredient-card sentence changed: a placed copy with no parts (Acme's Old Button copy, ACMEUI 20:43) no longer says "Parts read from this placed copy...". 698 tests.
- **Oct 6, 2026 — [PR #35](https://github.com/TANISHQBAFNA/resolve/pull/35).** New `resolve ingredients "<component>"` (MCP `get_ingredients`, off by default): the parts inside a component, following the variant used, each with its code component or "no code link yet"; guessed and retired parts are labelled. A placed copy is read from its own insides at every level, and anything taken from the main component says so. Ranking is unchanged. 684 tests.
- **Oct 6, 2026 — [PR #34](https://github.com/TANISHQBAFNA/resolve/pull/34).** New `resolve score phrases`: 118 designer-worded phrases on the sample library, or only a team's own phrases on its library (never mixed); right part first 66/88 (75%), weakest on paraphrases, and an invented or retired part fails the tests. Ranking is unchanged. 658 tests.
- **Oct 5, 2026 — [PR #33](https://github.com/TANISHQBAFNA/resolve/pull/33).** The same ask gets the same top pick from `resolve` and `recommend`: an exact component name (letter case ignored) stays that component on both. A missing `icon-libraries.json` stays quiet. A mistyped icon-library name, or a broken `icon-libraries.json`, warns instead of failing quietly. Retired parts are never the pick to place (exact `resolve` of that name still shows the retired part, flagged). A description that is only "Legacy" counts as retired. Replacements are never icons. The desktop app shows the library and the rules, not a graph. 643 tests.
- **Oct 3, 2026 — [PR #32](https://github.com/TANISHQBAFNA/resolve/pull/32).** Install by asking your AI tool: new `INSTALL-FOR-AI.md` checklist (Claude Code, Cursor, Codex; Codex not verified), linked from the README top and `AGENTS.md`. `resolve-setup` adds the project's `.cursor/mcp.json` and `.mcp.json` by itself (keeps other servers, leaves invalid JSON alone), and `Figma connected?` also sees a Claude Code Figma server (read-only). README setup rewritten around it; hand-typed steps moved into an "If you prefer to do it by hand" box. 632 tests.
- **Oct 3, 2026 — [PR #31](https://github.com/TANISHQBAFNA/resolve/pull/31).** README rewritten in plain language for designers: the problem, what Resolve does, numbered setup steps with "what you should see". Engineer detail moved under "For engineers and testers" and shortened. Docs only. 618 tests.
- **Oct 3, 2026 — [PR #30](https://github.com/TANISHQBAFNA/resolve/pull/30).** `RESOLVE_HOME` is the name of the store setting and `.resolve/` the project folder; the old names still work as fallbacks and nothing is moved. README reorganised for designers (set-up for Claude, Cursor and Codex first). 618 tests.
- **Oct 3, 2026 — [PR #28](https://github.com/TANISHQBAFNA/resolve/pull/28).** Map Figma components to team-owned code twins; retired parts stay mapped but are never recommended. 612 tests.
- **Oct 1, 2026 — [PR #27](https://github.com/TANISHQBAFNA/resolve/pull/27).** Prefer filled sets over same-name stubs; icon libraries file; stricter retire rules. 582 tests.
- **Sep 30, 2026 — [PR #26](https://github.com/TANISHQBAFNA/resolve/pull/26).** Treat layer names as labels, not component identity. 541 tests.
- **Sep 29, 2026 — [PR #25](https://github.com/TANISHQBAFNA/resolve/pull/25).** "Primary button" returns Button; ordinary words find the right part; honest "weak match". 517 tests.
- **Sep 29, 2026 — [PR #24](https://github.com/TANISHQBAFNA/resolve/pull/24).** Resolve is the first step on every Figma design task (short MCP instructions, `resolve-setup`). 490 tests.
- **Sep 28, 2026 — PRs #18 to #23.** Live text in `verify`, a real example with every pick, better matching of component words, Claude setup fixes, performance wording. 429 to 479 tests.
- **Sep 25 to 27, 2026 — PRs #4 to #17.** Recommend and `verify_frame`, screen recipes, multi-file workspace and the wrong-cousin report, bind rules and approvals, SOCI, the accuracy scoreboard, plug-and-play next to the Figma MCP. 227 to 428 tests.
- **Sep 20 to 24, 2026 — PRs #1 to #3.** First public release (personal and client leftovers scrubbed), toolchain upgrade (Vite 8, React 19, Vitest 5), product renamed from Keyline to Resolve. 219 tests.

The full list, one line per pull request, is in the [pull request history](https://github.com/TANISHQBAFNA/resolve/pulls?q=is%3Apr+is%3Amerged).

### FAQ

More plain-language answers are in [Questions designers ask](#questions-designers-ask).

**Why does my retired component not show in `recommend`?** Retired parts (retired in the library, or in a code map) are never the pick for a new screen. They stay mapped when you have a code map. You still see them when you check an old frame with `verify`, or ask for one by its exact name with `resolve`. `recommend` names the live replacement, or says none.

**Does a retired part fail `verify`?** Yes, the same way whether the library or your code map retired it. The card lists it under `deprecated` and, with a code map, adds a line such as `retired Old Button -> use Button (old code: OldButton from '@acme/ui-legacy')`.

**Can the code map revive a retired part?** No. If the library flags a part retired, `"status": "current"` in the map does not change that. Fix it in Figma.

**Why is there no code line on my `recommend` card?** One of: no map; the top pick is a weak match; the top pick is retired; the part is not mapped (see `resolve code-map`); the name is ambiguous or in conflict; the top pick lives in another Figma file (a remote stub or an external icon library), which cannot be mapped; or the line did not fit in the 600-character card without dropping a candidate (it is then left out with no message).

**What is `RESOLVE_HOME`?** The setting that pins the store folder. If you do not set it, Resolve uses the nearest `.resolve/` folder going up from where you run, then `~/.resolve/default`. Upgrading from an older version: see [Upgrading from the old names](#upgrading-from-the-old-names).

**Where do I put team words?** `.resolve/synonyms.json`. See [team config files](#team-config-files).

**What Node version?** 22.12 or newer (Node 24 also works).

### For developers

```bash
git clone https://github.com/TANISHQBAFNA/resolve.git
cd resolve
npm install
npm run build:server
npm run resolve -- help
npm test          # the full test suite
npm run build     # typecheck + browser build + server build
```

`npm run dev` opens the library and rules pages in a browser (sample data, no login). There is no graph canvas. `npm run keyline` still works and prints a deprecation warning.

- Plug-and-play next to Figma: [`docs/SETUP-MCP.md`](docs/SETUP-MCP.md)
- Designer guide: [`docs/GUIDE.md`](docs/GUIDE.md)
- Bind rules and approving a proposal: [`docs/BIND-RULES.md`](docs/BIND-RULES.md)
- SOCI: [`docs/SOCI.md`](docs/SOCI.md)
- Screen recipes: [`docs/RECIPES.md`](docs/RECIPES.md)
- Accuracy scoreboard: [`docs/SCOREBOARD.md`](docs/SCOREBOARD.md)
- Cursor steps: [`docs/CURSOR-RESOLVE.md`](docs/CURSOR-RESOLVE.md)
- Building Resolve: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- How tools plug in: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)
- Toolchain versions: [`CHANGELOG.md`](CHANGELOG.md)

License: [`LICENSE`](LICENSE) (MIT)
