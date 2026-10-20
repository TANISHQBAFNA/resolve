import { Component, input } from "@angular/core";

/** Multi-line decorator with comments. */
@Component(
  {
    // selector: 'acme-fake-card'   <- comment, must be ignored
    selector: /* real one */ ".acme-card",
    standalone: true,
    template: `<ng-content />`,
  },
)
export class AcmeCardComponent {
  readonly title = input("");
}

@Component({
  selector: "acme-card-header",
  standalone: true,
  template: "",
})
export class AcmeCardHeaderComponent {
  readonly title = input.required<string>();
}
