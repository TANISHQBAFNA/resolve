---
description: Scan a component package, suggest Figma to code pairs, or review them
argument-hint: scan|suggest|review <package or path>
---
The designer typed: $ARGUMENTS

This command keeps the code map. A suggestion is not the truth. Only a mapped pair is a code twin. `/parts` and `/handoff` show mapped twins only. An unmapped part means stop and ask.

1. The input starts with `scan`, `suggest`, or `review`. If it is empty, ask which one and stop.
2. Run in the project folder. In the lines below, `resolve-figma` means `npx -y -p github:TANISHQBAFNA/resolve#v0.1.1 resolve-figma`, the same package spec as Resolve's MCP server entry. Use exactly this spec. Never run `npx resolve-figma` on its own: that looks the name up on the npm registry, not in Resolve's GitHub repo. The first run downloads the package and can take a minute. If `npx` is not found, say: Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself. If the download fails, say Resolve could not be downloaded and to check the network, then stop.
   - `scan <package or path>` runs `resolve-figma code-map scan "<package or path>"`. It reads the component package. It does not write the map.
   - `suggest <package or path>` runs `resolve-figma code-map suggest "<package or path>"`. It proposes pairs. Every pair is suggested. Add `--write` only when the designer asks to save them. A suggestion is not mapped.
   - `review` runs `resolve-figma code-map review`. It writes a CSV. The designer sets `status` to `mapped` on the rows they confirm. Then `resolve-figma code-map review --import "<file.csv>"`. A blank status stays suggested. Entries the CSV leaves out are kept.
3. A client that only has the MCP server needs `RESOLVE_MCP_ADVANCED=1`, then `code_map_scan`, `code_map_suggest`, or `code_map_review`. Those tools call the same functions. They are not on the default tool list.
4. Show the result in plain words. Do not treat a suggested or partial pair as the code to use. If a part is unmapped, stop and ask.

Never guess a code component. Never invent a component, name or node id.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
