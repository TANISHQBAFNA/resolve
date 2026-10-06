# Handoff: Send money

- Screen: Send money [ACMEUI 20:40] (https://www.figma.com/design/ACMEUI/?node-id=20-40)
- 3 components placed (3 copies), 3 linked to code, 0 unmapped. 2 parts inside, 1 linked to code.

## Recipe

No recipe matched this screen's name. Pass --recipe and a recipe id (see resolve recipe list) to check the screen against one.

## Components (3)

### Payee picker

- Figma: ACMEUI 30:30 (placed: 20:41)
- Code: `AcmePayeePickerComponent from '@acme/payments-angular'`
- Angular: `<acme-payee-picker>, standalone; inputs: payees, selected; outputs: selectedChange` (add the component to `imports`)
- Template (suggested): `<acme-payee-picker [payees]="…" [(selected)]="…"></acme-payee-picker>`
- Parts inside (from the main component, not checked on this screen):
  - Avatar [ACMEUI 30:40] (unmapped)
  - Button / Variant=Primary, Size=Medium [ACMEUI 30:11] (code: `AcmeButtonComponent from '@acme/ui-angular'`, `<acme-button>, AcmeButtonModule`)

### Button / Variant=Primary, Size=Medium

- Figma: ACMEUI 30:11 (placed: 20:42)
- Code: `AcmeButtonComponent from '@acme/ui-angular'`
- Angular: `<acme-button>, AcmeButtonModule; inputs: variant, size, disabled; outputs: pressed` (import `AcmeButtonModule` from '@acme/ui-angular')
- Figma properties: Variant=Primary, Size=Medium → inputs (suggested): variant="primary", size="medium"
- Template (suggested): `<acme-button variant="primary" size="medium" [disabled]="…" (pressed)="…"></acme-button>`
- Other variants in Figma (states to build): Variant: Secondary, Danger; Size: Large
- Parts inside: none (a base part)

### Button / Variant=Secondary, Size=Medium

- Figma: ACMEUI 30:13 (placed: 20:43)
- Code: `AcmeButtonComponent from '@acme/ui-angular'`
- Angular: `<acme-button>, AcmeButtonModule; inputs: variant, size, disabled; outputs: pressed` (import `AcmeButtonModule` from '@acme/ui-angular')
- Figma properties: Variant=Secondary, Size=Medium → inputs (suggested): variant="secondary", size="medium"
- Template (suggested): `<acme-button variant="secondary" size="medium" [disabled]="…" (pressed)="…"></acme-button>`
- Other variants in Figma (states to build): Variant: Primary, Danger; Size: Large
- Parts inside: none (a base part)

## Code to import

- `AcmePayeePickerComponent from '@acme/payments-angular'` (standalone)
- `AcmeButtonComponent from '@acme/ui-angular'` (module `AcmeButtonModule`)

## Ingredients (2 parts)

| Part | Figma | Code | Status | Used by |
|---|---|---|---|---|
| Avatar | ACMEUI 30:40 | unmapped | unmapped | Payee picker |
| Button / Variant=Primary, Size=Medium | ACMEUI 30:11 | `AcmeButtonComponent from '@acme/ui-angular'`, `<acme-button>, AcmeButtonModule` | mapped | Payee picker |

## Verify

PASS: 3 approved components.

## Decisions

None approved for this screen yet.

## Open questions

- Part Avatar [ACMEUI 30:40] (inside Payee picker) has no code link.
