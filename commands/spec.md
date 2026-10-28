---
description: Map a Figma spec to the right library components
argument-hint: <Figma link to the spec>
---
The designer typed: $ARGUMENTS

This command reads a Figma spec (the requirements document in a Figma file) and says which real library component each screen requirement maps to. Resolve only reads; it does not change the spec or the design.

1. The input must be a Figma link to a spec (a link with `node-id` when the file holds more than one). If it is empty, ask for the link and stop.
2. Call the Figma tool `whoami` first. The plan that owns the file must have `specs_enabled: true`. If it is false or missing, tell the designer Specs is not available on that plan, and stop. If you cannot tell which plan owns the file, ask. Do not guess.
3. Read the spec with the Figma plugin API: `figma.spec.getContent({ specNodeId })` returns `markdown`. Find the spec node whose `type` is `SPEC_BLOCK` and `specBlockType` is `DOCUMENT`; use the `node-id` from the link when there is one. Never edit the spec. Never use `setContent` or `editContent`.
4. Save the Markdown to a temporary file, then run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve#v0.1.2 resolve-figma spec <file>`. This is the same package spec as Resolve's MCP server entry. Use exactly this spec. Never run `npx resolve-figma` on its own: that looks the name up on the npm registry, not in Resolve's GitHub repo. The first run downloads the package and can take a minute. If `npx` is not found, say: Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself. If the download fails, say Resolve could not be downloaded and to check the network, then stop. A client that only has the MCP server needs `RESOLVE_MCP_ADVANCED=1`, then the MCP tool `spec_map` with `markdown` set to the spec text. Add `--all` (or `all: true`) to also list the lines that are not screen parts. `--json` prints the rows as data.
5. Report what Resolve returns, grouped as it does: **mapped** (component name, Figma id and file key, and the alternatives), **weak** (say it is a weak match and check before placing), **no match** (nothing in the library fits, or the line is not a screen part; ask the designer, never pick something yourself). Say which context the spec states (product, journey, audience, accessibility level) and pass only those on to `brief` and `recommend`. Do not add context the spec does not state.
6. Place nothing from this card alone. For a screen build, continue with `recipe`, then `brief` and `recommend` for each slot, and `get_example` before drawing.
7. If no design system is learned, tell the designer to run `/design-system <Figma link>` first.

Never invent a component, name or node id. Never map a line to a part Resolve did not return.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Specs is not available on that Figma plan, or the file has no spec. Say which.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
