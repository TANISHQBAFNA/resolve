# Add-ons

Resolve can run optional commands that live outside its core. An add-on is a folder here, `addons/<name>/`, with a `hook.json` and a bin script. Resolve finds it by itself. Core never imports add-on code; it only runs the bin.

```json
{
  "command": "hello",
  "bin": "bin/hello.mjs",
  "usage": ["  resolve hello <name>", "      Says hello. An example add-on."]
}
```

With `addons/hello/hook.json` and `addons/hello/bin/hello.mjs` in place:

- `resolve hello Ada` runs `node addons/hello/bin/hello.mjs Ada`. The add-on's exit code is Resolve's exit code.
- `resolve --help` lists the `usage` lines.
- Delete the folder and the command is gone. Resolve works the same without it.

An add-on that needs Resolve's data should read the files Resolve writes (for example the `handoff --out` folder) and import only `src/public.ts`. Tests named `addons/<name>/**/*.test.ts` run with `npm test`.

Add-on folders are listed in `.gitignore`, so an add-on you install here stays out of this repo.
