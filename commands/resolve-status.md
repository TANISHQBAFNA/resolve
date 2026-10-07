---
description: Show which design systems Resolve has learned
argument-hint: (nothing)
---
Show what Resolve has learned in this project.

1. Run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve resolve-figma status`.
2. Show the result in plain words: each learned Figma file (name, role: library or screens, how many nodes, when it was last learned) and the code-map coverage (how many components link to code).
3. If nothing is learned, say so and tell the designer to run `/design-system <Figma link>`.
4. If a file was learned a long time ago and the designer says it changed, suggest running `/design-system <link>` again for that file.

Do not read `.resolve/graph.json`. Never invent a component, name or node id.
