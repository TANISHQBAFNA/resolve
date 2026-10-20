# Material 3 fixture

Public reference design system for Resolve. Angular Material `22.2.3` and Angular CDK `22.2.3` (the peer). MIT licensed.

The official Material 3 Design Kit on Figma was not read. The connected Figma seat is View on a Starter plan, so that community file is not available through the API. No Figma key and no Figma token are stored here. The file key `M3SPEC` is a made-up id for this fixture.

What was used instead:

- Component names, variants, and slots follow the public Material 3 component specs at <https://m3.material.io/components>.
- Token names are Material 3 system tokens (`md.sys.color.primary` and the rest of the color roles, plus type scale, shape, and elevation).
- Color values are the baseline scheme for seed `#6750A4`, produced by `@material/material-color-utilities` 0.3.0 `themeFromSourceColor`. That package is not a dependency. The numbers are copied into `library.json`.
- Surface-container roles that this utilities version does not return are left out, rather than invented.
- Code comes from the published `@angular/material` 22.2.3 `.d.ts` files. `@angular/cdk` 22.2.3 is pinned as the peer and is not part of the component scan.

`Tabs` maps to `MatTabGroup` (the tab bar). `Dialog`, `Snackbar`, and `Bottom sheet` are Angular services with no component metadata, so the scan cannot see them. The reviewed map adds those three from the public classes. `Search bar`, `Navigation bar`, `Navigation rail`, and `Side sheet` are in the Material 3 spec and have no matching Angular Material class, so they stay unmapped. `Legacy button` is deprecated and must not be offered as a live part.

Buttons use one syntax, `matButton`, with the Type variant (`filled`, `tonal`, `outlined`, `text`, `elevated`). A text field's filled or outlined type is `appearance` on `<mat-form-field>`, wrapping `<input matInput>` and `<mat-label>`. `M3SPEC` is not a Figma file. Handoff labels it as an example and does not print a figma.com link.
