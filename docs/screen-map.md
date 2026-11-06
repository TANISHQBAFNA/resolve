# Screen Map

Screen Map is off until you opt in. Resolve still recommends, checks, and learns without it. Nothing in Screen Map blocks a run. Each finding is a warning with a `next:` hint, and the command exits 0.

Turn it on in `.resolve/config.json`. That file stays private. Do not put tokens or secrets in it.

```json
{
  "screenMap": {
    "enabled": true,
    "lookalikes": false
  }
}
```

Then:

```
resolve map build
resolve map outline
resolve map screen <id>
resolve map node <id> --depth 2
resolve map journey <id>
resolve map drift
resolve map expand <ref>
```

`build` writes `.resolve/private/screen-map/`. The tree is for one file version. Building the same version again is byte-identical aside from `builtAt`. The folder is gitignored. It stores no images and no text content. A text node is a slot: present, and a line count when the source had one.

Views are convenience. The full tree is always available. `--depth` and `--page` cap a view only. `--refs` writes a repeated master once; `expand` puts it back.

DSCK and DSCI are unchanged. Screen Map does not invent part jobs or slots. Those fields stay empty for a later meaning pass.

An MCP learn has no prototype links. `resolve map journey` then warns `W-MAP-NO-PROTO` and points at a REST or plugin learn. Name-only components are `identity: guessed`, never confirmed.

`lookalikes` stays false until you set it. A lookalike warning is separate from a detached frame, and it is never a block.

The committed Acme hand audit is [Screen Map fidelity](screen-map-fidelity.md). It does not call Figma.
