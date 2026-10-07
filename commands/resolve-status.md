---
description: Show which design systems Resolve has learned
argument-hint: (nothing)
---
Show what Resolve has learned in this project. One short answer. Do not add a second report.

1. Run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve resolve-figma status`.
2. Show that text as it is. It already says which libraries are loaded, when each was learned, its version if known (or that the version was not recorded), whether the Figma token is set, whether the always-on rule is installed, the code-map coverage, and what to do next.
3. If nothing is learned, the text says so and tells the designer to run `/design-system <Figma link>`. Do not invent a library.
4. If the token line says missing, or Figma later says the token expired, tell them to connect Figma in this app. Status does not call Figma, so it cannot see an expired token by itself.
5. If the always-on rule is not installed, tell them to run `resolve-setup` in this project.

Do not read `.resolve/graph.json`. Never invent a component, name or node id. Never show a stack trace.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- This Figma seat can only view the file. Learning a library needs a Dev or Full seat. Ask someone with that seat to run /design-system, or change the seat, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
