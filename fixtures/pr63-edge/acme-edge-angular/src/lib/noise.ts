import { Component, Directive, Injectable, Pipe, input } from "@angular/core";

/** Abstract base: no selector, never a twin. */
@Component({ template: "" })
export abstract class AcmeBaseFieldComponent {
  readonly label = input("");
}

@Directive({ selector: "[acmeTooltip]", standalone: true })
export class AcmeTooltipSourceDirective {}

@Injectable({ providedIn: "root" })
export class AcmeToastService {}

@Pipe({ name: "acmeCurrency", standalone: true })
export class AcmeCurrencyPipe {}

export class AcmeNotAComponent {}

const SNACK = "acme-snackbar";
/** Template literal selector. */
@Component({ selector: `acme-snackbar`, standalone: true, template: "" })
export class AcmeSnackbarComponent {}

/** Selector from a constant. */
@Component({ selector: SNACK + "-x", standalone: true, template: "" })
export class AcmeSnackbarXComponent {}

@Component({ selector: "acme-list", standalone: true, template: "" })
export class AcmeListComponent<T> {
  readonly items = input<T[]>([]);
}
