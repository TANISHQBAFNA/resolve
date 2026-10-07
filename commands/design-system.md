---
description: Learn a Figma design system (or screens) with Resolve and save its components locally
argument-hint: <Figma link to the file, page or frame>
---
The designer typed: $ARGUMENTS

Teach Resolve this Figma file so it can recommend and check real components. Resolve only reads; it never edits Figma. Running this again is safe: it updates the learned copy and leaves recipes, the code map and decisions alone.

1. The input must be a Figma link. If it is empty or not a link, ask for the link and stop. Take the file key from the link. Use `node-id` from the link when there is one (`20-40` means node `20:40`).
2. Check the Figma connection (tools such as `get_metadata`). If Figma is not connected, say so in plain words: connect Figma in this app, sign in, then run this command again. Stop.
3. Call Figma `get_metadata` for that file or node. Also call `get_design_context` for the same node when you can, so component text is stored. Pass the file `version` into `learn_library` when Figma gives one.
4. Call the Resolve tool `learn_library` with `fileKey`, `metadataXml` (the `get_metadata` output), `designContext`, `version` when you have it, and `role`: `library` for a design system (default), `product` or `client` when the designer says these are screens.
5. A big file hits Resolve's 50,000 node cap and the rest is skipped. Then learn it page by page: `get_metadata` on each page node, one `learn_library` call per page, same `fileKey`. Still too big: frame by frame. Progress is saved; use `resume: true` to continue.
6. Tell the designer the `report.told` sentence from `learn_library`, in those words. It says how many components, how many are retired, which icon libraries are known (or none), and where it was saved. If `report.told` is missing, say those four facts from the result yourself. Then say what is still left (pages not learned). Next: `/find <phrase>`.

Never invent a component, name or node id. Do not read `.resolve/graph.json`.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
