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
| `expected` | The master that should come back, **by name**. Resolve looks that name up in the current graph and uses the id it finds. If the name is missing, the run stops. It does not invent an id. |
| `accept` | Other masters that are also fine. |
| `mustNot` | Cousins that must not be the top pick. Example: Pay CTA vs Save CTA, Tag vs Chip. |
| `expect` | `master` (the default when `expected` is set) or `empty`. |

`empty` means there is no correct master. The card should come back empty, not a guess. Use this for private masters (`_Name`, `.Name`) and for questions the library cannot answer.

The shipped set covers exact names, synonyms, screen-context picks, cousin traps, deprecated masters, private masters, and questions with no answer. There are more than 60 cases. The sample library is `scoreboard/fixture/library.json`.

## What is measured

Every case is sent through recommend, resolve, recipe, and verify. The numbers are:

| Measure | What it means |
| --- | --- |
| Invent rate | An id or a component name in a card that is not in the current graph. Target is 0. Above 0, the run fails. |
| Wrong-cousin rate | The top pick is a listed “must not” cousin, or another master that shares a specific name with the expected one (Pay vs a different Pay, not the generic word “button”). |
| Top-1 / top-3 | The right master is the first pick, or somewhere in the first three. |
| Empty-when-weak | For no-answer cases, the card is empty. |
| Deprecated or private leak | A retired master, or a private `_` / `.` master, showed up in the card. |
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
- `--workspace <name>` — which `~/.resolve/<name>` folder holds the run history. The graph still comes from the active store (`GRAPHIFY_HOME`, or `~/.resolve/<name>` when that is the store).
- `--json` — print the run as JSON instead of the table.

Each run is saved to `~/.resolve/<name>/scoreboard/<timestamp>.json`. The table includes the change since the previous run.

The process exits with an error if the invent rate is above 0 or a card is over its size budget. Other numbers are reported. They do not, by themselves, fail the run.

## On the Rules page

Overview and Rules show the latest run and a short top-1 trend. The page only reads. It does not change rules or the library.

The dev server and `vite preview` both serve it at `/api/scoreboard`. Preview does not open a websocket for that.
