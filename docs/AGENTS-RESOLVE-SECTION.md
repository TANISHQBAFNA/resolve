## Resolve

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

For ANY Figma design, screen, or component task, call Resolve before drawing. **Never Read `graph.json`.** Never invent components.

**Check first.** Resolve works best when the Figma MCP connection is active and a design system, library, or existing screens are learned. If either is missing, tell the user in plain words what is missing and how to add it. Do not guess.

**Path (Resolve MCP tools):**

1. Map the Figma file first. `get_metadata`, then `learn_library` (`role` `library` for the design system, `product` or `client` for screens). Pass `designContext` so the component default text is stored. Re-run when that file changed.
2. Set context before any component pick. Read the requirements or FSD and take the product, journey step, audience, and a11y bar from that text. Do not ask for those four. Pass `pack` when `.resolve/context-packs.json` matches the same document. Otherwise pass `product`, `journey`, `domain`, `audience`, and `a11y` only when the requirements or FSD state them. Leave a field off when the document does not say it. Do not invent a product, an audience, or an a11y bar. Overlay `.resolve/recipes.json` still wins.
3. `recipe` for the screen job. Pass the same context.
4. `recommend` for each unbound, missing, or deprecated slot. Pass the same context. Place returned `figmaNodeId`s only (cards stamp `fileKey`). An empty card means stop.
5. `get_example`, then clone that instance and replace the content. Pass the same context. Do not start from the default variant.
6. `verify_frame` after the frame exists. Pass the same context. Fetch that frame's design context first and pass it as `designContext`.
7. `check_cousins` when a library file and a product or client file are both linked. Pass the same context. Unsure means stop.

Resolve is read-only. Never invent a component, name, or node id.

**Design work.** Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full workflow, when this client can read MCP resources: `resolve://workflow`.

Designers add recipes in JSON (`src/data/recipes.json` or `.resolve/recipes.json`), product+journey+domain packs in `.resolve/context-packs.json`, and linked files in `.resolve/workspace.json`. See [GUIDE.md](GUIDE.md).
