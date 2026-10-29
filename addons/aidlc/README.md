# AIDLC add-on

Optional. Resolve core does not include this delivery contract. With this folder present, `resolve export aidlc` is registered. Without this folder, the core CLI does not list that command.

## Run

From the repo (Node 22 or later):

```bash
node addons/aidlc/bin/resolve-aidlc.mjs aidlc <handoff folder> [--out aidlc.json] [--json]
```

The same arguments work through the core CLI, because core reads `hook.json` and spawns that bin:

```bash
resolve export aidlc <handoff folder> [--out aidlc.json] [--json]
```

Core never imports this folder. The hook is a `hook.json` plus a bin. An in-process `registerAddonCommand("export", runExport)` exists for tests; the shipped path is the bin.

`export_aidlc` is not a core MCP tool. `src/mcp.ts` is the same advanced call: `RESOLVE_MCP_ADVANCED=1` and a `folder`.

## What it reads

It reads only files a handoff already wrote: `handoff.json` and, when present, `decision.json`. Exit status is `0` when the contract is written and `1` when the export is refused or the file cannot be written (`EXIT_OK` and `EXIT_ERROR` from `src/public.ts`). It imports that public module only.

The schema in `schema/aidlc-handoff.schema.json` is unchanged, including its generator note. Behavior is the same contract as before this move. See [docs/AIDLC.md](docs/AIDLC.md).
