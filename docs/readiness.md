# Prototype readiness

`resolve ready` checks a working prototype in HTML, CSS and JS before it goes to developers. It writes `5-readiness/report.md`. Each item is a pass or a warning with a `next:` step. The command exits 0. `--strict` is opt-in, and it is the only way a finding changes the exit code. The report is still written.

The MCP tool is `ready`. It is part of the code workflow (`mode` `code` or `both`).

## Project folder

```
project.config.json
2-brief/screens.md
4-code/prototype/
  index.html
  screens/*.html
  css/
  js/
  data/
  vendor/<name>@<ref>/
5-readiness/report.md
```

`project.config.json` names the pinned design system. `source` is a local path or a git URL. `ref` is the pin. The vendor folder is `vendor/<name>@<ref>`.

```json
{
  "designSystem": {
    "name": "acme",
    "source": "../ds",
    "ref": "v1.4.0"
  }
}
```

A git URL uses the same shape (`"source": "https://github.com/acme/ds.git"`). The copy matches when `pin.json` in the vendor folder records that source and ref, or when that folder is a git checkout of the ref. A local path matches when the files are the same.

`2-brief/screens.md` lists each screen as a Markdown item or a table row. `Pay` needs `4-code/prototype/screens/pay.html`. A link such as `[Pay](screens/pay.html)` uses that path.

## What it checks

| Item | Pass | Warning |
| --- | --- | --- |
| components | Every `data-ds-id` is a real component in DSCK and has a confirmed Figma pair. | Unknown, unconfirmed, or made-up ids. |
| vendor | The vendor copy exists and matches the pin. | Missing copy, different files, or a different ref. |
| tokens | Colours and spacing use design tokens, where that can be seen. | A raw colour or a raw spacing value in the prototype. |
| variants | Variants on an element exist on that component. | A variant the component does not have. |
| screens | Every screen in `2-brief/screens.md` has an HTML file. | A listed screen with no file. |
| accessibility | Images have alt text, fields have labels, and each HTML file has a main landmark. | A missing alt, label, or landmark. |

A confirmed pair is a `component.json` with a Figma name or key, a confirmed row in `.resolve/component-map.json`, a confirmed `.resolve/mapping.json` line, or the same `ds@<semver>.<tier>.<name>` on the learned component and the code. A proposed row is not a pair. A deny stays a deny.

The id shape is `ds@<semver>.<tier>.<name>`, for example `ds@1.4.0.core.button`. Anything else is a made-up id.

## Command

```bash
resolve ready [project] [--json] [--strict] [--out <file>]
```

`--out` writes the report there instead of `5-readiness/report.md`. `--json` prints the same result as JSON. The Acme example that passes is `fixtures/acme-ready/good`. `fixtures/acme-ready/problems` has one of each warning.

With `--strict`, the exit code is 1 when the project folder is missing, 2 for components, 3 for the vendor copy, 4 for tokens, 5 for variants, 6 for screens, and 7 for accessibility. The lowest code wins. Without `--strict`, the exit is 0.
