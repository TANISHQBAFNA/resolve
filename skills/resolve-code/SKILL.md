---
name: resolve-code
description: For ANY HTML, CSS, or JS screen or component built on the repo's design system, call Resolve before writing markup. Pick coded components with code_pick, build with the returned classes and tokens only, run code_check before finishing. Never invent a class.
---

# Resolve: code pack

For ANY HTML, CSS, or JS screen or component built on the repo's design system, call Resolve before writing markup. Use the Resolve MCP tools (or `resolve code ...` in a shell). Never write a class from memory.

Needs `repoPath` (the folder with the design system CSS) in `.resolve/config.json` or `RESOLVE_REPO_PATH`. Optional: `cssEntry` (entry stylesheet), `theme` (token file). No `repoPath`: stop and ask the user for it.

**Path:**

1. `code_scan` once, and again after the design system changes. It builds a catalog: one entry per component with variants, rules, real markup, deprecated classes, and tokens. Saved to `.resolve/code-catalog.json`. Never Read that file; call `code_pick`.
2. `code_pick "<what the screen needs>"` for each part of the screen. Build with the returned classes, variants, and markup. A modifier needs its base class. Never use a class listed under `avoid`. Use tokens for colour, space, and type, never literal values. Link the design-system and theme stylesheets.
3. `code_check <file.html>` before you finish. Fix every error and each warning you can, check again, and report what is left. If nothing fits, say so instead of inventing a class.

Resolve is read-only. Never invent a class, variant, token, or markup.

**Figma and code names.** In both mode `code_map` lists how Figma and coded components join (mapped, exact, alias) and what is unmatched. An exact join needs the same name plus a specific variant, a description phrase, or base parts that match the code elements. A same name with no evidence is `risky: same name only` and is not a link. `code_pick` also finds a component by its Figma name or aliases. A suggested pair is not a link: show it to the user and let them confirm it in `.resolve/mapping.json` (or `resolve code-map --write "Figma name=code"`). Never join names yourself.

**Design work.** Simplest thing that works. Reuse a component before anything new. One check: `code_check`.

Full workflow, when this client can read MCP resources: `resolve://code`.
