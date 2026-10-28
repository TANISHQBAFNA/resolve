---
description: The developer build sheet for a Figma screen
argument-hint: <Figma link to the screen or frame>
---
The designer typed: $ARGUMENTS

This is the developer build sheet. Resolve only reads. `/parts` is the short list of what's on the screen and its code twin (or unmapped). This command is the sheet a developer builds from.

1. The input must be a Figma link to a screen (with `node-id`). If it is empty, ask for the link and stop.
2. Run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve#v0.1.1 resolve-figma handoff "<link>"`. This is the same package spec as Resolve's MCP server entry. Use exactly this spec. Never run `npx resolve-figma` on its own: that looks the name up on the npm registry, not in Resolve's GitHub repo. The first run downloads the package and can take a minute. If `npx` is not found, say: Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself. If the download fails, say Resolve could not be downloaded and to check the network, then stop. Add `--out handoff` to write the files into a `handoff` folder when the designer asks for files. A client that only has the MCP server needs `RESOLVE_MCP_ADVANCED=1`, then the MCP tool `get_handoff` with `frame` set to the link. That tool returns the same sheet as Markdown. Pass `format` `json` for the data.
3. If it refuses, show the reason in plain words and what to change (for example a retired component to swap, or a library file that is not learned yet). Do not use `--draft` unless the designer asks; a draft is not for build.
4. If it works, show the developer build sheet: the components with their Figma id and mapped code twin, the parts inside each, the recipe slots (placed, inside another component, or missing), verify PASS or FAIL, and the open questions. Show only mapped code twins. A suggestion is not code. If a part is unmapped, stop and ask.
5. If the frame or the design system is not learned, tell the designer to run `/design-system <link>` first.
6. With `--out`, the folder also gets `decision.md`: what was asked, which parts were picked and why, and what was rejected. Point the designer to it. If AIDLC needs the handoff, run `npx -y -p github:TANISHQBAFNA/resolve#v0.1.1 resolve-figma export aidlc <folder> --out aidlc.json` only when asked.

Never guess code. "unmapped" and "unknown" stay as they are. An unmapped part means stop and ask. Never invent a component, name or node id.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
