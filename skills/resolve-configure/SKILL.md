---
name: resolve-configure
description: When the task is to choose and configure real design-system components for a screen, load this skill and guidelines.md in the same folder. Use only evidence Resolve returns. Missing facts are warnings, not invented practice.
---

# Choose and configure

Use this when an AI must pick real components for a screen and set their real properties and child slots. The outcome is for the designer choosing and configuring those components. It stops there. Do not use it to invent a layout or a house style.

## When

The user wants a screen built from the learned design system: which component, which variant, which properties, which child slots. A journey or a state matters only when the user or the requirements name it.

## How

1. Read `guidelines.md` in this folder. It is the only copy of the decision principles.
2. Call Resolve `configure` with the screen request. CLI: `resolve configure "<request>"`. Slash: `/configure`.
3. If `configure` is not on the server, stop. Say the choose-and-configure command is not installed. Do not fill the gap with generic advice.
4. Place only ids and property values the result lists. A value with no evidence stays unset.
5. Quote warnings and the `next:` hint. Do not hide a gap.

## Evidence contract

Evidence is a fact from the learned library or from the request: a component id, an allowed property value, a child slot, a confirmed usage count, a provenance line, or the user's own words matching an allowed value.

These are not evidence: a plausible default, a trend, a private pilot, or a sentence that is not tied to a returned field.

Screen map is optional. Do not require it. Learn-from-screens is not part of this skill.

Resolve does not block. A gap is a warning with `next:`.
