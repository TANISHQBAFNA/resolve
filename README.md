# Resolve

> Figma rules. Agents resolve.

> [github.com/TANISHQBAFNA/resolve](https://github.com/TANISHQBAFNA/resolve)

Resolve is the shared brain for your Figma design system. You already have the components. Resolve makes an agent ask for those components before it builds a screen.

**Line:** Figma rules. Agents resolve.

You set the design rules. The agent builds inside them.

MIT licensed. Free to use. The longer walkthrough is the [designer guide](docs/GUIDE.md).

## 30 seconds

Checkout summary, as the example.

1. **Ask.** “Checkout summary with a primary button.”
2. **The right component.** Resolve returns your library’s Primary button: the real component, its file, and its id, plus a real instance to clone. The agent clones that instance and replaces the content. It does not start from the bare default.
3. **Check.** After the screen exists, run the check (`verify_frame` on that frame). Leftover template text fails. A pass means the pieces are real library components. You still decide whether the screen looks right.

---

## Seven layers, one connected system

Read from the foundation up. Each layer uses checkout as the example.

**SOCK** (System of Connected Knowledge) is the knowledge layer: layers 1 to 5. **SOCI** (System of Connected Intelligence) is the learning loop: layer 6. Layer 7 is the accuracy scoreboard.

1. **The design system itself** — SOCK. Real components and their variants. A retired component is flagged, so it is not offered as the one to place. Checkout: the Primary button and its variants. A retired “Pay now” button stays marked retired.
2. **Product and journey context** — SOCK. Which product, and which step in the journey. Checkout: the Storefront product, on the summary step.
3. **Many files, one source of truth** — SOCK. The shared library is the source. A product file can still contain its own lookalike. Checkout: a team’s own copy of Price is flagged as a wrong copy.
4. **Rules and reasons** — SOCK. Each pick includes a short why-this card. Bind rules (must use, must not use, prefer) change only when a person changes them. Checkout: the card says this is the library Primary for the pay step. A person is the only one who edits that rule.
5. **Usage learning** — SOCK. A pattern counts after 3 real screens that pass the check. Checkout: a price row plus the Primary button, on three checkout screens that passed. One screen is not enough.
6. **The SOCI loop** — SOCI. SOCI suggests a change. A person approves it. Checkout: after those three screens, SOCI can suggest adding that pattern to the checkout recipe. Nothing in the rules changes until you approve.
7. **The accuracy scoreboard.** A repeatable check that the ask returned the right component, that nothing was invented, and that a retired or private component was not offered as a pick. Checkout: “checkout summary with a primary button” is scored against the Primary button you expected.

---

## Accuracy, honestly

**Top-1** means the first component returned is the right one. **Invent** means a component that is not in the library. **Leak** means a retired or private component was offered as a pick.

The repo test set is 118/118 top-1, with invent 0 and leak 0. The held-out phrase set is 96/96. On an 8-screen Material-like library, both alone and with a product screen learned, top-1 is 41/41, top-3 is 41/41, honest no-match is 14/14, false no-match is 0/41, and the synonym list is 18/18, with invent 0. In an independent blind test on a sample library (not yet a real company library), top-1 went from 38% to 83% on unseen asks after PR #19.

How the repo set is built: [scoreboard](docs/SCOREBOARD.md).

---

## What's new

Newest first. Dates are IST (India Standard Time).

- **Sep 29, 2026 — [PR #25](https://github.com/TANISHQBAFNA/resolve/pull/25).** Asking for a primary button returns the Button, including “primary sign in button” and a recipe’s primary-button slot. A variant that merely says Primary on a different component no longer wins. A weak match is labeled “weak match” and lists up to three parts, instead of one confident guess. Recipe suggestions return a real component, or an honest empty when the library has no such part. Variant settings (State, Type, Size, Off, Primary) are not components. “Empty state message” and “color picker” stay empty when the library has no such part. Word order and filler still find the component, and the card says the match is partial. Built-in words now include floating action button, spinner, dropdown, tag, sidebar, text field, and top app bar versus bottom. Words your team uses go in `.graphify/synonyms.json`. A check says “Verified” only when a real component id or key matched. A layer-name match says “name-only” and is not a pass. A failed check exits with an error. Deleting the learned library asks you to confirm. Setup ends with a short status: Node, Figma, library, rule, and the one next step. `resolve score --init` writes a starter scoreboard from the library you already learned. The 8-screen Material-like set is a permanent check, run twice: the library alone, and the library plus a product screen. Library alone: top-1 41/41 (was 34/41), top-3 41/41 (was 34/41), honest no-match 14/14 (was 12/14), false no-match 0/41 (was 4/41), synonyms 18/18 (was 11/18), invent 0. Library plus a product screen, before this fix: top-1 40/41, top-3 40/41, honest no-match 14/14, false no-match 0/41, synonyms 18/18, and “primary button” plus “primary sign in button” each returned only Tabs with no weak flag. After: top-1 41/41, top-3 41/41, honest no-match 14/14, false no-match 0, synonyms 18/18, invent 0, and both asks return Button flagged weak (up to three candidates, never a confident Tabs pick). A guessed instance name cannot turn a variant word into a component. Setup skips a `CLAUDE.md` that has only one Resolve marker, says the rule is not installed, and exits with an error. If `CLAUDE.md` is a folder, or another write fails, setup says so in plain words, still prints the status, and exits with an error. 502 tests. Repo set stays 118/118 top-1, invent 0, leak 0. Phrase set stays 96/96. Card maxima: recommend 586, verify 559, resolve 1019, recipe 1128.
- **Sep 29, 2026 — [PR #24](https://github.com/TANISHQBAFNA/resolve/pull/24).** Resolve turns on for design tasks without a reminder. MCP instructions are a short trigger (under 1,500 characters) so Claude Code's 2,048-character cut keeps the path: check that Figma is connected and a library or screens are learned, map the file with `learn_library`, then `recommend`, `get_example`, and `verify_frame`. `resolve-setup` writes the project Cursor rule, the Claude skill, and a marked `CLAUDE.md` block. Cursor needs that project rule. `--global` is Claude only. Claude Desktop only receives the MCP instructions. The longer workflow is the MCP resource `resolve://workflow`. 490 tests. Repo set stays 118/118 top-1, invent 0, leak 0.
- **Sep 28, 2026 — [PR #22](https://github.com/TANISHQBAFNA/resolve/pull/22).** Live text in verify, example caching. `verify_frame` reads real text from the frame's design context. Pass design context to `learn_library` too, or the component default stays unknown and `textChecked` is `partial` (a Bene Dropdown can still say "Request Bank Certificate" with no leftover warning). `texts` only fills empty layers inside the frame. `textChecked` stays on the card. Layer names are not text. `npm run bench`: 73k-node recommend is 59–114 ms and `get_example` 42–65 ms (uncached baseline 763 ms and 571 ms); verify is 11–16 ms. The bench heavy file (40 components × 900 instances) recommends in 296–465 ms. On a reviewer's generated heavy 73k-node graph: recommend about 0.69 s (510 ms before #21, 3.6 s on #21); verify about 33 ms. Card maxima: recommend 592, verify 559, resolve 1019, recipe 1141. Repo set stays 118/118 top-1, invent 0, leak 0.
- **Sep 28, 2026 — [PR #21](https://github.com/TANISHQBAFNA/resolve/pull/21).** Real example with every pick. The top recommend, resolve, and recipe pick points at a real populated instance (`ex`; `fileKey:nodeId` when that instance is in another file). Call `get_example` / `resolve example` for the full config and for the other hits. Clone that instance and replace the content. Do not start from the default variant. If none is known, the card says `ex: none` plus a short reason. The same populated shape on 3 verified screens becomes the preferred example, and only for that variant. `verify_frame` fails lorem-ipsum filler. Leftover default copy warns, and fails only when that default is also listed in `.graphify/placeholders.json`. An oversized fixed height warns unless real examples use the same height. Recommend and verify cards stay within 600 characters (max 592 and 522 on the fixture). Resolve and recipe stay within 2000 (max 1019 and 1141). Repo set stays 118/118 top-1, invent 0, leak 0.
- **Sep 28, 2026 — [PR #18](https://github.com/TANISHQBAFNA/resolve/pull/18).** Fix library verify, Figma metadata, and Claude setup. Claude Desktop and Claude Code setup. `verify_frame` approves only real library masters. `check_cousins` fixes, including a team’s own copy of Price. More Figma metadata formats. A Node 22.12 check. Long “Set / Variant” names stay inside the card size limit.
- **Sep 28, 2026 — [PR #19](https://github.com/TANISHQBAFNA/resolve/pull/19).** Keep component picks when words describe the component (cart badge, login field). Asks like “cart badge” and “login field” now return the right component.
- **Sep 27, 2026 — [PR #17](https://github.com/TANISHQBAFNA/resolve/pull/17).** Rank component picks by name before screen context.
- **Sep 27, 2026 — [PR #16](https://github.com/TANISHQBAFNA/resolve/pull/16).** Add an offline accuracy scoreboard for agent cards.
- **Sep 27, 2026 — [PR #15](https://github.com/TANISHQBAFNA/resolve/pull/15).** SOCI v1: usage-driven improvement proposals.
- **Sep 27, 2026 — [PR #14](https://github.com/TANISHQBAFNA/resolve/pull/14).** Thin bet C: why line, bind rules, and approve flow. Why-this cards, bind rules, and a person approves.
- **Sep 27, 2026 — [PR #13](https://github.com/TANISHQBAFNA/resolve/pull/13).** Resolve for Figma MCP: plug-and-play and SOCK live usage learning.
- **Sep 27, 2026 — [PR #12](https://github.com/TANISHQBAFNA/resolve/pull/12).** Harden the agent loop: invent gates, a live shared store, and lookup by the component’s real name.

---

## Not yet

- Not proven on a real company library yet.
- SOCI does not compare journeys across products yet.
- Linking several design systems is a later step.

---

## Setup

Needs Node 22.12 or newer (`node -v`). Full page, including Cursor: [SETUP-MCP.md](docs/SETUP-MCP.md).

Turn on Figma in the same tool. Resolve works best when that Figma connection is active and there is a design system, library, or existing screens for it to learn from. If either is missing, the agent should say what is missing and how to add it, instead of inventing a component. Learning a library needs a paid Figma seat with MCP access (Dev or Full), or a Figma access token for command-line ingest. A view or free seat has a low read quota. Resolve saves progress and resumes.

The design app starts the Resolve server. You do not leave a terminal running.

Once, so the agent calls Resolve on every design task:

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-setup
```

That writes `.cursor/rules/resolve.mdc`, `.claude/skills/resolve/SKILL.md`, and a marked block in `CLAUDE.md` in this project. Cursor reads that rule from the project. It does not load a rule from your home folder. Run it again any time. It only changes its own block and leaves the rest of your files alone. `--global` is for Claude only: it writes `~/.claude/skills/resolve/SKILL.md` and a marked block in `~/.claude/CLAUDE.md`. Claude Desktop does not read rule files, skills, or `CLAUDE.md`. It only gets the MCP instructions, which is why those stay short and say to call Resolve first.

If Claude Desktop cannot start Resolve, set `command` to the full path from `which npx`.

### Claude Code

```bash
claude mcp add resolve -s user -- npx -y -p github:TANISHQBAFNA/resolve resolve-mcp
claude mcp add --transport http figma https://mcp.figma.com/mcp -s user
```

Then in Claude Code run `/mcp` and log in to Figma.

### Claude Desktop

Add Figma in **Settings → Connectors**. Do not put a Figma `url` entry in the config file. That breaks Claude Desktop.

Resolve only. Config file:

- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Or open **Settings → Developer → Edit Config**.

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

Quit Claude Desktop with **Cmd+Q** (not the window close button) and reopen. Check that `resolve` is listed under **Settings → Developer**.

---

## For developers

```bash
git clone https://github.com/TANISHQBAFNA/resolve.git
cd resolve
npm install
npm run build:server
```

Day-to-day commands (explained in the [guide](docs/GUIDE.md)):

```bash
npm run resolve -- ingest '<figma-url>'
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
npm run resolve -- recommend "checkout summary with primary button"
npm run resolve -- example "Main Card"
npm run resolve -- verify "Checkout Summary"
```

`npm run keyline` still works as a deprecated alias for this release. Optional: `npm run dev` opens the map in a browser (sample data, no login).

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
