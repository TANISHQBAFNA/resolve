# Resolve reference

This is the full manual. The [README](../README.md) is the short visual tour. Every example here uses the made-up Acme design system: "Acme" is a pretend company, the "Payments app" is a pretend product, and its components (Button, Text field, Payee picker) are pretend.

- [Install in detail](#install-in-detail)
- [Slash commands in detail](#slash-commands-in-detail)
- [How it works in detail](#how-it-works-in-detail)
- [Check that a screen uses the library properly](#check-that-a-screen-uses-the-library-properly)
- [Check that Resolve understands your words](#check-that-resolve-understands-your-words)
- [Questions designers ask](#questions-designers-ask)
- [Words used here](#words-used-here)
- [For engineers and testers](#for-engineers-and-testers) (every command, config files, retired parts, accuracy, limits, FAQ, developer setup)
- [Version history (wiki)](https://github.com/TANISHQBAFNA/resolve/wiki/Version-history)

## Install in detail

Plan on about ten minutes. Pick **one** option. Option A is the simplest: install once and every chat in every project asks Resolve first.

### Before you start

You need three things:

1. **Node, version 22.12 or newer.** Node is a free program that runs Resolve in the background. To check, open a terminal (the Terminal app on Mac) and type:

   ```bash
   node -v
   ```

   You should see a number such as `v22.12.0` or higher. If you get an error or a lower number, install the current version from [nodejs.org](https://nodejs.org).
2. **An AI tool**: Claude Code, Cursor or Codex.
3. **A Figma seat that allows AI tools to read your files.** For learning you need a **Dev or Full seat**, a paid seat type. A View or free seat has a small read allowance; Resolve saves its progress and carries on in the next session.

### Option A: install as a plugin (recommended)

Install Resolve once. After that, every chat in every project asks Resolve before it draws in Figma. You do not paste the install note again.

You still do two things by hand. Connect Figma in the app (sign in when it asks). Then fill in the two settings the plugin asks for: a **Figma token**, and the **library file key**. The file key is the id in a link such as `https://www.figma.com/design/ACMEUI/Acme` (here the key is `ACMEUI`). Do not type the token into a file.

**Claude Code**

1. Add the Resolve marketplace:

   ```
   /plugin marketplace add TANISHQBAFNA/resolve
   ```

2. Install the plugin:

   ```
   /plugin install resolve@resolve
   ```

3. When it asks, fill in **Figma token** and **Library file key**.
4. To change them later:

   ```
   /plugin configure resolve@resolve
   ```

**Cursor**

1. In the Cursor chat, type:

   ```
   /add-plugin https://github.com/TANISHQBAFNA/resolve
   ```

2. Install **resolve**.
3. Open **Plugins**, choose **Resolve**, then **Configure**, and fill in the same two settings.

The older per-project setup (`resolve-setup`, Options B and C below) still works. Use the plugin when you want Resolve in every project without running setup in each one.

### Option B: ask your AI tool to install it in one project

You do not type commands: your AI tool does the installing. The steps tell you what to expect, so you can tell it worked.

**Step 1. Ask your AI tool to install Resolve.**

Open your project in Claude Code, Cursor or Codex, and paste this into the chat:

> Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md

The tool reads [`INSTALL-FOR-AI.md`](../INSTALL-FOR-AI.md), a checklist written for AI tools, and does the work. In plain words, it will:

1. Run one setup command in your project. That command writes a short instruction file the tool reads every time ("for any Figma task, ask Resolve first"), and a small settings file that tells the tool how to start Resolve. (Different tools call these a **Cursor rule**, a **Claude skill**, and a **project connection**. If you already have such a settings file, Resolve adds itself and keeps everything else in it.)
2. Connect the tool to Figma if that is not done yet. **MCP** (Model Context Protocol) is the plug that lets an AI tool talk to helper programs. Resolve is one helper and Figma has one too.
3. Check that it worked, and tell you what it changed.
4. Ask you before it changes anything in settings that live in your home folder, and never show you or copy any password or token.

**What you should see:** a short report listing the files it created (for example `.cursor/mcp.json`, `.mcp.json`, the Cursor rules and the Claude skills), the commands it ran, and two things only you can do: sign in to Figma, and paste a Figma link (Step 2). For Claude Code, you also say yes the first time it asks about the project's `resolve` server.

Checked on a test machine: every command in `INSTALL-FOR-AI.md` was run exactly as written, for Claude Code and for Cursor, in a scratch project with a scratch home folder (details in the engineer section below). **Not verified:** a real AI tool following the file in a live chat, Codex (not installed here), the Figma sign-in, and the Cursor app screens.

**Step 2. Teach it your library.**

1. Restart the tool so it sees the new settings (Claude Code: quit and start `claude` again in the project. Cursor: reload the window). Then sign in to Figma when it asks (Claude Code: type `/mcp`, choose figma, log in. Cursor: **Settings → MCP** and sign in).
2. In the chat, write: "Learn my Figma design system from this link: (paste the Figma file link)".
3. The tool reads the file through Figma and hands it to Resolve (behind the scenes it calls a Resolve tool named `learn_library`). Big libraries can take a few minutes. The exact words in the chat differ from tool to tool.
4. **What you should see:** the tool says it has learned the library and roughly how many components it found. To double-check, ask the tool to run the setup check again (`resolve-setup`): `Library learned?` now says `yes`, `Figma connected?` says `yes`, and the last line reads `Next: Ask Resolve for the screen.` (Checked on a test machine with the made-up Acme file and a Figma server in the project settings. The Figma part of this step was not run, because it needs a Figma account.)

Upgrading from an older version of Resolve? Read [Upgrading from the old names](../README.md#upgrading-from-the-old-names) first.

### Option C: install it by hand

These are the same steps, typed by you. Use them if you would rather not let your AI tool run commands.

#### Step A. Set up your project (once per project)

An AI tool forgets things between chats, so it needs a short written instruction that it reads every time: "for any Figma task, ask Resolve first." Different tools call this file different names. In Cursor it is a **Cursor rule** (one always-on core rule, plus a rule for each workflow that loads only when needed). In Claude it is a **Claude skill** (the same split), plus a small note in a file called `CLAUDE.md`. The same command also adds the **project connection**: a small settings file that tells Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`) how to start Resolve. You do not have to create that file yourself. Open a terminal in your project folder and run:

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-setup
```

1. Paste the command and press Enter.
2. **What you should see:** lines starting with `create` (the Cursor rules, `.cursor/mcp.json`, `.mcp.json`, the Claude skills, the slash commands and `CLAUDE.md`), then a short checklist: `Node ok?`, `Figma connected?`, `Library learned?`, `Rule installed?`, and a last line starting `Next:` that tells you what to do next. At this point `Library learned?` says `no`, and that is fine. `Figma connected?` says `no` until Figma is connected (Step B).
3. It is safe to run again; it only touches its own lines. If you already have a `.cursor/mcp.json` or `.mcp.json`, Resolve adds itself and keeps everything else in it. If such a file is not valid JSON, Resolve leaves it alone and tells you which file to fix. To look first without changing anything, add `--dry-run` at the end.
4. If you only use one of the two tools, the other settings file is harmless; delete it if you like. Resolve never changes settings that live in your home folder (`~/.claude.json`, `~/.cursor`, `~/.codex`); the steps below that touch those are yours to run.

#### Step B. Connect Figma and check Resolve

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

Checked on a test machine: Step A writes the Cursor rules (`.cursor/rules/resolve.mdc`, set to always apply, plus `resolve-figma.mdc` and `resolve-code.mdc`, which load on demand) and `.cursor/mcp.json`, and the command in that file starts Resolve. **Not verified here:** the Cursor app itself (the screens in steps 2 and 3). More steps: [`docs/CURSOR-RESOLVE.md`](CURSOR-RESOLVE.md).

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
3. Step A does not write anything for Codex, because Codex reads a file called `AGENTS.md` instead. Copy the short section in [`docs/AGENTS-RESOLVE-SECTION.md`](AGENTS-RESOLVE-SECTION.md) into your project's `AGENTS.md`.

Using the Claude desktop app instead? See [Setup in detail](#setup-in-detail).

#### Other ways to connect, by hand

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

### Two asks to try

These use the made-up Acme library. Type them into your AI tool once Step 2 is done.

1. **"Which component should I use for a payee picker on the Send money screen?"** Resolve answers with the Acme "Payee picker": where it lives in Figma, and a real example to copy. If your engineers filed a code map, it also names the code component (`PayeePicker from '@acme/payments'`). Your tool then places that component, instead of drawing one.
2. **"Check the Send money screen."** Resolve answers that the check failed, because the screen uses the retired "Old Button". It says what to use instead (Button) and what the code is (`OldButton from '@acme/ui-legacy'`).

The exact, word-for-word answers for both are shown further down, under [recommend](#recommend) and [verify](#verify).

## Slash commands in detail

Once Resolve is installed, type these in the chat of Claude Code or Cursor. Each one tells your AI tool exactly what to ask Resolve, and what to show you. You paste a Figma link where it says `<link>`; a link to a single screen (it has `node-id=20-40` in it) works everywhere a screen is asked for. In every case, if Resolve has no match it says so. It never makes a component up.

| Type | What happens | What you see |
|---|---|---|
| `/design-system <link>` | Resolve learns that Figma file (or page, or frame) and saves its components on your computer. A very big file is learned page by page. Running it again is safe. | How many components, how many are retired, which icon libraries are known, where it was saved, and what is still left. |
| `/find <phrase>` | Resolve picks the right component for your words, for example `/find payee picker`. | A confident pick: the component, its Figma id, and a one-line reason. A weak match is shown as weak, with that one-line reason. It is never presented as a sure thing. Or "no match". |
| `/brief <screen>` | Before it picks parts for a screen, Resolve asks at most 3 multiple-choice questions. It only asks when the answer would change the component. The choices are real parts from the library you learned. | The questions, or a ready answer with the assumptions and the parts to use. "Just build" skips the questions and shows what was assumed. |
| `/check <link>` | Resolve checks a finished screen. | Three short lists: **Retired** (old components still on the screen), **Wrong** (a lookalike from the wrong family) and **Unknown** (not in the library). Or "passed". |
| `/parts <link>` | What's on this screen and its code twin (or unmapped). For example a link to the Acme "Send money" screen. | Each component on the screen, its Figma id, and its code twin, or the word unmapped. |
| `/handoff <link>` | The developer build sheet for that screen. | Every component with its Figma id and code, the parts inside, which recipe slots are filled, the check result and open questions. Or the reason it refused. |
| `/resolve-status` | One short answer about this project. | Which libraries are loaded, when each was learned, its version if known, whether the Figma token is set, whether the always-on rule is installed, and what to do next. |
| `/spec <link>` | Which real component each requirement in a Figma spec maps to. | Mapped parts with their Figma id and file key, weak matches marked weak, no-match lines, and the product, journey, audience and accessibility level the spec states. Never an invented part. See [Figma specs](#figma-specs). |
| `/learn-code <repo>` | Resolve scans the coded design system in the repo. | Component, class and token counts, and the deprecated classes. |
| `/pick-code <need>` | Resolve picks coded components for a screen need, for example `/pick-code transaction table with pagination`. | The components with their classes, modifiers, markup and `avoid` list. Or "no match"; it never invents a class. |
| `/check-html <file>` | Resolve checks an HTML screen against the coded design system. | Errors and warnings with line numbers, and the components used. |

A delivery-process ticket, if your team uses one, calls `/handoff` for the build sheet. It does not replace that command.

### Brief a screen

Use this when you know the screen you want, and you do not yet know which parts to place.

`/brief show recent payments` (or `resolve brief "show recent payments"`) looks at three things:

1. The shape of the data: a table or a card list, a form, a summary, or counts. A list ask that names no shape gets one question, list or table, but only when `recommend` finds a part from its other words ("show all data"). "All" or "list of" with nothing else that fits says No match.
2. Which states matter: empty, loading, error, pending. You can pick more than one. Not asked when the request names a part plus a context ("summary cards for the order"). An option shows only when it adds a part the request does not already have.
3. Phone or desktop, and compact or comfortable. Asked only when the best part comes in platform versions, like Desktop Nav and Mobile Nav. The word "desktop" alone is not a component named Desktop Nav.

Resolve does not ask what kind of screen it is. That question did not help choose a component.

It asks only when the request fits something in the library, and only when the answer would change the component. Fit comes from `recommend`'s own ranking, so "data tables" fits Data Table. A request that fits nothing, including a typo-heavy one, gets no questions and says "No match", with what to try next. A recipe whose slots find no part says the same. A saved recipe, an approved screen decision, or a single fitting component also asks nothing. When no saved recipe fits and compose would build a recipe from the parts named, the result also has `composeOffer`: an offer to run `recipe --compose`. When a saved recipe already has those parts or that title, it has `savedRecipe` instead. Brief never composes by itself.

"Just build", "go ahead and build", "no need to ask", and "without asking" anywhere in the request ("make the stat blocks without asking") ask nothing. If nothing fits, there are no candidates. Parts that a handoff adds from your answers are marked `to-add`, with no placed count.

Pass an answer with `--answer shape=table`. States can repeat: `--answer states=empty --answer states=error`. Topics are `shape`, `states`, and `platform`. At most 3 answers. An unknown topic, an unknown option, an empty value, a duplicate, or a fourth answer is an error. The same answers change the parts on `recommend` and on the handoff sheet. Resolve does not ask who the person is, what the visual style should be, or about a ticket or a regulation.

Setup (`resolve-setup`) puts these files in your project: `.claude/commands/` for Claude Code and `.cursor/commands/` for Cursor. Your AI tool shows them when you type `/`. Codex has no project commands; with Codex, say the same thing in words ("check this screen with Resolve: link"). Other tools can read the same commands as MCP prompts. To update them, run setup again. To remove everything Resolve added, ask your AI tool to run `resolve-setup --uninstall`; your own files and text stay.

If a command cannot finish, you get one plain sentence and what to do next. You never see a stack trace. That covers a bad Figma link, a missing or expired token, a View-only seat, no design system learned yet, and Resolve not installed.

Two kinds of files live in `.resolve/` on your computer. **Team files** are the ones your team wrote: recipes, context packs, the code map, decisions, bind rules, synonyms, phrase sets (`scoreboard/phrases/`) and golden files (`scoreboard/golden/`, including the file `score --init` writes). Those belong in the project. The **learned cache** is rebuilt by `/design-system`. Setup ignores that cache (`.resolve/graph.json`, `.resolve/files/`, `.resolve/learn/`, `.resolve/ingest/`, `.resolve/GRAPH_REPORT.md`, `.resolve/index.json`, `.resolve/setup-record.json`) and scoreboard run history (`.resolve/scoreboard/*`). A line in `.gitignore` that ignores the whole `.resolve` folder (`.resolve`, `.resolve/`, `.resolve/*`, or the same idea with `**`) also hides the team files; remove that line if you want them saved with the project.

## How it works in detail

### What an MSOCK is

**In plain words:** Resolve keeps two things. **SOCK** is the facts: what each of your components is. **SOCI** is the instructions: how to use them on a screen. **MSOCK** is just the name for both together. You never need these words to use Resolve.

Resolve is a design-system **MSOCK**: **SOCK** knowledge plus **SOCI** instructions, packed so that an AI can get the right component and the right context to design a screen.

| Part | What it holds | Where it lives | Example (Acme) |
| --- | --- | --- | --- |
| **SOCK** (System of Connected Knowledge) | The facts about your library: every component, its variants and properties with allowed values and defaults, real examples of it on screens, which parts are retired, which screens used it and passed the check, and (when the team maps it) its React or other code twin. | The learned graph and SOCK facts in your store (`.resolve/`), plus your team files (code map, synonyms). | Payee picker = Avatar + Button. Code: `AcmePayeePickerComponent`, `<acme-payee-picker>`. |
| **SOCI** (System of Connected Intelligence) and instructions | How the AI must use that knowledge: the always-on "ask Resolve first" rule, screen recipes, context from the requirements, human bind rules, and SOCI's suggested rules and recipes (a person approves each one). | `rules/resolve.mdc`, `rules/resolve-figma.mdc`, `skills/resolve/SKILL.md`, `skills/resolve-figma/SKILL.md`, the slash commands, `.resolve/recipes.json`, `.resolve/bind-rules.json`, `.resolve/context-packs.json`, approved SOCI decisions. | "On the pay step, use Button." "A Send money screen needs a payee picker, an amount field and a primary button." |

The AI tool asks; Resolve answers from the MSOCK; the AI tool draws. Resolve never draws and never changes your Figma file.

```
Designer / requirements ──► AI tool (Claude Code or Cursor)
                               │  always-on rule: "ask Resolve first"
                               ▼
                      Resolve (MSOCK, read-only)
     known name?  ── yes ──► resolve      → that exact component + Figma id
                  └─ no ───► recommend    → best match, "weak match", or no match
     screen job?  ─────────► recipe       → slots filled with real components
     how to place ─────────► get_example  → a real filled-in copy to clone
                               │
                               ▼
                      AI tool draws in Figma
                               │
                               ▼
                      verify_frame / /check → pass, or what to fix
```

### Known name first, phrase finder second

There are two ways to ask Resolve for a component, and the AI uses them in this order:

1. **The name is known.** The designer typed it, the requirements name it, or the AI read it off a component already on the canvas (for example `Popover` or `Text field`). The AI calls `resolve` with that name. An exact component always comes back with `id`, `fileKey` and `figmaNodeId`, even if it is used nowhere yet. A retired name comes back flagged, with the live replacement. `/find` does the same thing when the phrase is an exact component name.
2. **The name is not known.** The AI calls `recommend` with the designer's words ("payee picker", "6 digit OTP box"). This is the **phrase finder**. It looks at the name and the words first (exact name, word match, team synonyms); screen and usage only break ties. A partial match says **weak match** and offers up to three parts. No match says "No master matched. Do not invent."

The same ask gets the same top pick from both: an exact component name (letter case ignored) stays that component in `resolve` and in `recommend`.

### The story in one minute

**The problem.** You ask an AI tool (Claude, Cursor or Codex) to draw a screen in Figma. It is fast, but it guesses. It may draw a button from scratch instead of using the Button in your design system. It may pick a component your team retired, because the name looks right. It may even invent a part that does not exist. The screen looks fine at a glance, but it is not built from your design system, so it slowly drifts away from it.

**Without Resolve.** You ask Claude for a "Send money" screen in the Acme Payments app. Claude draws a rounded rectangle that looks like a button. It places "Old Button", a component Acme retired last year. It adds a part called "Payee dropdown" that is not in the library at all. Nobody notices until an engineer tries to build the screen.

**With Resolve.** You ask the same thing. Before it draws anything, Claude asks Resolve, "Which component do I use for a payee picker?" Resolve answers: "The Acme Payee picker. Here is where it lives in Figma, and here is a real example of it to copy." Claude places that real component. When the screen is drawn, Claude asks Resolve to check it. Resolve says: "Fail. This screen uses the retired Old Button. Use Button instead." Claude fixes it. If you ask for something the library does not have, Resolve says "no match", and Claude tells you, instead of making one up.

**What you see.** You do not open Resolve, and there is nothing to click. You see it in your AI tool's chat: Claude says which library components it chose, and it tells you the result of the check ("passed" or "failed, because..."). In Figma you get a screen made of real library components.

**What Resolve is not.** It is not a Figma plugin. It does not draw anything; your AI tool draws. It never changes your Figma file; it only reads. It never guesses: no match means no answer. And it never changes your team's rules (for example "on the pay step, use this Button") by itself; a person approves every change.

### Each piece in detail

- **It learns your library.** You give it your design system file once. It reads the file and writes down what is in it: every component, its variants (for example Primary and Secondary), and where each one is used on real screens. You can repeat this whenever the library changes. This step has two names: **learn** (when your AI tool does it) and **ingest** (when you do it by hand). They mean the same thing: read a Figma file and remember it.
- **It sets the context from the requirements or FSD.** The agent reads that document. Resolve does not. The agent passes which product, which journey step, who the screen is for, and the accessibility bar (for example wcag-aa) only when the document states them. A context pack is optional and stays: it is where a team adds its own words and property hints. It is used only on an exact product match, and an exact journey match when the document gives one. Audience, a11y, and density are shown on the card and do not change which component is picked.
- **It recommends.** You describe what you need in plain words ("payee picker", "primary button"). Resolve picks the best matching component for that context. It looks at the name and your words first. If the match is only partial, it says "weak match" and offers up to three options, instead of pretending to be sure. An empty answer means stop. It does not draw a stand-in.
- **It shows a real example.** With the pick, Resolve points to a real, filled-in copy of that component on a real screen. The AI tool clones it and swaps the content, which looks far better than starting from a bare default.
- **It checks the finished screen.** Resolve looks at every piece on the screen and answers pass or fail. It flags parts that are not in the library, parts that are retired, and leftover template text such as "Lorem ipsum". It checks by each component's real Figma id (a hidden number every component has), not just by its layer name (the label you see in Figma's layers list), because a layer called "Button" can be anything.
- **It knows what is retired.** A **retired** component is one your team no longer wants on new screens, although old screens may still use it. Resolve does not recommend retired parts, and flags one if it comes up. A check fails when a screen uses one. It also says what to use instead.
- **It knows your team's words (optional).** If your team says "beneficiary" and the library says "Payee picker", you can teach Resolve that those mean the same.
- **It knows the code twin (optional).** Engineers can write a short file, called a **code map**, that says "this Figma Button is this Button in our code". When it is there, Resolve adds the code component to its answer, for example `PayeePicker from '@acme/payments'`. Resolve never guesses a code twin.
- **It shows what is inside a component.** Ask "what is inside the Payee picker?" and Resolve lists the library parts it is built from (for example Avatar and Button), each with its code component when the code map has one. A part with no code link says so. It never guesses one.
- **It writes the developer handoff (optional).** For a finished screen, Resolve writes one sheet: every component on it, its Figma id, its code (React or another framework), the parts inside it, the check result, decisions the team approved, and open questions. It refuses when the screen still uses a retired component.
- **It checks one component name against that sheet.** A developer types a display name, a component selector, a class name, or an import path. Resolve answers from the saved handoff and the saved code map only. It does not need the learned library. You get one answer: OK (the selector, the module, and the import), retired (and what to use instead), not on this handoff, or on the handoff but not in the code map yet. It never guesses a code twin.
- **It checks a context pack before you commit it.** The pack name is a slug, such as `checkout-summary`. The accessibility level is `wcag-a`, `wcag-aa`, or `wcag-aaa`. The file must not contain a Figma file key or a component id. Every recipe it names must already exist. When something is wrong, Resolve names the field and how to fix it.
- **It knows screen recipes (optional).** A recipe is a checklist of the parts a kind of screen usually needs (header, list, main button, input). Resolve fills each slot with a real component.

Resolve keeps everything it learned in a folder on your computer. This folder is called the **store**. Nothing is sent anywhere. Resolve only talks to Figma when you ask it to read a file.

## Check that a screen uses the library properly

A check already says whether the parts on a screen are real library components. It also says whether they are used properly. The same check does this: `/check`, `resolve check`, and `verify_frame`. There is no extra tool.

On the made-up Acme library, the frame **Misused** (file key `ACMEUSE`) passes the component check and still has proper-use errors. The first line says both. Proper use fails, so the screen is not fine, and the process exits 7. A crowded card keeps every error, then says how to see the rest:

```
FAIL: proper use (5 errors, 7 warnings) · components pass
approved: 4
frame: (name: Misused, type: FRAME, figmaNodeId: 80:1, fileKey: ACMEUSE)
textChecked: n/a
Proper use: 2 detached, 3 hard-coded colours, 2 hard-coded spacing, 1 hard-coded radius, 1 hard-coded effect, 1 contrast fail, 1 tap target, 1 icon-only button, 2 unknown
Errors:
- Button (80:11): This frame looks like Button but is not a library instance. Re-insert the instance.
  component: Button (ACMEUSE, acme-button-set)
- Pasted status (80:61): This frame looks like Status row but is not a library instance. Re-insert the instance.
  component: Status row (ACMEUSE, acme-status-row)
- Hint (80:31): Text contrast is 1.7:1, below 4.5:1 for wcag-aa. Use a darker text colour or a lighter background so the contrast reaches 4.5:1.
- Button (80:41): This control is 20×20, under the 24×24 tap target for wcag-aa. Resize it to at least 24×24.
- Icon button (80:51): This icon-only button has no label or description. Add a text label, or a description a screen reader can read.
+9 more. resolve check --all, or verify_frame all:true
proper-use exit: 7
```

A hard-coded fill on that frame is a warning, not an error: `Fill #1A73E8 is not bound to a library variable or style. Nearest token is color/primary/600.` Resolve only names a token that exists in the library. Warnings alone still start the first line with PASS and name the warning count. A clean Acme frame, **Paid screen**, prints `PASS · Components: PASS · Proper use: PASS` and exits 0. A component list with no frame stays `NOTHING CHECKED` and does not add a proper-use block.

What it looks for:

1. **Detached.** A frame or group that matches a library component by name, or by the same child structure, and is not an instance. High confidence only. The card names the component, its file key and component key, and says to re-insert the instance. A frame named "Buttons", or a "Status row" that already contains the Status row instance, is left alone.
2. **Hard-coded values.** Fills, strokes, effects, and text that are not bound to a library variable or style. Auto-layout padding, gap, and corner radius that match a spacing or radius variable but are not bound to it. Values inside a component instance are ignored unless that instance overrides them.
3. **Property misuse.** A value that is not in the allowed list fails the check. Text left as "Button" or "Label" is a warning.
4. **Accessibility.** Default is WCAG 2.2 AA: text contrast, a 24×24 tap target, and an icon-only button with no label or description. 44×44 is still available with `wcag-aaa` (that level also raises the contrast bar). AA-minimum stays 24×24 with the lower contrast bar. A check that cannot be computed is **unknown**, with the reason. It is not a failure. A Figma metadata capture that has no `boundVariables` says unknown and does not flag colours.

Exit 0 means the check passed. Exit 1 means a component is missing, retired, or not allowed (unchanged). Exit 7 means that component check passed and proper use still has an error. Warnings do not change the exit code.

On the Acme fixture, all 14 findings on Misused are known defects (precision 1). Paid screen has 0 errors. The same file read as Figma metadata, with no binding fields, does not flag a hard-coded colour.

## Check that Resolve understands your words

Designers do not ask for "Button Primary". They say "payee picker" or "6 digit OTP box". Resolve can test itself on phrases like that.

You give it a list of phrases, and for each one the part you expect. Say Acme's library has a part called "Payee picker". Your list could say:

- "payee picker" should find **Payee picker**.
- "choose a payee" should also find **Payee picker**.
- "6 digit OTP box" should find **nothing**, because Acme has no such part yet.
- "old style button" should never offer the retired **Old Button**.

Then run `npm run resolve -- score phrases`. The first lines are the headline, for example "Phrase scoreboard — 118 phrases (88 expected a part + 30 expected empty)" and "top-1 83/88 · top-3 85/88 · empty-correct 30/30 · invented 0 · retired 0". Below that is plain English, then a table by kind of phrase, so you can see which wording it understands least. A part that is made up, or a retired part that is offered, fails the run.

To test your own library, put a `.json` file of your phrases in the `scoreboard/phrases` folder inside your store (`resolve where` prints the store). You do not need to change the Resolve repo. When that folder has phrases, only your phrases are scored. The 118 built-in phrases are written for the sample library, so they only run on it; on your library with no phrases of your own yet, Resolve says so instead of giving a score. The file format is under [score](#score).

Resolve also keeps a list of what designers really asked for that it could not answer well. Each time `recommend` finds nothing, or only a weak match, it adds the ask to `scoreboard/gaps.jsonl` in your store. This file stays on your machine and is not committed. Run `npm run resolve -- gaps` to see the list, most asked first. Say Acme designers asked for "date range picker" four times and nothing was found:

```
Designers asked for 1 thing(s) Resolve could not answer well (4 ask(s) in all). Most asked first.
A part ask needs a team word (synonyms.json), a recipe, or a part the design system does not have yet.

4x "date range picker": nothing found (last 2026-10-07)
```

Each row tells you what to fix: a team word for a part Acme already has, a recipe, or a part the design system team should build. A screen ask such as "approval screen" with no mapped approval screen shows as `no mapped approval screen yet`; checking one real approval frame with `verify_frame` answers it.

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
- **MSOCK:** Resolve as a whole: SOCK knowledge plus SOCI instructions that an AI uses to pick the right component and context for a screen. See [What an MSOCK is](#what-an-msock-is).
- **Phrase finder:** `recommend`, used when the component name is not known. When the name is known, `resolve` answers directly.

## For engineers and testers

Everything below is reference detail: setup options, every command and flag, config files, exact rules, limits, accuracy numbers and version history. You do not need it to use Resolve.

- [Upgrading from the old names](../README.md#upgrading-from-the-old-names)
- [Removed MCP tools](#removed-mcp-tools)
- [Setup in detail](#setup-in-detail)
- [Every command](#every-command)
- [Team config files](#team-config-files)
- [Retired and old components](#retired-and-old-components)
- [Accuracy and honesty rules](#accuracy-and-honesty-rules)
- [Limits: what is not tested yet](#limits-what-is-not-tested-yet)
- [What the AI receives](#what-the-ai-receives)
- [Version history (wiki)](https://github.com/TANISHQBAFNA/resolve/wiki/Version-history)
- [FAQ](#faq)
- [For developers](#for-developers)

### Removed MCP tools

These tools are gone. A call throws one line that names the replacement. The default MCP list is unchanged: `learn_library`, `recipe`, `recommend`, `resolve`, `get_example`, `verify_frame`, `check_cousins`.

| Removed | Use instead |
|---|---|
| `orient`, `query` | `recommend` or `resolve` |
| `path`, `explain` | the why line on a recommend card |
| `check`, `check_frame` | `verify` / `verify_frame` |
| `get_recipe` | `recipe` |
| `find_nodes`, `get_node`, `get_screen_inventory`, `get_component_usage` | `recommend` or `resolve` |
| `get_related`, `get_subgraph` | `recommend` |
| `get_health` | `learn_library` (`list_graphs` still returns the store path) |

`resolve orient`, `query`, `path`, `explain`, and `check` throw the same kind of line.

Context packs stay. `.resolve/context-packs.json` is where a team adds its own words and property hints. They are not deprecated.

`ingredients`, `handoff` (the text printed to the terminal, not the files `--out` writes), `parts`, and `status` print the same Markdown card as the MCP tools, so `/handoff`, `/parts`, and `/resolve-status` read the same as the agent. `--json` is still one compact line for machines. `--pretty` indents that JSON. Exit codes are unchanged.

Where each shared rule lives: [docs/ARCHITECTURE.md](ARCHITECTURE.md#where-a-rule-lives).

### Modes: Figma, code, or both

Resolve has one engine with two workflows. Only the rules for the active workflow are loaded.

| Mode | For | MCP tools | Resource |
|---|---|---|---|
| `figma` | Designing in Figma with real library components. | 8 by default, 18 with `RESOLVE_MCP_ADVANCED=1` | `resolve://figma` |
| `code` | HTML, CSS and JS screens built from the repo's coded components. | `code_scan`, `code_pick`, `code_check`, `code_map` | `resolve://code` |
| `both` | A task that needs both (the `figma` and `code` tools together, 12 by default). | 12 by default | both resources |

`resolve://workflow` is kept as an alias: in `figma` and `code` mode it is that mode's workflow, and in `both` mode it is the core text that points to the two resources.

**How the mode is chosen.** The user's words come first (a Figma file or frame means Figma; HTML, CSS or a prototype means code). Then `RESOLVE_MODE`, then `mode` in `.resolve/config.json`. With neither set, the mode is `both` when `repoPath` is set, otherwise `figma`. If it is still unclear, the AI asks one short question. `resolve mode` prints the mode, where it came from, and the config in use.

**What loads.** A short core is always on: the principles and the workflow choice. The Figma pack and the code pack each have a rule (`rules/resolve-figma.mdc`, `rules/resolve-code.mdc`) and a skill (`skills/resolve-figma`, `skills/resolve-code`) that load on demand. In Cursor the core rule is `alwaysApply: true` and the pack rules are `alwaysApply: false`; Claude Code picks skills by description. The session-start hook adds only the active pack's description.

**Config.** `.resolve/config.json` (all keys optional), with environment overrides:

| Key | Env | Meaning |
|---|---|---|
| `mode` | `RESOLVE_MODE` | `figma`, `code` or `both` |
| `repoPath` | `RESOLVE_REPO_PATH` | The repo (or folder) that holds the coded design system and screens |
| `cssEntry` | `RESOLVE_CSS_ENTRY` | The CSS file that imports the design system, relative to `repoPath`. Without it every `.css` file under `repoPath` is read |
| `theme` | `RESOLVE_THEME` | The token file (or name), relative to `repoPath` |
| `libraryFileKey` | `RESOLVE_LIBRARY_FILE_KEY` | The Figma library file key (Figma workflow) |
| `pairDeny` | `RESOLVE_PAIR_DENY` | Extra component names that never auto-pair on the name alone. `stepper` is always on this list. A real variant, description, or matching base parts still joins. A `deny: true` line in `mapping.json` still beats a confirm |

**Code workflow.** Resolve reads the repo's CSS and builds a catalog: each component (a `building-blocks` or `recipes` folder, or one per CSS file in a flat repo), its variants, real markup, tokens, and the classes marked deprecated (a `deprecated` comment). It is saved to `code-catalog.json` in the store, reused until `repoPath` or `cssEntry` changes or a CSS file is newer, and `scan` keeps any Figma links. `code_pick` returns the classes, modifiers and markup for a need (words are matched by stem, so "deleting" meets "delete"; a small table of related words and intents, such as confirm or delete reaching a dialog or modal, widens the match; a name match counts more than a comment match; ties break by score, then block before recipe, then name); `code_check` reads an HTML file and reports unknown classes, deprecated classes, a modifier without its base class, literal colours and fonts that should be tokens, unknown tokens, and a stylesheet or theme the page does not load. It reads the stylesheets the page links or imports from disk (relative to the HTML file, then the repo) and counts the classes they define separately as project-local, not unknown; a file it cannot find is an info finding. Only `class="..."`, static strings and object keys in `:class`, and CSS selectors count as classes; Alpine expressions, scripts, decimals and file names do not. Resolve only reads; it never edits the repo or the screen.

**Joining Figma and code (both mode).** Names can differ, so a Figma component and a coded component are joined in this order, and the entry records `matchedBy`: (1) `mapped`: the pair is a confirmed line in `.resolve/mapping.json` (a `proposed` line only awaits review); (2) `exact`: the names are equal after ignoring case, spaces, hyphens, underscores and plurals ("Status Pill" = `status-pills`) and one piece of evidence agrees: a specific shared variant or class modifier, a description phrase, or `base/` parts that match the code elements (`tabs` with `base/tab` and `base/tab-item` lines up with `tabs__tab` and `tabs__tab-item`; the block name is removed first, so `base/tab-item` also lines up with `tabs__item`). One non-generic part must match, and a specific part that is missing from the code contradicts the row. A generic state (`disabled`, `hover`, and the same kind of word) is not evidence. A conflicting description is risky and is not a join. Text after `Avoid:`, `Don't use`, `Do not use`, or `instead use` is negative and never counts as agreement. A hyphenated word is one token: `multi-step` does not match `stepper`. `stepper`, plus any name in `pairDeny`, never auto-pairs on the name alone. (3) `alias`: a name or alias on either side equals a name or alias on the other, and only one coded component fits. An alias that fits several coded components is ambiguous and is not joined. Related words (modal, dialog, popup; badge, pill, chip; alert, toast, banner) and shared variant or modifier names only produce *suggested* pairs: `code-map --suggest` or `code_map` with `suggest: true` lists them with a score, and nothing is joined until you confirm it. `code_pick` and `pick` match the names and aliases on both sides, so "status pill" finds the coded `badge`. Rescan keeps the joins and never rewrites the mapping file; editing it takes effect on the next call.

`.resolve/mapping.json` (hand-written, or appended by `code-map --write`):

```json
{ "mappings": [
  { "figma": "Status Pill", "code": "badge", "aliases": ["pill", "status chip"] },
  { "figma": "Dropdown", "code": ["input-field", "popover"] },
  { "figma": "Primary Button", "code": "button" },
  { "figma": "Secondary Button", "code": "button" }
] }
```

Each line can carry a `status`, in the same words `code-map --draft` uses: `proposed` (a draft nobody has reviewed), `confirmed`, or `denied` (the same as `deny: true`). Only confirmed lines join. A proposed line is listed under `awaitingReview` (CLI: `awaiting review`), adds no aliases, and leaves both components unmatched. A line with no `status` counts as confirmed, so files written before states existed keep working. Anything that drafts this file should write `"status": "proposed"`. Any other value is read as proposed and listed as a problem. `code-map --write "Figma=code"` marks a matching proposed line confirmed instead of adding a second line.

`figma` is the Figma component name; `code` is one coded component name or a list (one Figma component to several coded ones); `aliases` are extra names for either side. Several Figma components may point at one coded component. An entry with only `code` and `aliases` adds aliases to that coded component. A name that matches nothing is reported as a problem, and an invalid file is reported and left untouched.

**Reviewed component map.** Put `.resolve/component-map.json` in the design-system repo (the folder `repoPath` points at). Once that file exists, it is the only source of pairs. Resolve does not infer a link on a normal run. Each row names the Figma component (its key or its name), the coded component id, and a status of `confirmed` or `denied`, plus who confirmed it (`by`) and when (`at`, a date). `code-map --draft` runs the matcher and writes `proposed` rows with a tier (`evidence`, `suggested`, or `risky`) and a reason. It never marks a row confirmed. Running it again leaves confirmed and denied rows as they are. Confirm one pair with `code-map --confirm "Button=button"` (or `code-map --write "Button=button"` once the file exists). Deny one with `code-map --deny "Button=button"`. `--who` records the person. `code-map --confirm-evidence` confirms proposed rows whose tier is `evidence`. Suggested rows, and a `risky: same name only` row, stay proposed. A normal run lists Figma and coded components that are not in the map yet as `unlinked, please confirm`, and flags a confirmed row whose Figma side or code side is gone as `stale`. With no component map, joining stays as written above, and the report adds one line: run `code-map --draft`.

A component folder may contain `component.json`:

```json
{ "id": "button", "figma": { "key": "btn-key", "name": "Button" }, "version": "1", "recipes": ["checkout"] }
```

`id` is the coded component name and matches the folder. `figma` needs a key or a name. `version` and `recipes` are optional. Resolve treats that file as a confirmed pair from the source `manifest` and merges it with the component map. A deny in the map wins. If the two name different coded components for the same Figma component, the run reports a conflict and does not pick one.

**Aliases in Figma-side picking (off by default).** Set `RESOLVE_MAPPING_ALIASES=1` and `recommend` reads the `aliases` of each line that has a `figma` name, as a synonym group (`Status Pill`, `pill`, `status chip`), so "status chip" finds Status Pill. Aliases on a line with only `code` are not used. With the switch off, `recommend` is unchanged. This changes ranking, so it needs a fresh blind run before anyone turns it on.

### Setup in detail

The plain steps for Claude Code, Cursor and Codex are under [Install in detail](#install-in-detail). This section adds the options.

**AI install guide.** [`INSTALL-FOR-AI.md`](../INSTALL-FOR-AI.md) is the ordered checklist an AI agent follows (Claude Code, Cursor, Codex). It says: run `resolve-setup`, add the Resolve and Figma servers at project scope, verify with `claude mcp get <name>` or `resolve-setup`, ask before touching home-folder settings, never print tokens, report what changed. Its Codex part is not verified.

**Project files (`resolve-setup`).** It writes the core rule `.cursor/rules/resolve.mdc` and the pack rules `resolve-figma.mdc` and `resolve-code.mdc` (the packs load on demand, so installing both costs nothing until a task needs one), the core skill `.claude/skills/resolve/SKILL.md` and the pack skills `resolve-figma` and `resolve-code`, a marked block in `CLAUDE.md`, the slash commands (`.claude/commands/<name>.md` and `.cursor/commands/<name>.md`, including `/code-map`, `/learn-code`, `/pick-code` and `/check-html`), and adds the `resolve` server (`npx -y -p github:TANISHQBAFNA/resolve resolve-mcp`) to `.cursor/mcp.json` and `.mcp.json`. Run it again any time; it only changes its own block and its own server entry. In the two JSON files it keeps every other key and server, keeps your indentation, and leaves the file alone (with a message) if it is not valid JSON or does not have the usual `mcpServers` object. A different existing `resolve` entry (for example one that points at a local build) is also left alone. `--dry-run` shows what it would do. `--global` writes to `~/.claude` instead (Claude only), writes no MCP file, and does nothing until you add `--yes`. `--force` replaces a file that has no Resolve markers, and replaces only the `resolve` entry in an MCP file. It never writes `~/.claude.json`, `~/.cursor` or `~/.codex`.

**Slash commands, update and uninstall.** Every file Resolve writes (the rule, the skill, each command) carries `<!-- resolve-setup:begin -->` and `<!-- resolve-setup:end -->` around Resolve's text. That marker is how Resolve knows a file is its own. Running setup again rewrites only the text between the markers (anything you add outside them stays), and leaves a file byte-identical when nothing changed. A command file that has no markers, for example your own `.claude/commands/find.md`, is kept as it is: setup prints `skip ... (kept your own file ...)` and carries on; `--force` replaces it. `CLAUDE.md` is handled the same way, using the same markers around one short block. `--uninstall` removes only Resolve's marked blocks, then a file that has nothing else in it, and the `resolve` entry of `.mcp.json` / `.cursor/mcp.json` when it is exactly the one setup wrote (other servers stay). Files without markers are never touched. `--uninstall --dry-run` lists what it would do; with `--global` it needs `--yes`. Claude Code commands go in the project (`.claude/commands`), next to the project's `.mcp.json` and skill, so they are shared with the team and removed with the project; `--global` puts them in `~/.claude/commands` instead. A command is not a skill: a command runs only when you type it, a skill can be picked by the AI tool on its own. Over MCP the same commands are prompts (`prompts/list`, `prompts/get`, argument `input`); prompts are not tools, so the tool count does not change. A command that runs the Figma command line (`/parts`, `/handoff`, `/resolve-status`) calls `npx -y -p github:TANISHQBAFNA/resolve resolve-figma ...` in your project folder, so it reads the same store as Resolve's MCP server. It reads `~/.claude.json` read-only, only to see whether a Figma server is listed (for `Figma connected?`); it never prints that file.

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

The first file you ingest is the library by default. Later files default to `product`. Full details: [`docs/SETUP-MCP.md`](SETUP-MCP.md).

**Where the data lives.** In a store folder: `RESOLVE_HOME` if you set it, otherwise the nearest `.resolve/` folder going up from where you run that holds `graph.json`, `workspace.json`, `code-map.json`, `context-packs.json`, or `code-catalog.json`. A folder with only the code map or only the context packs is still the store. (For older setups see [Upgrading from the old names](../README.md#upgrading-from-the-old-names).) The AI tool's MCP server and your command line must use the same folder. `resolve where` prints it.

### Every command

In a checkout of this repo, run commands as `npm run resolve -- <command>`. The installed package exposes the same command line as `resolve` and `resolve-figma`. The examples use a pretend Acme library with a "Button" set, a "Text field" set, "Payee picker", "Avatar", "Payment method row", and a retired "Old Button", plus screens such as "Send money". To follow along, use the made-up library in this repo, [`docs/examples/acme-ui.json`](examples/acme-ui.json). Its "Send money" screen (a frame) holds one Payee picker, one Button and one Old Button, which is retired (its description says `status: deprecated` and `replacedBy: Button`):

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
| `brief "<screen request>"` | Asks at most 3 multiple-choice questions before a screen is picked, and only when the request fits and the answer would change the component. States can take more than one answer. Nothing that fits says "No match." `--answer shape=table` (topics: shape, states, platform). |
| `recommend "<intent>"` | Ranked library components for a plain-words ask. `--answer <topic>=<option>` uses a briefing answer. |
| `spec <spec.md \| ->` | Maps a Figma spec to library components. See [Figma specs](#figma-specs). |
| `pick <request.json>` | Checks one AI pick. Off unless `RESOLVE_AI_PICKS=1`. When off, it says to use `recommend`. |
| `example "<name>"` | The real, filled-in instance behind a pick, to copy. |
| `resolve "<name>"` | "I know the name, give me the id." |
| `verify "<frame>"` | Pass/fail check of a drawn frame or a list of components. |
| `ingredients "<name>"` | What is inside a component: its parts, each with its code component or "no code link yet". |
| `handoff "<frame>"` | One sheet a developer can build a screen from: recipe slots, every placed component with its Figma id and code, the parts inside, verify, decisions and open questions. Refuses a screen with a retired component, or with layer-name guesses or missing components unless `--draft`. |
| `code-map [--json \| --retired \| --pairs \| --unmatched \| --suggest]` | One command for the Figma-to-code map. The report lists imports and selectors. `--retired` lists retired parts with their code and replacement. `--pairs` and `--unmatched` show how Figma components and coded components join (mapped, exact, alias) and what is unmatched on each side. `--suggest` adds likely pairs; a likely pair is not a link. `--write "Figma name=code[,code]"` appends confirmed pairs to `.resolve/mapping.json` until a component map exists, then it confirms that one pair in the component map. `--draft` writes proposed rows (evidence, suggested, or risky) into `.resolve/component-map.json` and never marks them confirmed. `--confirm "Figma=code"` and `--deny "Figma=code"` review one row. `--confirm-evidence` confirms proposed rows whose tier is `evidence` and leaves suggested and `risky: same name only` rows proposed. With the component map present, the run links only confirmed rows and `component.json` manifests, and reports `unlinked, please confirm` and `stale`. Without it, joining is unchanged and the report says to run `--draft`. `--init` writes a spreadsheet (CSV) to fill in; `--import <file.csv>` turns it into the import map (`--force` keeps entries the CSV has no row for, `--replace` drops them). A broken `code-map.json` is not overwritten. `--check "<name>" [--handoff <handoff.json>]` answers from the committed handoff and code map only (no learned cache). `--handoff` defaults to `./handoff.json`. `scan`, `suggest`, and `review` read a component package, propose pairs, and confirm them. |
| `pack validate [path]` | Checks a context pack: slug id, known accessibility level, recipe ids that exist, and no Figma file key or node id. |
| `rules` | Lists the bind rules people wrote. |
| `soci` | Lists pending SOCI proposals (suggested rules and recipes). |
| `approve <id> --who <name>` / `reject <id> --who <name>` | A person says yes or no to a proposal. |
| `cousins "<frame>"` | Finds look-alike copies of library parts in product files. Needs a frame name, or `--components a,b`. |
| `workspace` | Linked files and store location. |
| `mode` | The active mode (`figma`, `code`, `both`), where it came from, and which packs are on. See [Modes](#modes-figma-code-or-both). |
| `code scan [--repo <folder>] [--css <entry.css>] [--theme <file\|name>] [--figma <masters.json>] [--list] [--json]` | Reads the repo's CSS and saves the code catalog. Code and both modes only. |
| `code pick "<need>" [--limit <n>] [--json]` | The coded components, classes, modifiers and markup for a screen need. |
| `code check <file.html> [--json]` | Checks an HTML file against the catalog. Exit code is 1 when there are errors. |
| `npm run size` | Line count per area (code engine, rest of server, Figma core) with each share; fails over the limits in `resolveSizeBudget` in `package.json`. |
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

A recipe is a list of slots (header, line list, primary action, input). Each slot is filled with a real component from your library, or is marked `unbound` or `missing`, with the next `recommend` to run. It never invents an id. Your own recipes go in `.resolve/recipes.json` and win over the built-in ones. See [`docs/RECIPES.md`](RECIPES.md).

`recipe "<screen with parts>" --compose` builds a recipe when no saved one fits: one slot per part you name, each filled by `recommend`. A part with no fit says No match. Fewer than 2 fitting parts is not a recipe. Nothing is saved; `--propose` files a proposal, and a person's `resolve approve` adds it to `.resolve/recipes.json`. MCP: `compose: true` on `recipe`, advanced surface only.

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

The name or words in the ask come first (exact name, word match, synonym). Screen and usage only break ties. The structured card is at most 600 characters (`cost.chars` is that card without the `cost` field itself; the CLI still prints `cost`). The MCP tool sends Markdown instead, which is shorter and leaves out `cost`, the rank `score`, a duplicate `node:` id, and the "Do not Read graph.json" sentence. Pass `format` `json` for the same card as one compact JSON line. See [What the AI receives](#what-the-ai-receives). The `code` line appears only when your team filed a code map, the top pick is mapped, it is a good match and not retired, and the line fits in 600 characters without dropping a candidate; otherwise it is left out without a message. Nothing matches? You get an empty list and "No master matched. Do not invent." (When a code map exists and the only match is retired, the hint says `Only match is retired: <Name>. Use <replacement or none>.` instead.) A loose match carries "Weak match." and up to three parts instead of one confident guess. Options: `--budget <chars>`, `--pack`, `--product`, `--journey`, `--domain`, `--audience`, `--a11y`, `--screen-type`. `--a11y AA` is stored as `wcag-aa`. `--pack` is optional. A pack is used only when its product matches exactly, and its journey matches when you also pass one. An unknown pack name, or a pack for a different product than `--product`, is a plain warning and the document fields are what the card shows. Audience, a11y, and density are shown and do not change the pick.

#### pick

Off unless `RESOLVE_AI_PICKS=1`. That environment variable is the only switch. `resolve pick` needs a repo checkout for now, because an installed package does not include the meaning files. The request is JSON with `library`, `ask`, `shortlist`, `pick`, `props`, `reason`, and `tier` (`place`, `ask`, or `no-fit`). Property values are strings, written as listed. A reason passes when it is a span of at least 3 words and 12 characters from one sentence of the description or the guidelines, or an exact whole line that is not the component name and not an alias, or the exact sequence of the name, one property, and one listed value. A span has to contain a word that is not a stopword, and it cannot cross a sentence, a line break, or include a link. A bare name is a reason only when the file has no description and no properties; that pick is `ask`, flagged name-only, and left out of the library-quote count. An alias is rejected. The pick has to be in a shortlist of 1 to 3 distinct index ids. A failed check comes back as no fit and exits 1. A correct `ask`, including a thin component capped from `place`, exits 0. The result lists every thin component and the field it is missing, and warns when the library is newer than the meaning files (`--library-built-at`). A name-only pick's own thin entry carries `nameOnly: true`, and the eval score's thin description list marks it `name-only`. The mark lives in the pick result and the score only. It is not in briefing cards or decision records.

A shown pick also carries `shortlist` in the result: the pick first, then up to two neighbours chosen by Resolve from the meaning files, not by the model. The same ask and pick always give the same list. Resolve scores each other part by the words it shares with the ask and with the pick, adds a small bonus for a part the model also offered, and breaks ties by name. The request still needs its own `shortlist` that includes the pick; it is checked, and it feeds that bonus. This changes which parts count toward top-3, so it needs a fresh blind run before AI picks are switched on.

Blind prompts for the eval are not committed. Generate them with `node scripts/ai-picks-eval.mjs prompts --out <dir> --id-map <file outside the repo>`. The id map is refused when its real path (symlinks followed) is inside the repo.

#### Figma specs

A Figma spec is a document of Markdown in a Figma file. Resolve does not call Figma, so the agent reads the spec and hands Resolve the text: with the Figma plugin API, `figma.spec.getContent({ specNodeId })` returns `markdown`, and that goes to `resolve spec <file>` (or `-` for stdin). The agent checks first, as Figma requires, that the file's plan has Specs turned on.

`resolve spec` reads each list item, table row (the longest cell) and sentence, skipping code blocks, comment markers and header rows. It echoes the context the spec states and nothing else: `Product`, `Journey`, `Audience` and `Accessibility` lines, with a WCAG level written as `wcag-a`, `wcag-aa` or `wcag-aaa`. A field the text does not state stays off, so the agent passes on only what the document says.

Each line then goes through the same ranking as `recommend`. A long sentence that finds nothing is retried on the phrase before its first clause word ("A dialog that asks the user to confirm" is ranked as "A dialog"), and the row says which phrase was ranked. Every row has one status:

- **mapped**: a real component with its `figmaNodeId` and `fileKey`, plus up to two alternatives.
- **weak**: a low-confidence match. Check it before placing.
- **no match**: nothing in the library fits, or the line is not a screen part. Check it; never invent a component.
- **not on screen**: lines about dates, speed, audit or people (a short cue list). Listed with `--all`.

`--json` prints every row with its status. The same text and library always give the same rows. The MCP version is `spec_map` (advanced set): pass `markdown`, and `all: true` for the not-on-screen lines. The slash command is `/spec <Figma link to the spec>`; it checks `whoami` for `specs_enabled`, reads the spec, and runs this command.

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

Checks a frame, or a list of component names/ids, after drawing. JSON `pass` is true only when the verdict exit code is 0. A proper-use failure (exit 7) starts `FAIL: proper use … · components pass`, and JSON `result` is `proper_use_failed`. JSON `pass` is false. A component pass still needs at least one placed piece checked by its own component id or key and nothing failed. It reports `invents` (not in the library), `deprecated` (retired parts), `unresolved` (with a "did you mean"), bind-rule misses, lorem-ipsum filler, and leftover template text. Matching by layer name alone is labelled `name-only` and is not a pass. With `--components Button,Gold`, "Gold" is reported as an invent because there is no such component. A failed component check exits 1. A component check that passed, with a proper-use error still on the frame, exits 7. See [Check that a screen uses the library properly](#check-that-a-screen-uses-the-library-properly).

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
    "retired Old Button -> use Button"
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
Retired: Old Button [ACMEUI 30:50] -> use Button
```

**Fill the map from a spreadsheet.** Hand-editing JSON is not needed:

```bash
npm run resolve -- code-map --init                       # writes code-map.csv next to code-map.json
npm run resolve -- code-map --import code-map.csv --dry-run   # shows the JSON it would write
npm run resolve -- code-map --import code-map.csv        # writes code-map.json
npm run resolve -- code-map --import code-map.csv --force   # updates an existing code-map.json
```

`--init` writes one row per library component (`fileKey`, `id`, `name`, then the columns to fill: `component`, `importPath`, `framework`, `selector`, `module`, `standalone`, `inputs`, `outputs`, `status`, `replacedBy`). Rows the map already knows come filled in. `--import` skips rows with no `component` and no `importPath`, checks every other row with the same rules as the map itself, and writes nothing if any row is wrong. It lists them by spreadsheet row, counting blank rows, for example `row 5: importPath must be a package path like @acme/ui`. The `name` column is kept with the id, so `code-map --check` knows the design name. Columns Resolve does not use (`notes`, `owner`, ...) are ignored, and the output names them. List several `inputs` or `outputs` with spaces or commas; the alias form `label: ariaLabel` is kept as one input. A filled-in example is [`docs/examples/acme-code-map-selectors.csv`](examples/acme-code-map-selectors.csv). `--init` does not replace an existing CSV unless you add `--force`.

**Updating an existing map.** `--import` does not touch an existing `code-map.json` unless you say how:

- `--force` updates it and keeps every entry the CSV has no row for (entries for another file, hand-added or stale entries), and lists them: `Kept 2 existing entries the CSV has no row for (use --replace to drop them): OTHERLIB 1:1, ...`. This is the safer choice, so nothing is lost without a word.
- `--replace` writes only the CSV's entries, and lists what it dropped.
- Either way, a filled row replaces the old entry for that component, and a row you emptied removes it. Both are listed (`Replaced ...`, `Removed ...`), so every old entry that is not written back as it was is named. `--dry-run` shows the JSON `--force` would write.
- A row and an old entry are the same component when they have the same file key and id. An old entry with no id matches a row of the same name in the same file; an entry with no file key and no id (name only) matches a row of that name in any file. An entry for another file, or with a different id, is never matched by name alone, even when the names agree.
- A header that names a column twice (`component` twice), or an unnamed column that holds values, is refused. Unknown `code-map` options are refused too.
- `--import` refuses a `code-map.json` that is not valid JSON, or that has no `entries` list. Nothing is written, so a broken file is not replaced by the CSV.

#### Pairs and unmatched

`code-map --pairs` prints the import map, then each join between a Figma component and a coded component (`mapped`, `exact`, or `alias`). `--unmatched` lists Figma components with no coded match and coded components with no Figma match. `--suggest` adds likely pairs and prints all three sections. A likely pair is not a link. A same name with no evidence is printed and returned as `risky: same name only`. Confirm one pair with `code-map --write "Figma name=code"`. With no component map, that appends the pair to `.resolve/mapping.json`, and a batch of `--write` pairs confirms evidence rows only. `bulkConfirm` lists those rows and never includes a suggested row. When `.resolve/component-map.json` is present, that file is the only source of pairs: the report lists `unlinked, please confirm` and `stale`, and does not guess. `--json` is one object with `imports`, `pairs`, `unmatchedFigma`, `unmatchedCode`, and, when you asked for them, `suggestions` and `bulkConfirm`.

The shell spelling `code map` still runs. It prints one notice (`Deprecated: code map. This will be removed after a quarter. Use code-map.`) and then the same report as `code-map` with the same flags. `code map` alone matches `code-map --pairs --unmatched`.

#### Scan, suggest, review

These three commands extend the map. They do not replace `--init` or `--import`.

```bash
npm run resolve -- code-map scan fixtures/acme-ui-angular
npm run resolve -- code-map suggest fixtures/acme-ui-angular
npm run resolve -- code-map suggest fixtures/acme-ui-angular --write
npm run resolve -- code-map review
npm run resolve -- code-map review --import code-map-review.csv
```

`scan` reads one component package and prints an inventory. It uses the TypeScript compiler API on the compiled `.d.ts` files (`ɵɵComponentDeclaration`: selector, inputs, signal inputs, outputs, standalone). A component that is not in those files is read from the `@Component` decorator in source. Selectors can be an element (`acme-button`), an attribute (`button[acme-button]`), or a class (`.acme-card` or `.x`). Two classes with the same selector are both kept, and each names the other as a selector conflict. The plain `code-map scan` listing says `selector conflict:` for those classes. `--json` includes `selectorConflict`. The same inventory is what `suggest` uses. `scan` does not write the map.

`suggest` pairs each learned Figma component with a scanned code component when the names match as whole words (Acme and the words Component and Directive are ignored), and when the Figma properties line up with the inputs. A shared run of letters is not a match: Harbor does not match Harborview. A match that only exists by stemming, by adding a word such as button, or by a shared family prefix is `partial`, never `suggested`. Two exact names of the same strength, such as an Acme class and a decoy, are both `partial` and neither is `suggested`. A part that contains another part can also be "composed of" that part's code, and only when that inner part was `suggested`. One Figma component can link to more than one code component, and one code component can link to more than one Figma component, when each row sets `relation` to `maps` or `composed-of`. Every proposed pair is `suggested`, or `partial` when the name is only close or a Figma property has no input. Neither is a code twin. `--write` saves them and keeps rows you already confirmed.

`review` writes a CSV of the rows already in the map. Set `status` to `mapped` on the rows you confirm, then `--import` that CSV. A blank status stays `suggested`. Only `mapped` (and the older word `current`) is a code twin. Entries the CSV has no row for are kept and listed. `--replace` drops them and lists them.

**Statuses.** `mapped`, `suggested`, `partial`, `unmapped`, `retired`. `current` still means `mapped`. `/parts` and `/handoff` show a code line only for `mapped` or `current`. A `suggested` or `partial` row is not used. An unmapped part means stop and ask.

**Versions.** Each entry can store `figmaVersion` (the learned library's Figma version) and `packageVersion` (the component package version). The map file can store the same two at the top. When the learned library version changes, or the package version on the file changes, `code-map` lists those entries under `Needs re-review`. They stay mapped until someone reviews them.

**Fixture.** `fixtures/acme-ui-angular` is a small made-up package (precision 1, recall 1, 9/9). `fixtures/pr63-edge` is the larger one: 49 hand-labelled pairs, a second package, and noise classes. On that key, `suggested` pairs score precision 1 and recall 43/49. `partial` pairs score precision 5/6 and recall 5/49. Pagination is not matched to Paginator. Avatar is `partial` for both the Acme class and the unprefixed class, and neither is `suggested`. Accepting every `suggested` row makes 0 wrong mapped links. A retired part is not suggested and never shows its old code. The suite checks that bar.

`--retired` prints every retired part and its replacement, one per line (`Retired: 1`, then `Old Button [ACMEUI 30:50] -> use Button`). The retired part's own code is not shown. `--json` prints the same data with the same keys whether or not there is a map (`configured` is `true` or `false`; the lists are `unmapped`, `ambiguous`, `conflicts`, `retired`, `stale`, `replacements`, `ignored`). Two keys appear only when the map has selector entries: `angular` (the selector counts) and `angularIgnored` (entries whose selector fields were dropped). A part with a bad `replacedBy` is listed under `Bad replacedBy` / `replacements`. Details are in [`code-map.json`](#resolvecode-mapjson--figma-to-code-twins) below. With no map, it prints `No code map. Add .resolve/code-map.json next to synonyms.json.`

**Check one name without the learned library.** `code-map --check` reads two committed team files only: the handoff sheet (`resolve handoff --out`) and `code-map.json`. It does not read `graph.json` or any other cache, and it never guesses a code twin. It matches the handoff part's file key and node id to the code-map entry with that same key. A shared package path is not a match. An import line matches only when the name in the braces is that entry's component or module. A display name on the sheet (letter case ignored) uses that part's file key and node id. A display name in the code map (`name`, for example `Old Button`) matches too, so a retired part is refused by the name designers use. Pass a display name, a component selector, a class name, a module name, or an import line. An HTML tag such as `<button acme-raised-button>` matches a selector only, never a display name, so it is `not-found` unless a code-map selector is that tag. A recipe slot counts as on the screen only when its part is placed. A part with no code twin is `unmapped` when it is from the same library and `other-library` only when it is from another one.

```bash
npm run resolve -- code-map --check "AcmeOldButtonComponent" --handoff artifacts/acme-142/handoff --json
```

`--handoff` is optional. It is the `handoff.json` file or the folder that contains it. If you leave it out, Resolve looks for `handoff.json` in the current folder. One answer, and the plain sentence a designer can act on:

| Answer | Exit | Sentence |
| --- | --- | --- |
| `ok` | 0 | `Button. Use \`<acme-button>\` (AcmeButtonModule).` A standalone component says `(standalone)`. A React entry says `Button. Use Button from '@acme/ui' (React).` |
| `retired` | 2 | `Don't use. Use Button.` When the replacement is itself retired, or the chain loops, the sentence is `Don't use. There is no current replacement.` |
| `not-in-handoff` | 3 | `Real component, but not on this screen. Ask the designer.` |
| `unmapped` | 4 | `On the screen, no code yet. Build it or ask.` |
| `not-found` | 5 | `Not in the design system or on this screen. Don't invent it.` |
| `other-library` | 6 | `On the screen, from another library, no code twin.` |
| `error` | 1 | The name was empty, the handoff is a draft, or the handoff or code map is missing or not valid JSON. A draft says `This handoff is a draft, not for a build. Run resolve handoff again without --draft.` |

`--check` treats a part as retired only when the code-map entry says `status: "retired"`, or the handoff sheet itself marks that part retired. It does not use the learned library's retired flag. `code-map --retired` does. Leave `status` off and the check treats the part as current, unless the sheet says retired.

On the shipped map [`docs/examples/acme-code-map-selectors.json`](examples/acme-code-map-selectors.json) (file key and id only, no display names): `AcmeOldButtonComponent`, the selector `acme-old-button`, and that component's import line are retired, and the sentence is `Don't use. Use Button.` `OtherButton` is not on that map, so the check answers not-found. A part on the handoff whose `code` is `"unknown"` or missing is `other-library`.

`--json` prints one object. The fields are always `ok`, `status`, `query`, `message`, `exitCode`, `codeMapPath`, and `handoffPath`. When a code-map entry matched, it also has `component`, `import`, `matchedBy` (`name`, `selector`, `class`, or `import`), and `selector` and `module` when the entry has them (`standalone: true` instead of `module` when the component is standalone). `use` is present only for `retired`, and it is the replacement name (`Button`). `unmapped`, `other-library`, and `not-found` do not include `selector`, `module`, or `import`. With `--json`, an empty name or a missing `--handoff` value is still JSON. A missing or broken file is `status: "error"` with a plain `message`, never a stack trace. A skipped code-map row names the entry and why it was skipped.

#### pack validate

```bash
npm run resolve -- pack validate
npm run resolve -- pack validate .resolve/context-packs.json --json
```

Checks the context pack file (`.resolve/context-packs.json` when you do not pass a path). The pack `id` must be a slug (`checkout-summary`). `constraints.a11y`, when set, must be `wcag-a`, `wcag-aa`, or `wcag-aaa` (`AA` is accepted and stored as `wcag-aa`). Every `recipeIds` entry must be a recipe id that exists (starter recipes plus `.resolve/recipes.json`). No Figma file key, Figma link, token, or node id may appear anywhere in the file, including a key named `figmaNodeId`, `file_key`, or `figmaLink`. A clock time (`9:30`) or a common ratio (`16:9`) is not a node id. `files` is a workspace label, not a file key. Errors name the field and how to fix it, and a long list ends with how many more were cut. An unknown field is a warning. Exit 0 when there are no errors (warnings are fine). Exit 1 when there are errors. A folder, an empty file, and a file that cannot be read each get their own sentence.

`--json` is `ok`, `path`, `packs`, `message`, `exitCode`, `errors`, and `warnings`. Each error or warning is `{ "field", "message", "pack" }` (`pack` is the pack id when that id is text). Loading a pack for a command does not use this strict check. A bad pack, or just the bad field, is skipped, with one warning for that file. Commands keep working. Ranking of a pack that loads is unchanged. Audience, a11y, and density are echoed and do not change the pick.

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
- **Code.** Each part shows its code component from your code map, or `no code link yet`. With no code map at all, it says so. The header shows the file key and node id (`[ACMEUI 30:30]`). For a selector entry the part also shows its selector and module (`<acme-button>, AcmeButtonModule`), and the header adds a line with inputs and outputs (see [Selector entries](#selector-entries)).
- **Swaps inside a component.** A component's own card reads the copies placed inside it too, so a swap made inside the component (for example a different icon in each of five buttons) shows as it really is. When copies of one part differ, each kind gets its own line marked `1 of 5 copies` (and so on) and `insides differ between copies`; at the last level shown the line names what that copy holds. Where the copy inside a component has no learned insides, its parts come from its main component and say `from the main component, not checked on the copy inside this component`.
- **Honest labels.** A retired part does not show its old code. It names what to use instead, with that part's code when the map has it (`retired; use Button (code: Button from '@acme/ui')`). A part known only from its layer name is marked `guess from layer name, not confirmed`. A part from a library file you have not learned says so; if you have learned that library, Resolve finds the real part by its published component key. A copy whose component is missing is `component not found`.
- **Names.** Exact name (letter case ignored) or id only. Anything else says "Nothing named ..." and exits with an error; use `recommend` to find the name first. A name or a bare node id found in two learned files is listed, not picked; ask again with `fileKey:nodeId`.

`--json` prints the card as data (`parts`, each with `status`: `current`, `retired`, `unconfirmed`, `other-library` or `not-found`, `code` or `null`, and `use` / `useCode` for a retired part; `angular` for a selector entry; `useAngular` for a retired part's replacement; `insideFrom` marks insides read from the main component). `--all` counts the whole library: how many components are built from other parts, and how many of those parts link to code. The MCP version is `get_ingredients`. It is off by default, so the default agent tool list stays at eight; set `RESOLVE_MCP_ADVANCED=1` to turn it on. Over MCP a card larger than 12,000 characters is cut so it does not flood the agent: it is shown one level less deep at a time, then with fewer parts per level, and `cut.reason` says what was left out (ask a part by name for its own card). The command line always prints the whole card.

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
  - its code from the code map: the React import, or the component selector, module or standalone, inputs and outputs. A component with no map entry says `unmapped`; code is never guessed.
  - the Figma variant properties. When the code entry has an input of the same name, it suggests the value (`Variant=Secondary` becomes `variant="secondary"`) and a one-line template. If the selector pins that attribute to another value (`acme-button[variant="primary"]` on a Secondary copy), no value is written for it and an open question says "the selector only matches variant="primary"; this copy is Secondary". For example for example `<acme-button variant="secondary" size="medium" [disabled]="…" (pressed)="…"></acme-button>`. An input paired with an `...Change` output is shown as `[(selected)]`. Both are labelled "suggested".
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

A refused handoff writes nothing and exits with an error. On the Acme sample, `handoff "Send money"` is refused because of the retired Old Button. With that copy swapped for Button, it exports cleanly; the golden output is in [`tests/fixtures/handoff/send-money.md`](../tests/fixtures/handoff/send-money.md).

Without `--out` it prints the sheet (`--json` prints the data). `--out <dir>` writes `handoff.md` (an index), one `screen-<name>.md` per screen, `ingredients.md` (every part across the screens) and `handoff.json`. If the folder already holds any of these files it refuses unless you add `--force`; with `--force`, older `screen-*.md` files from an earlier handoff there are removed (and listed). Other files in the folder are left alone. A path that is a file, or a folder you cannot write to, gives a one-line error. `--out` also writes `decision.json` and `decision.md` next to the handoff: what was asked, which parts were picked and why, what was rejected, and the recipe (see [Decision records](#decision-records)). `--no-record` skips them and removes an older pair from that folder. A screen found by a loose name match (not its exact name or id) says so at the top. Names from Figma are escaped in the markdown, so a name cannot add links or HTML.

A screen that is one placed copy (for example a page shell shared as the screen) is its own single component, with everything on it listed as its parts. The MCP version is `get_handoff`; like `get_ingredients` it is off by default (`RESOLVE_MCP_ADVANCED=1`). Over MCP a handoff larger than 40,000 characters lists its parts one level less deep at a time until it fits; the open questions and the summary still come from the full sheet, and `cut` says how many parts are listed (`35 of 62 parts are listed`). A `depth` that is not 1, 2 or 3 is clamped, and `depthNote` says so.


#### Decision records

A decision record says what Resolve was asked, which parts it picked and why, and what it rejected. It only reports what the result already said. It never ranks or picks anything itself, and every picked id is a real part from the learned files.

- `handoff --out <dir>`: always writes `decision.json` + `decision.md` next to the handoff (`--no-record` to skip).
- `brief "<request>" --record <dir>` and `recipe "<screen> with <parts>" --compose --record <dir>`: write `decision-brief` or `decision-compose` `.json` + `.md` there. Without `--record` nothing is written, and the printed answer is the same. An existing record there is not replaced without `--force`. A folder that cannot be written is an error that names it (`ok:false` with `--json`).
- MCP (advanced): `record: true` on `brief`, `recipe` (with `compose`) and `get_handoff` stores the record in `.resolve/decisions/<kind>-<words>-<hash>.json` (unique per record) and adds only its path as `decisionRecord`. `decision_record` with no `ref` lists them; with `ref` it reads one: a name from that list, or a `decision*.json` path. Anything else is refused, and the file is checked against the record schema.
- `resolve decisions [--json]` lists the stored records.

Fields (`schemaVersion` 1): `kind` (brief, compose, handoff), `createdAt`, `request` or `screens`, `context`, `asked`, `answers`, `assumptions`, `skip`, `picks` (name, ids, `source`, `match`: fit, bound, placed, to-add, weak, name-guess; `why`, `slot`, `screen`), `rejected` (what and why: weak, no match, retired, not a library component), `recipe` (saved, composed, matched or asked; proposal id), `readAsContext`, `openQuestions`, `next` (brief's compose offer or saved recipe).

Follow-up, not in this version: an approved record does not yet skip future brief questions.

#### rules, soci, approve, reject

```bash
npm run resolve -- rules
npm run resolve -- soci
npm run resolve -- approve <proposal-id> --who "Priya"
npm run resolve -- reject <proposal-id> --who "Priya"
```

`rules` lists human-written bind rules (must use / must not use / prefer; see [`docs/BIND-RULES.md`](BIND-RULES.md)). `soci` lists suggestions made from real use. Nothing is ever applied automatically. `approve` and `reject` record who decided (see [`docs/SOCI.md`](SOCI.md)).

#### cousins

```bash
npm run resolve -- cousins "Send money"
npm run resolve -- cousins --components Button,Avatar
```

A "cousin" is a product file's own copy of a library part, such as a hand-built "Price" next to the library's "Price". Needs a frame name or `--components a,b` (with neither it prints a usage line and exits with an error), and a library-role file in the workspace. When unsure it says so.

#### status, workspace, where, list, reindex, rm

```bash
npm run resolve -- status       # learned files, when, version, token, always-on rule, code map, next step (--json for data)
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

The headline number is `npm run resolve -- score phrases` (designer phrases). The command above is the golden set, a secondary regression check on 75 cases. It scores the library that is in the store, so ingest the sample library first (as above); on an empty store, or on a library without the parts the set asks for, it stops with an error. `--workspace <name>` is only the name the run is saved under (`RESOLVE_HOME/scoreboard`). It exits non-zero if anything was invented or a card is over its size. `npm run resolve -- score --init` writes a starter set from the library you already learned. See [`docs/SCOREBOARD.md`](SCOREBOARD.md).

`npm run resolve -- score phrases [--phrases <path>] [--json]` is the headline scoreboard. It scores designer-worded phrases against `recommend` and prints top-1, top-3, empty-correct, invented, and retired first. It reads the team's own `<store>/scoreboard/phrases/*.json` when there are any. Otherwise it reads the built-in `scoreboard/phrases/*.json` in the checkout, but only when the store holds the sample library (`scoreboard/fixture`); on any other library it stops and asks for team phrases. The two sets are never added together. `--phrases` reads only that path. `score phrase` and `score Phrases` work too; any other word after `score` is an error. Each phrase has an `id`, a `phrase`, a `type` and an `expect`: part names, `"none"`, or `"weak"` (empty, or a pick named in `accept`). The detail table also reports false-empty and wrong-cousin, per type. It exits non-zero on any invent or retired-recommended. A phrase naming a part the library lacks is skipped and listed, and a run where nothing could be scored fails. Details in [`docs/SCOREBOARD.md`](SCOREBOARD.md#designer-phrase-set).

`npm run resolve -- gaps [--json]` lists what designers asked `recommend` for (MCP tool or CLI) that came back empty or as a weak match, and screen asks with no mapped screen of that job, from `<store>/scoreboard/gaps.jsonl`. The same ask, ignoring letter case and spacing, is one row with a count and the last date, most asked first. `score phrases`, `recipe` and `resolve` do not add to it. Writing the file never fails a `recommend`. The file is under `scoreboard/`, which the `resolve-setup` ignore block already keeps out of git. Delete it to start over.

#### The MCP tools: 8 by default, 17 with the advanced set

This is the Figma mode. Only the active mode's tools are offered: `code` mode offers `code_scan`, `code_pick`, `code_check` and `code_map` instead, and `both` offers all 12 default tools. See [Modes](#modes-figma-code-or-both).

The same abilities are offered to AI tools as 8 MCP tools by default: `learn_library`, `recipe`, `brief`, `recommend`, `resolve`, `get_example`, `verify_frame` and `check_cousins`. Set `RESOLVE_MCP_ADVANCED=1` for 9 more (17 in all): `list_soci`, `approve_proposal`, `reject_proposal`, `list_recipes`, `get_ingredients`, `get_handoff`, `list_graphs`, `spec_map` and `decision_record`. They return the same cards as the command line. `get_ingredients` (see [ingredients](#ingredients)) and `get_handoff` (see [handoff](#handoff)) are in the advanced set. `code_map` is the one map tool, on the code workflow: pairs, unmatched, `suggest`, and `action` `scan`, `suggest`, or `review`. `code_map_scan`, `code_map_suggest`, and `code_map_review` still run when the advanced switch is on and say to use `code_map`. The [slash commands](#slash-commands-in-detail), including `/code-map`, are also offered as MCP prompts (`prompts/list`, `prompts/get`); prompts are not tools and do not change the count.

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
- **`status`** is `mapped`, `suggested`, `partial`, `unmapped`, or `retired`. `current` still means `mapped`. If you leave it out, Resolve uses the library's own flag for retired, and otherwise treats the row as mapped (see the next section). `suggested` and `partial` are not code twins. `relation` is `maps` (the default) or `composed-of`. `figmaVersion` and `packageVersion` record what the row was checked against. `replacedBy` is optional: the Figma name or id of the part to use instead. It must be a current component or set in the library. A variant (for example `size=small`) or a stub (an empty placeholder from another file) is refused, and `code-map` says so under `Bad replacedBy` (`replacedBy is a variant`, `replacedBy is a remote stub`). If a real set and a stub share the name, the real set is used. If that part is itself retired, Resolve follows its `replacedBy` (at most 3 steps, never in a circle) to a current part. If it finds none (unknown name, a variant or stub, two real parts with that name, the part itself, a circle, or a chain that is too long) it says "no current replacement" and `code-map` lists the entry under `Bad replacedBy`. Resolve never points at a retired part.
- **Two entries for one component** are not settled by file order. If one says current and the other says retired, the current one wins, and the clash is still reported: the part is listed under `conflicts` ("retired and current entries; the current one is used") and one line is printed on stderr (once per run). If both say the same thing, they merge. If they disagree otherwise, the component is a `conflict` and shows no code line. Two mapped rows with the same code line are one row: the second is dropped on load, and stderr says so once. Several rows that each set `relation` to `maps` and name different code are many-to-many links, not a conflict. A `composed-of` row is an extra link, not the primary twin.
- **Unknown fields.** Any field that is not in the shape above makes that entry ignored, with the reason shown (for example `unsupported field 'key'`). `props`, `source` and `key` are not supported. A top-level `namingRule` ("auto-map a PascalCase name") is planned and not built yet; it is ignored and reported as such.
- **A missing, empty, or byte-order-mark-only file** is simply "no map", with no message. A file that is not valid JSON prints one line on stderr (`code-map.json is malformed; ignored`).
- **A file with nothing usable** says `code-map.json has no usable entries.` and lists why each entry was ignored.
- **Where the code line shows.** It is added to the `recommend` card (for the top pick only), the `resolve` card, and the MCP versions of both, only if it fits inside the card limit without dropping a candidate. When it does not fit, that line shows `(cut)` if the marker fits. A card that is already full leaves the line out (the part is still counted as mapped in `code-map`). It is never added to a weak match, and never to a retired part. A part that lives in another Figma file (a remote stub, for example a published icon) cannot be mapped here; map it in the file where it lives. The code line is cleaned of control characters, so a bad file cannot sneak text into an agent's prompt. Without a map, every card is byte-for-byte what it was before.

##### Selector entries

An entry can describe a component that templates use through a selector. Add `selector` and, if you know them, `module` or `standalone`, `inputs` and `outputs` inside `code`. Entries without these fields (like the ones above) work exactly as before, and one file can mix both kinds. A made-up Acme entry (the full example map is [`docs/examples/acme-code-map-selectors.json`](examples/acme-code-map-selectors.json)):

```json
{
  "fileKey": "ACMEUI",
  "id": "30:10",
  "name": "Button",
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

- **`selector`** is required for a selector-based entry. Real selector forms work: an element name with a dash (`acme-button`), an attribute (`[acmeTooltip]`), an attribute with a value (`[type="submit"]`), a class (`.acme-card`), combinations (`button[acme-button]`, `input[acmeField]:not([readonly])`) and comma lists (`button[acme-button], a[acme-button]`). An element name alone needs a dash. A selector alone marks the entry as a selector entry; the `framework` value says it outright.
- **`module`** is the NgModule to import (`AcmeButtonModule`). For a standalone component, use `"standalone": true` instead. Giving both is refused.
- **`inputs`** and **`outputs`** are optional lists of names (`["variant", "size"]`). The alias form `"label: ariaLabel"` is accepted; the alias is what a template binds to. A name listed twice is kept once.
- **The import path** comes from the `import` line (`@acme/ui-angular`), as before.
- A bad selector value drops only the selector fields of that entry, never its code line. The reason is listed under `Angular fields ignored (code line still used)` in `code-map` (`angularIgnored` in JSON), for example `selector must look like acme-button, [acmeTooltip] or button[mat-button], a[mat-button]`, `use module or standalone: true, not both`, `'module' needs an Angular selector`, or `'selector' is an Angular field; set framework to angular` (on a `"framework": "react"` entry). Nothing is quietly changed. The CSV import is stricter: a bad selector value there is a row error, so it gets fixed before the map is written.
- One component, one entry: an import-only entry and a selector entry for the same component are a `conflict` (`a React and an Angular entry disagree; keep one entry per component`). The exception is the usual retired rule: if one of the two is retired and the other current, the current one is used.

Where the selector fields show: the ingredient card (text and `angular` in JSON, also `useAngular` for a retired part's replacement), the `resolve` card (`angular`, next to `code`), the `recommend` card (a short `angular` line such as `<acme-button>, AcmeButtonModule`, only when it fits in 600 characters), the `verify` retired lines, `code-map` (a count line such as `4 components have a selector (incl. 1 retired)`, and the selector on retired lines), and the [handoff sheet](#handoff). A retired part's own code is left off the card. The replacement's code is the only code line. With no selector entries, the cards and reports read as they did before PR #36, except that a retired part no longer prints its old code.

`resolve code-map` reports `mapped`, `retired`, `unmapped`, `ambiguous`, `conflict`, `stale` (an entry whose component is not in the library, with its file key), `ignored`, plus lists of retired parts (with code and replacement) and bad `replacedBy`. Only real components and component sets are counted: variants, remote stubs and `_`/`base` parts are not.

#### Other optional files

`bind-rules.json` (must use / must not use / prefer; see [`docs/BIND-RULES.md`](BIND-RULES.md)), `library-rules.json` (a simple allow/deny list of names), `recipes.json` and `context-packs.json` (your own recipes and product/journey packs; see [`docs/RECIPES.md`](RECIPES.md)), and `placeholders.json` (template sentences that must not be left in a final screen; see [`docs/GUIDE.md`](GUIDE.md)).

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
| `verify` | A retired part fails the check (listed under `deprecated`). | The same, for library-retired and map-retired parts alike (a map-retired part is not a pass-with-warning). Each retired part also gets a line: `retired Old Button -> use Button`. The old code is not shown. |

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
| Phrase scoreboard (headline) | 118 phrases = 88 expected a part + 30 expected empty. top-1 83/88, top-3 85/88, empty-correct 30/30, invented 0, retired 0. Held-out top-3 18/19 (seed 90, 24 of 118). Fresh Acme set top-3 14/14 (21 phrases). Weakest type: retired, 6/7 right first. Paraphrase 36/39 right first, 1 got nothing back |
| Golden scoreboard (secondary regression, 75 cases) | recommend 56/56, resolve 59/59, recipe 3/3, verify did-you-mean on its own row. Tool rows added together (recommend + resolve + recipe, verify excluded) are 118/118. That 118 is not 118 phrases and not 75 cases. Top-3 is not reported (1 card). Invent 0, leak 0 |
| Phrase regression set | 96/96 |
| 8-screen public-style library, alone, and with a product screen learned | top-1 41/41, top-3 41/41, honest no-match 14/14, false no-match 0/41, synonyms 18/18, invent 0 |
| Ingredient card (Acme example library) | Payee picker = Avatar + Button, Payment method row = Avatar + Button; invented parts 0; unmapped parts shown as unmapped |
| Selector code map (Acme example) | 4 selector entries load with 0 ignored; the CSV example imports to the same map; 14 bad selector values dropped with a reason while the code line stays; 5 real selector forms and input aliases accepted |
| Handoff sheet (Acme example) | Send money refused for the retired Old Button (draft or not); after the fix, 3 components, 3 linked to code, 2 parts, verify PASS, matches the golden file; 0 invented code lines. Receipt refused as `not-found` (Legacy badge's component is in no learned file); Payment methods' Brand mark labelled `other-library` |
| Tests | 893 (counted on `main` at `08eb74d`) |

**Top-1** means the first component returned is the right one. **Invent** means a component not in the library. **Leak** means a retired or private component offered as a pick. The golden and phrase sets were written alongside the code, so they are a regression guard and not proof about unseen wording. How the sets are built: [`docs/SCOREBOARD.md`](SCOREBOARD.md).

### Limits: what is not tested yet

- Not proven on a real company library over time. The checks above use a sample library and a public-style test library. An earlier independent blind test on a sample library moved top-1 on unseen asks from 38% to 83% after PR #19.
- Code twins are only as good as the map: Resolve does not check that the code component exists or that its props match the Figma variants.
- The map has no per-variant props, no source path, and no automatic same-name rule yet (all planned).
- If two entries for one part are both current (or both retired) and disagree, you get "conflict" and no code line; there is no tie-break on purpose.
- The code line on `recommend` and `resolve` shows `(cut)` when the card cannot hold the line and the marker fits. A card that is already full leaves the line out. The part still counts as mapped in `code-map`. It also cannot appear for a part that lives in another Figma file (a remote stub).
- A `verify` card that is already full of failures keeps the retired lines by removing lower-value text. If a single retired line is still too long (for example a part name of several hundred characters) the card says to run `resolve code-map --retired`. The failing parts are always listed.
- A replacement chain is followed up to 3 steps; a longer one counts as "no current replacement".
- With or without a code map, `recommend` does not offer a retired part as the pick to place. An exact retired name with no live replacement says "Use none". `resolve` of that exact name still returns the retired master, flagged.
- `example` and `cousins` do not use the code map and do not say a part is retired.
- The code map's selector fields and the handoff sheet's suggested inputs are tested on the made-up Acme map and on a public library fixture. Suggested input values are the Figma value in lower case with dashes, keeping letters of any language (`Warn Light` becomes `warn-light`, `Größe` becomes `größe`); check them against the code. An attribute the selector already sets (`acme-button[variant="primary"]`) is not repeated.
- Not run for this README: anything that needs a Figma account (reading a live Figma link, the published-icon lookup, the Figma login), Codex, the Cursor app and the Claude desktop app. The `npx` install from GitHub, `claude mcp add`, `claude mcp get` and `resolve-setup` were run on a test machine.

### What the AI receives

MCP tools answer in Markdown. `format` `json` is the same card as one compact JSON line. Both leave out filler: the `cost` block, the rank `score`, a graph id `node:…` sitting next to `figmaNodeId` or `nodeId`, the repeated "Do not Read graph.json" sentence, `learn_library`'s save-state dump, and a handoff parts table that repeats the parts already listed on each component. File writes (`handoff.json` and the screen sheets) stay indented. `ingredients`, `handoff` (terminal text), `parts`, and `status` print that same Markdown. Other commands, and those four with `--json`, print compact JSON; `--pretty` indents it. A proper-use error on a passing component check exits 7. JSON `pass` is false for that exit, and for every other non-zero exit. On exit 0 the first line is `PASS · Components: PASS · Proper use: PASS`. PASS stays the first word. Exit 7 starts `FAIL: proper use (N errors, M warnings) · components pass`, and JSON `result` is `proper_use_failed`. A component list with no frame stays `NOTHING CHECKED` and does not add a proper-use block. JSON keeps `builtAt` and the empty `deprecated` and `unresolved` arrays. Every other exit code is unchanged.

Every pick, part, and placed copy still carries `fileKey` and `figmaNodeId`. A published master keeps `componentKey`. A real example keeps `ex`. A check with no frame stays `NOTHING CHECKED`. When proper use ran and the exit code is 0, the first line is `PASS · Components: PASS · Proper use: PASS`. Proper-use errors start `FAIL: proper use (N errors, M warnings) · components pass`. It keeps `textChecked`. A retired or deprecated name keeps its replacement. A recipe slot says placed, inside another component, or missing, and an unbound slot keeps the next `recommend` query. Name guesses and other-library parts stay labelled. Audience and a11y are echoed with a source (`document`, `pack <id>`, or `active pack`). A code-map name check keeps the status, the designer sentence, and the exit code.

On the Acme library (file key `ACMEUI`, the selector example map), `recommend` for "payee picker" is:

```
intent: payee picker
candidates:
  - name: Payee picker | type: MAIN_COMPONENT | figmaNodeId: 30:30 | fileKey: ACMEUI | componentKey: payee-picker-key | published: true | publishState: published | instances: 4 | why: used 4× in file | hint: Place fileKey + nodeId. | ex: 20:31
hint: Place fileKey+nodeId. If stale, learn_library.
code: AcmePayeePickerComponent from '@acme/payments-angular'
angular: <acme-payee-picker>, standalone
```

The same 14 Acme cards (three recommends, three resolves, one example, two verifies, one recipe, the recipe list, cousins, one ingredient card, and the Send money handoff) are 4,547 tokens as today's JSON and 3,350 as Markdown. Tokens are `ceil(characters / 4)`, summed per card. Removing the filler accounts for about half of that drop (the stripped JSON is 3,995). The count is locked in `tests/server.cards.test.ts`.

### How Resolve tells the AI about properties

When a library is learned, Resolve reads each component's Figma property definitions and puts them on the card. The AI sees the property, its type, the allowed values (the default is marked), the code input when one matches, and a "designer says" hint when the request uses a word that maps onto an allowed value. A value that is not in the list is never suggested.

Acme Button, asked as "outline button with icon":

```
Properties:
- Variant · VARIANT · Primary (default), Secondary, Tertiary · variant · designer says: outline → Secondary
- Size · VARIANT · Medium (default), Small, Large · size
- State · VARIANT · Enabled (default), Disabled · disabled
- Has icon · BOOLEAN · false (default), true · unmapped · designer says: with icon → true
- Icon · INSTANCE_SWAP · Check (default), Close · 1 preferred value unknown · unmapped
- Label · TEXT · Button (default) · unmapped
To apply: set Variant=Secondary, Has icon=true
```

`variant`, `size`, and `disabled` are the code inputs. Label, Has icon, and Icon have no matching input, so they say unmapped. A name like `Property 1` is kept and flagged so someone renames it in Figma. On a placed instance, a value outside the allowed list fails verify. A text property left on its default, such as a label that still says "Button", is a note and does not fail.

## What a component means

`recommend` and `brief` load a dictionary for the library they are looking at. The shared words are in `src/data/meaning/default.json`. Acme adds its own in `src/data/meaning/acme.json`. Other libraries can add their own file the same way. A library file adds density, device, and exclusion words. It does not replace the shared ones. A library without its own file still gets the shared words. A density word one or two words before `list` is that list's density, unless the file says the word describes the noun right after it. A joined, split, or hyphenated plural matches the same name.

The parse reads your ask before anything is ranked:

- the head word ("card", "list", "tabs")
- modifiers and variant attributes (density, size, state, style, date)
- the purpose, the part after to / for / on / when
- context, such as a phone or a landscape screen
- a contrast: "button, not link" will not lead with the link

Acme, when the library has Compact List:

- "a dense list" and "list, compact for phones" mean Compact List. Dense is Acme's word for compact. Phones is the device.
- "a card that is dated" means the card, and dated is a date attribute.
- "picker for fruit" and "picker to choose a flavor" mean nothing. Resolve does not invent a part.
- "something to pick a date" means Date picker when the library has one, because that is what the part is for.

If two parts tie, the older word score breaks the tie. A one-letter typo still finds the part. A lead is weak only when part of the ask names a different part.

`meaning/` is a generated copy of each component's own name, properties, and description. In every copy, `Aliases:` lines come from the repo's synonym list (`src/data/synonyms.json`), not from the library or its docs. A copy can also carry one published sentence from a public library's own docs, with its source and licence kept in the data file. Acme copies add no other text the pack does not already contain. A `Thin:` line means the description or the guidelines are missing. Rebuild with `node scripts/build-meaning-sock.mjs meaning`. `recommend` and `brief` keep using the dictionary above.

AI picks stay off unless `RESOLVE_AI_PICKS=1`. With the switch off, `recommend` is unchanged. `resolve pick` needs a repo checkout for now, because the installed package does not ship the meaning files. An Acme request, when the switch is on:

```json
{"library":"acme","ask":"the main action on a form","shortlist":["button"],"pick":"button","reason":"Button Style Primary","tier":"ask"}
```

Acme's button file has no description, so the checked answer is `ask`, not `place`. The reason is the component name plus a property. The thin list names `button` and the fields it is missing.

## Upgrading from the old names

See [Upgrading from the old names](../README.md#upgrading-from-the-old-names) in the README.

## Version history

The version history lives on the wiki: [Version history](https://github.com/TANISHQBAFNA/resolve/wiki/Version-history).

## FAQ

More plain-language answers are in [Questions designers ask](#questions-designers-ask).

**Why does my retired component not show in `recommend`?** Retired parts (retired in the library, or in a code map) are never the pick for a new screen. They stay mapped when you have a code map. You still see them when you check an old frame with `verify`, or ask for one by its exact name with `resolve`. `recommend` names the live replacement, or says none.

**Does a retired part fail `verify`?** Yes, the same way whether the library or your code map retired it. The card lists it under `deprecated` and, with a code map, adds a line such as `retired Old Button -> use Button`. The old code is not shown.

**Can the code map revive a retired part?** No. If the library flags a part retired, `"status": "current"` in the map does not change that. Fix it in Figma.

**Why is there no code line on my `recommend` card?** One of: no map; the top pick is a weak match; the top pick is retired; the part is not mapped (see `resolve code-map`); the name is ambiguous or in conflict; the top pick lives in another Figma file (a remote stub or an external icon library), which cannot be mapped; or the line did not fit in the 600-character card without dropping a candidate (that line then shows `(cut)` when the marker fits; a card that is already full leaves it out).

**What is `RESOLVE_HOME`?** The setting that pins the store folder. If you do not set it, Resolve uses the nearest `.resolve/` folder going up from where you run, then `~/.resolve/default`. Upgrading from an older version: see [Upgrading from the old names](../README.md#upgrading-from-the-old-names).

**Where do I put team words?** `.resolve/synonyms.json`. See [team config files](#team-config-files).

**What Node version?** 22.12 or newer (Node 24 also works).

## For developers

```bash
git clone https://github.com/TANISHQBAFNA/resolve.git
cd resolve
npm install
npm run build:server
npm run resolve -- help
npm test          # the full test suite
npm run build     # typecheck + browser build + server build
```

`npm run dev` opens the library and rules pages in a browser (sample data, no login). There is no graph canvas.

- Plug-and-play next to Figma: [`docs/SETUP-MCP.md`](SETUP-MCP.md)
- Designer guide: [`docs/GUIDE.md`](GUIDE.md)
- Bind rules and approving a proposal: [`docs/BIND-RULES.md`](BIND-RULES.md)
- SOCI: [`docs/SOCI.md`](SOCI.md)
- Screen recipes: [`docs/RECIPES.md`](RECIPES.md)
- Accuracy scoreboard: [`docs/SCOREBOARD.md`](SCOREBOARD.md)
- Cursor steps: [`docs/CURSOR-RESOLVE.md`](CURSOR-RESOLVE.md)
- Building Resolve: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
- How tools plug in: [`docs/INTEGRATIONS.md`](INTEGRATIONS.md)
