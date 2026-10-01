# Scoreboard

**Figma rules. Agents resolve.**

The scoreboard is a repeatable check: when an agent asks for a component, does Resolve hand back the right library master?

It does not call Figma. It does not need a token. It scores the library that is already in the store. The sample library in this repo is the offline stand-in. A library you learned from Figma uses the same command later. Nothing in the scorer changes.

## What a case is

Cases live in `scoreboard/golden/*.json`. Each file is a list:

```json
{
  "version": 1,
  "cases": [
    {
      "id": "pay-not-save",
      "intent": "cta",
      "screenType": "checkout",
      "journey": "payment",
      "slot": "primary-cta",
      "expected": "Pay CTA",
      "accept": [],
      "mustNot": ["Save CTA"]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `intent` | What the agent asked, in ordinary words. |
| `screenType`, `journey`, `slot` | Optional scope. Same idea as a screen, a step, and a slot on that screen. |
| `expected` | The master that should come back, **by name**. Resolve looks that name up in the current graph and uses the id it finds. If two masters share the name, the populated local set wins (an empty stub does not). If the name is missing, the run stops. It does not invent an id. |
| `accept` | Other masters that are also fine. |
| `mustNot` | Cousins that must not be the top pick. Example: Pay CTA vs Save CTA, Tag vs Chip. |
| `expect` | `master` (the default when `expected` is set) or `empty`. |
| `tools` | An object overrides the expectation for the tools it names. Every other tool keeps the case's normal expectation. `["recipe"]` marks a recipe case and does not drop recommend or resolve. Example: asking for `Legacy Banner` by its exact name. Recommend should return the live Banner. Resolve returning Legacy Banner, marked deprecated, is correct. |

`empty` means there is no correct master. The card should come back empty, not a guess. Use this for private masters (`_Name`, `.Name`) and for questions the library cannot answer. An empty case may also list `accept`. An empty card is correct, and so is a top pick named there. Any other pick is a miss. `ctx-filter-tag` uses that: no Filter master exists, so empty is right, and Tag is acceptable only because the Catalog Filter screen uses it.

The shipped set covers exact names, synonyms, screen-context picks, cousin traps, deprecated masters, private masters, and questions with no answer. There are more than 60 cases. The sample library is `scoreboard/fixture/library.json`.

## Regression set

`scoreboard/regression/` locks ranking bugs found while reviewing this work: phrase matches, typos that must stay empty, and synonym wording. It was written with the ranking code, so a score on it is not accuracy on phrasing the ranker had not already seen. Do not tune weights to lift it.

```bash
npm run resolve -- score --golden scoreboard/regression --workspace fixture
```

## What is measured

Every case is sent through recommend, resolve, recipe, and verify. A tool is scored only when the question is one it can answer. An object in `tools` changes that tool's expectation. It does not skip the others.

| Measure | What it means |
| --- | --- |
| Invent rate | An id in a card, including hint and why text, that is not in the current graph. A component name counts only if it is a real component or component set. A frame name such as “Checkout Payment” does not. Target is 0. Above 0, the run fails. |
| Wrong-cousin rate | The top pick is a listed “must not” cousin, or another master that shares a specific name with the expected one (Pay vs a different Pay, not the generic word “button”). |
| Top-1 | The right master is the first pick. The run-level figure adds recommend, resolve, and recipe only. Verify is not in it. |
| Top-3 | Only cards that offered three or more candidates. Shown as `x/N`, or `n/a (N=0)` when no card held three. The change-since-last-run line leaves top-3 out until that N is at least 10. |
| Empty-when-weak | For no-answer cases, the card is empty. A tool with no such cases shows `n/a`, not 0%. |
| Deprecated or private leak | A retired master, or a private `_` / `.` master, was **offered as a pick** (a recommend candidate, a filled recipe slot, or a master verify approves). A master verify only flags does not count. The same pick is not both a leak and a wrong cousin. |
| Recipe | Scored only on cases marked `"tools": ["recipe"]` that also name a slot. A marked case whose recipe card is missing is a miss, so a broken recipe tool scores `0/3`, not a skip. Reported as `hits/cases` on screen cases. No slot means that case is not scored. The first slot is not used as a stand-in. |
| Verify | The “top-1” column is a did-you-mean hit. It is scored only when the intent is a component name, not free text like “primary button”. The suggestion itself is a component master, not a frame. This row is not mixed into the run-level top-1. |
| Card size | Median and largest card per tool. Recommend and verify must stay at or under 600 characters. Resolve and recipe must stay at or under 2000. Over the budget, the run fails. |
| Latency | Median and 95th percentile of those calls. |

Ranking is not adjusted to make this set look better. If a number is weak, that is the finding.

## Run it

Ingest a library first (the sample, or your own). Then score:

```bash
npm run build:server
npm run resolve -- ingest scoreboard/fixture/library.json --role library --name "Scoreboard fixture"
npm run resolve -- score --golden scoreboard/golden --workspace fixture
```

Flags:

- `--golden <path>` — a folder of JSON files, or one file. Default is `scoreboard/golden`.
- `--workspace <name>` — which `~/.resolve/<name>` folder holds the run history. `.`, `..`, and slashes are rejected, so a name cannot write outside that folder. The graph still comes from the active store (`GRAPHIFY_HOME`, or `~/.resolve/<name>` when that is the store).
- `--json` — print the run as JSON instead of the table. The JSON includes every miss. The table stays short.

Each run is saved under `GRAPHIFY_HOME/scoreboard/` when that folder is set, otherwise `~/.resolve/<name>/scoreboard/<timestamp>.json`. The change since last time is shown only when the previous run used the same golden set and the same workspace. A first run, or a run against a different set, has a null delta — not zeros. The trend on Overview and Rules uses that same pair of checks. A workspace name of `.`, `..`, or a path returns HTTP 400 from `/api/scoreboard`.

`resolve score --init` writes one case per public master plus synonym asks. Names that still have two populated masters are skipped (printed), so the golden file does not contain duplicate case ids.

The process exits with an error if the invent rate is above 0 or a card is over its size budget. Other numbers are reported. They do not, by themselves, fail the run.

## On the Rules page

Overview and Rules show the newest saved run across workspaces, and a picker when more than one workspace has a run. The page only reads. It does not change rules or the library.

The dev server and `vite preview` both serve it at `/api/scoreboard`. Preview does not open a websocket for that.
