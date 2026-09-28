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

The repo test set is 118/118 top-1, with invent 0 and leak 0. In an independent blind test on a sample library (not yet a real company library), top-1 went from 38% to 83% on unseen asks after PR #19.

How the repo set is built: [scoreboard](docs/SCOREBOARD.md).

---

## What's new

Newest first. Dates are IST (India Standard Time).

- **Sep 28, 2026.** Real example with every pick. Each recommend, resolve, and recipe pick points at a real populated instance (`ex`). `get_example` / `resolve example` returns the file, screen, variant, structure, and sizing. Clone that instance and replace the content. Do not start from the default variant. If none is known, the card says so. The same populated shape on 3 verified screens becomes the preferred example. `verify_frame` fails leftover template text such as “Request Bank Certificate”, and warns on leftover default copy and an oversized fixed height. Recommend and verify cards stay within 600 characters (max 599 and 522 on the fixture). Resolve and recipe stay within 2000 (max 1053 and 1009). Repo set stays 118/118 top-1, invent 0, leak 0.
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

Turn on Figma in the same tool. Learning a library needs a paid Figma seat with MCP access (Dev or Full), or a Figma access token for command-line ingest. A view or free seat has a low read quota. Resolve saves progress and resumes.

In Terminal, run this once and wait until you see `[resolve] MCP server ready`:

```bash
npx -y -p github:TANISHQBAFNA/resolve resolve-mcp
```

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
