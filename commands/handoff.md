---
description: Make the developer handoff sheet for a Figma screen
argument-hint: <Figma link to the screen or frame>
---
The designer typed: $ARGUMENTS

Produce the handoff sheet a developer can build from. Resolve only reads.

1. The input must be a Figma link to a screen (with `node-id`). If it is empty, ask for the link and stop.
2. Run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve resolve-figma handoff "<link>"`. Add `--out handoff` to write the files into a `handoff` folder when the designer asks for files. (If the Resolve advanced tools are on, the MCP tool `get_handoff` with `frame` set to the link gives the same sheet.)
3. If it refuses, show the reason in plain words and what to change (for example a retired component to swap, or a library file that is not learned yet). Do not use `--draft` unless the designer asks; a draft is not for build.
4. If it works, show: the components with their Figma id and code, the parts inside each, the recipe slots (placed, inside another component, or missing), verify PASS or FAIL, and the open questions.
5. If the frame or the design system is not learned, tell the designer to run `/design-system <link>` first.

Never guess code. "unmapped" and "unknown" stay as they are. Never invent a component, name or node id.
