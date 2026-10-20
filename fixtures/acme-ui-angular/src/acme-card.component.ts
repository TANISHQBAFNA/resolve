import { Component, input } from "@angular/core";

@Component({
  selector: ".acme-card",
  standalone: true,
})
export class AcmeCardComponent {
  readonly title = input("");
}
