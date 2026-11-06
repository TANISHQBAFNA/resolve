# Screen Map fidelity

This is the committed Acme hand audit. It does not call Figma, and it does not use a token. The bars below are the ones in the Screen Map FSD. A run of the suite is the measurement. This note does not claim a result beyond what `tests/screenMap.fidelity.test.ts` checks.

| Bar | How this repo checks it |
| --- | --- |
| REST instance maps to the master the source named | Ten Acme screens, one instance each, `ds.masterId` matches the component |
| Binding kind is variable or raw as audited | The same ten nodes |
| Layout values match the audit | Direction, padding, and gap on those nodes |
| Drift lists the raw values | Unbound fill and padding on the audited nodes |
| Rebuild is byte-identical | Covered by `tests/screenMap.build.test.ts` |
| Journey visits a loop once | Covered by `tests/screenMap.views.test.ts` |
| Opt-in off leaves the 625-ask gate alone | The meaning regression still runs in `npm test`. Screen Map does not import the recommend ranker |
| MCP is honest | The same screen names come back `guessed`, never `extracted`, and the journey warns `W-MAP-NO-PROTO` |

The 20-question usefulness bar is not run here. Do not treat this file as that result.
