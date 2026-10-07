---
description: Show what is inside a component (its ingredient card)
argument-hint: <component name>
---
The designer typed: $ARGUMENTS

Show the parts inside one component of the design system.

1. If the input is empty, ask which component and stop.
2. Run in the project folder: `npx -y -p github:TANISHQBAFNA/resolve resolve-figma ingredients "<component>"`. Add `--variant "Size=Medium"` when the designer names a variant. (If the Resolve advanced tools are on, the MCP tool `get_ingredients` gives the same card.)
3. Show the card as it is: the parts placed directly in the component, how many of each, and the code component for each part (or "no code link yet").
4. If the name is not found, say so and suggest `/find <phrase>`. If no design system is learned, tell the designer to run `/design-system <Figma link>` first.

Never guess a code component. Never invent a component, name or node id.
