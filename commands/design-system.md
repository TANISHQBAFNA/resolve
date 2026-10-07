---
description: Learn a Figma design system (or screens) with Resolve and save its components locally
argument-hint: <Figma link to the file, page or frame>
---
The designer typed: $ARGUMENTS

Teach Resolve this Figma file so it can recommend and check real components. Resolve only reads; it never edits Figma.

1. The input must be a Figma link. If it is empty or not a link, ask for the link and stop. Take the file key from the link. Use `node-id` from the link when there is one (`20-40` means node `20:40`).
2. Check the Figma connection (tools such as `get_metadata`). If Figma is not connected, say so in plain words: connect Figma in this app, sign in, then run this command again. Stop.
3. Call Figma `get_metadata` for that file or node. Also call `get_design_context` for the same node when you can, so component text is stored.
4. Call the Resolve tool `learn_library` with `fileKey`, `metadataXml` (the `get_metadata` output), `designContext`, and `role`: `library` for a design system (default), `product` or `client` when the designer says these are screens.
5. A big file hits Resolve's 50,000 node cap and the rest is skipped. Then learn it page by page: `get_metadata` on each page node, one `learn_library` call per page, same `fileKey`. Still too big: frame by frame. Progress is saved; use `resume: true` to continue.
6. Tell the designer in plain words what was learned: file name, how many components and nodes, what is still left (pages not learned), and where it is saved (the Resolve store folder, usually `.resolve/` in this project). Next: `/find <phrase>`.

Never invent a component, name or node id. Do not read `.resolve/graph.json`.
