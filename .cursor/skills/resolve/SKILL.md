---
name: resolve
description: For ANY Figma design, screen, or component task, call Resolve before drawing. Set context first (product, journey, audience, a11y), then place only returned components. If Figma or a learned library is missing, say so in plain words. Never invent components.
---

# Resolve

For ANY Figma design, screen, or component task, call Resolve before drawing. Use the Resolve MCP tools below. Do not run a shell command for this path.

Resolve is read-only. Never invent a component, name, or node id. Never Read `graph.json`.

## Check first

Resolve works best when both are true:

1. Figma MCP is connected in this app (`get_metadata`, `use_figma`).
2. A design system, library, or existing screens are already learned.

If either is missing, stop. Tell the user in plain words what is missing and how to add it. Connect Figma next to Resolve, then map the file. Do not guess a component.

## Path

1. **Map the file first.** Figma `get_metadata`, then Resolve `learn_library` with that XML, `fileKey`, and `role` (`library` for the design system, `product` or `client` for screens). Pass `search_design_system` or `get_libraries` as `libraries` when you have them. Pass `designContext` so the component default text is stored. Re-run when that file changed.
2. **Set context before any component pick.** Read the requirements or FSD (you read that document; Resolve does not) and pass `product`, `journey`, `domain`, `audience`, and `a11y` only when it states them. Do not ask for those four. Leave a field off when the document does not say it. Do not invent a product, an audience, or an a11y bar. A context pack is optional. Resolve uses one only on an exact product match, and an exact journey match when the document gives a journey. Do not pass `pack` unless the document names that pack id. A saved pack is a copy of `src/data/context-packs.example.json` at `.resolve/context-packs.json`. Never put Figma ids in that file.
3. **`recipe`** for the screen job. Pass the same context. The card echoes audience and a11y.
4. **`recommend`** for each unbound, missing, or deprecated slot. Pass the same context. Place only the returned `figmaNodeId`s. Cards include `fileKey` because ids collide across files. An empty card means stop. Do not draw a stand-in.
5. **`get_example`** for the real instance (`ex` on the top pick; call `get_example` for the others). Pass the same context. Clone that instance and replace the content. Do not start from the default variant. A known name goes to `resolve` with the same context. A miss points at `recommend`.
6. **`verify_frame`** after the frame exists. Pass the same context. Fetch that frame's design context first and pass it as `designContext`. `texts` only fills empty layers inside the frame.
7. **`check_cousins`** when a library file and a product or client file are both linked. Pass the same context. Unsure means stop.

Placing into a different Figma file needs the library published and `libraries` from `search_design_system`. Otherwise build inside the library file.

## Design work

Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full write-up, when this client can read MCP resources: `resolve://workflow`.
