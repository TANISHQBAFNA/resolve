---
name: resolve
description: Resolve gives real components (Figma masters or coded classes), never invented ones, and checks the result before you finish. Pick the workflow from the user's words (Figma design = Figma pack, HTML/CSS prototype = code pack), else config mode, else ask one short question. Load only that pack.
---

# Resolve

Resolve is read-only. Use real components only. Never invent a component, class, name, token, or node id. Run the check before you finish.

**Pick the workflow.**

1. The user's words decide. A Figma file, frame, or design is Figma. HTML, CSS, a prototype, or the repo's code is code.
2. Otherwise the config `mode` (`figma`, `code`, or `both`) in `.resolve/config.json`, or `RESOLVE_MODE`. `resolve mode` shows it.
3. Still unclear: ask one short question.

Then load only that pack: Figma is skill `resolve-figma`; code is skill `resolve-code`. Load both only when the task needs both, for example a Figma design and its coded prototype.

Full write-up, when this client can read MCP resources: `resolve://workflow`.
