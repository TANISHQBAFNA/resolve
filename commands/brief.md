---
description: Ask up to 3 questions before Resolve picks components for a screen
argument-hint: <the screen you want, e.g. show recent payments>
---
The designer typed: $ARGUMENTS

Before you pick components, brief this screen. Do not draw anything yet.

1. If the input is empty, ask what screen they want and stop.
2. Call the Resolve tool `brief` with `request` set to the designer's words. If they already answered, pass `answers`. Topics are `shape`, `states`, and `platform`. `states` can be a list. At most 3 answers. Do not pass `goal`.
3. If Resolve says no design system is learned, tell the designer to run `/design-system <Figma link>` first. Stop.
4. If the result says `No match`, say there is no match. Do not ask questions and do not invent a part.
5. If the result has `questions`, ask only those questions, in order, at most 3. Each question is multiple choice. A states question can take more than one option. Read the options out. Do not add your own. Wait for the answers, then call `brief` again with those `answers`.
6. If the result is `ready`, do not ask anything. Tell the designer the assumptions in one or two sentences. The candidates are the parts to use. Pass the same `answers` to `recommend` and to `get_handoff`. The handoff parts change with the answers.
7. If the designer said "just build", "go ahead and build", or "build without asking", the result is `ready`. Show the assumptions. If it says no match, do not pick a part.
8. If there are no candidates, say Resolve has no component for this screen. Do not guess or make one up.

Never invent a component, name, or node id. Only use ids Resolve returned. Do not ask about persona, visual style, or a requirements ticket.

## If this fails

Tell the designer in one or two plain sentences, then stop. Never show a stack trace, a path inside node_modules, or a dump of code.

- That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.
- Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.
- Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.
- Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.
- Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.
