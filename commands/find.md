---
description: Ask Resolve which real component to use for a phrase
argument-hint: <what you need, e.g. payee picker>
---
The designer typed: $ARGUMENTS

Find the right component in the learned design system. Do not draw anything.

1. If the input is empty, ask what the designer needs and stop.
2. Call the Resolve tool `recommend` with `intent` set to the phrase. If the phrase is an exact component name, call `resolve` with `name` instead.
3. If Resolve says no design system is learned, tell the designer to run `/design-system <Figma link>` first. Stop.
4. Show the top pick: component name, `fileKey` and `figmaNodeId`, and the one-line reason. Show the next two hits as name and id only. If the top pick has an example (`ex`), name it; call `get_example` only when asked how to place it.
5. If Resolve has no match, say exactly that: Resolve has no component for this phrase. Suggest another wording or `/design-system` for the right file. Do not guess or make one up.

Never invent a component, name or node id. Only use ids Resolve returned.
