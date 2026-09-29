---
name: resolve
description: For ANY Figma design, screen, or component task, call Resolve before drawing. Check that Figma MCP is connected and a design system or screens are ingested; if either is missing, tell the user what is missing and how to add it. Map the file with learn_library, then recipe, recommend, get_example, verify_frame, and check_cousins when relevant. Never invent components.
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
2. **recipe** when the screen job matches a pack.
3. **recommend** for each unbound, missing, or deprecated slot. Place only the returned `figmaNodeId`s. Cards include `fileKey` because ids collide across files.
4. **get_example** for the real instance (`ex` on the top pick; call `get_example` for the others). Clone that instance and replace the content. Do not start from the default variant. A known name goes to `resolve`. A miss points at `recommend`.
5. **verify_frame** after the frame exists. Fetch that frame's design context first and pass it as `designContext`. `texts` only fills empty layers inside the frame.
6. **check_cousins** when a library file and a product or client file are both linked. Unsure means stop.

Placing into a different Figma file needs the library published and `libraries` from `search_design_system`. Otherwise build inside the library file.

## Design work

Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full write-up, when this client can read MCP resources: `resolve://workflow`.
