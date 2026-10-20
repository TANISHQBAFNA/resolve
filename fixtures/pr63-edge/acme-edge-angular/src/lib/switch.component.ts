import { Component, Input, Output, EventEmitter, NgModule, model } from "@angular/core";

@Component({ selector: ".acme-switch:not([disabled])", template: "" })
export class AcmeSwitchComponent {
  @Input() checked = false;
  @Input({ alias: "aria-label" }) ariaLabel = "";
  @Output() checkedChange = new EventEmitter<boolean>();
}

@Component({ selector: "acme-slider", standalone: true, template: "" })
export class AcmeSliderComponent {
  readonly value = model(0);
  readonly max = input.required<number>();
}

@NgModule({ declarations: [AcmeSwitchComponent], exports: [AcmeSwitchComponent] })
export class AcmeSwitchModule {}
