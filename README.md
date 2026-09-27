# Resolve

> Figma rules. Agents resolve.

> [github.com/TANISHQBAFNA/resolve](https://github.com/TANISHQBAFNA/resolve)

**You set the design rules. AI builds inside them — faster and more accurately.**

Resolve is one shared design system brain for your Figma library. Agents pick **real** library components (a Primary button, a checkout row) instead of inventing a new system every time.

**Start here:** **[Resolve — how to use it](docs/GUIDE.md)** — the designer guide. What it is, the happy path, how to write a context pack, how to write a bind rule, what Resolve does not do yet.

MIT licensed. Free to use.

---

## The loop (one glance)

1. **You** set rules, screen packs, linked Figma files (shared library + product/client), and (when one library serves several products) a context pack for *this* product and *this* journey step
2. **Resolve** holds one knowledge workspace — not one giant Figma file
3. **AI** asks what to reuse (`recipe`, then `recommend`), then drafts from those masters
4. **Resolve** checks the draft (`verify_frame`) and, when more than one file is linked, the wrong-cousin report
5. **You** judge taste

Resolve is not “AI that designs.” It is **your rules, made easy for AI to follow** — without pasting the whole Figma file into chat.

---

## Who this is for

Designers and product people who work with AI and want the AI to respect the library — not invent random UI.

You don’t need to be a developer. If you can clone a GitHub repo and paste a Figma link, you’re fine. The full walkthrough is in the [guide](docs/GUIDE.md).

---

## For developers

Needs Node 22.12 or newer.

```bash
git clone https://github.com/TANISHQBAFNA/resolve.git
cd resolve
npm install
npm run build:server
```

That’s the setup. Do it once.

| Tool | What to do |
|------|------------|
| **Cursor** | One config line next to Figma MCP — [SETUP-MCP.md](docs/SETUP-MCP.md). `npx -y -p github:TANISHQBAFNA/resolve resolve-mcp`. |
| **Claude Code** | In this folder: `claude --plugin-dir .` |
| **Codex / others** | Open this folder. It can read `AGENTS.md` and `skills/resolve`. |

Turn on **Figma MCP** in the same tool. Learning needs a **paid Figma seat with MCP access (Dev or Full)**, or a **Figma access token** for REST ingest. View or free seats have a low read quota — Resolve saves progress and resumes.

Live command-line ingest of a `figma.com` URL needs `FIGMA_ACCESS_TOKEN`. Everyday use is Figma MCP in the AI tool (`learn_library`).

Day-to-day commands (full explanation in the [guide](docs/GUIDE.md)):

```bash
npm run resolve -- ingest '<figma-url>'
npm run resolve -- recipe list
npm run resolve -- recipe "checkout summary"
npm run resolve -- recommend "checkout summary with primary button"
npm run resolve -- recommend "primary button" --pack storefront-checkout-summary
npm run resolve -- recommend "primary button" --product Storefront --journey summary --domain checkout
npm run resolve -- verify "Checkout Summary"
```

Prefer the command name `resolve`. `npm run keyline` still works as a deprecated alias for this release.

Optional: click around the map in a browser with `npm run dev` (sample data, no login).

Other ways to bring a file in: Figma MCP `learn_library` (primary), or REST ingest with a token (secondary). Big libraries: several checkpointed passes.

---

## More docs

- **Plug-and-play next to Figma MCP:** [`docs/SETUP-MCP.md`](docs/SETUP-MCP.md)
- **Designer guide:** [`docs/GUIDE.md`](docs/GUIDE.md)
- Bind rules + approve a proposal: [`docs/BIND-RULES.md`](docs/BIND-RULES.md)
- Screen recipes (JSON packs): [`docs/RECIPES.md`](docs/RECIPES.md)
- Cursor-focused steps: [`docs/CURSOR-RESOLVE.md`](docs/CURSOR-RESOLVE.md)
- Building Resolve: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- How tools plug in: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)
- Toolchain versions: [`CHANGELOG.md`](CHANGELOG.md)

License: [`LICENSE`](LICENSE) (MIT)

---

## Roadmap (short)

| Now | Next ideas |
|-----|------|
| Map + search + short AI cards | Clearer reports on design-system usage |
| `recommend` + `verify_frame` (invent rate) | Smoother live Figma links and previews |
| Why line + bind rules + approve a proposal | Optional in-app AI helpers |
