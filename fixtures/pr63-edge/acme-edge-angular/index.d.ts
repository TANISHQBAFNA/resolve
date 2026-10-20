import * as i0 from "@angular/core";

/* lookalikes */
export declare class AcmeButtonComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeButtonComponent, "button[acme-button], a[acme-button]", never, { "variant": { "alias": "variant"; "required": false; }; "size": { "alias": "size"; "required": false; }; "disabled": { "alias": "disabled"; "required": false; }; }, { "pressed": "pressed"; }, never, never, false, never>;
}

export declare class AcmeButtonGroupComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeButtonGroupComponent, "acme-button-group", never, { "orientation": { "alias": "orientation"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeIconButtonComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeIconButtonComponent, "button[acme-icon-button]", never, { "icon": { "alias": "icon"; "required": false; }; "disabled": { "alias": "disabled"; "required": false; }; }, { "pressed": "pressed"; }, never, never, true, never>;
}

/** @deprecated Use AcmeButtonComponent. */
export declare class AcmeButtonLegacyComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeButtonLegacyComponent, "acme-button-legacy", never, { "label": { "alias": "label"; "required": false; }; }, {  }, never, never, false, never>;
}

export declare class AcmeCartComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeCartComponent, "acme-cart", never, { "items": { "alias": "items"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeButtonModule {
  static ɵmod: i0.ɵɵNgModuleDeclaration<AcmeButtonModule, [typeof AcmeButtonComponent, typeof AcmeButtonLegacyComponent], never, [typeof AcmeButtonComponent, typeof AcmeButtonLegacyComponent]>;
}

/* selector-only and odd selectors */
export declare class AcmeChipComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeChipComponent, ".acme-chip", never, { "label": { "alias": "label"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeTagComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeTagComponent, "acme-tag, acme-label-tag", never, { "label": { "alias": "label"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeBadgeComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeBadgeComponent, "acme-pill", never, { "tone": { "alias": "tone"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeToggleComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeToggleComponent, "input[type=checkbox][acmeToggle]:not(.acme-switch)", never, { "checked": { "alias": "checked"; "required": false; }; }, { "checkedChange": "checkedChange"; }, never, never, true, never>;
}

export declare class AcmeCheckboxComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeCheckboxComponent, "acme-checkbox, [acmeCheckbox]", never, { "checked": { "alias": "checked"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeSelectComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeSelectComponent, "acme-select, acme-dropdown", never, { "options": { "alias": "options"; "required": false; }; "value": { "alias": "value"; "required": false; }; }, { "valueChange": "valueChange"; }, never, never, true, never>;
}

/* wrapper and composed */
export declare class AcmeFormFieldComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeFormFieldComponent, "acme-form-field", never, { "label": { "alias": "label"; "required": false; }; "hint": { "alias": "hint"; "required": false; }; "error": { "alias": "error"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeTextInputComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeTextInputComponent, "input[acmeInput]", never, { "value": { "alias": "value"; "required": false; }; "placeholder": { "alias": "placeholder"; "required": false; }; }, { "valueChange": "valueChange"; }, never, never, true, never>;
}

export declare class AcmeDialogComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeDialogComponent, "acme-dialog", never, { "open": { "alias": "open"; "required": false; }; }, { "closed": "closed"; }, never, never, true, never>;
}

export declare class AcmeDialogHeaderComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeDialogHeaderComponent, "acme-dialog-header", never, { "title": { "alias": "title"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeDialogBodyComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeDialogBodyComponent, "acme-dialog-body", never, {  }, {  }, never, never, true, never>;
}

export declare class AcmeDialogFooterComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeDialogFooterComponent, "acme-dialog-footer", never, {  }, {  }, never, never, true, never>;
}

export declare class AcmeDateRangeStartComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeDateRangeStartComponent, "acme-date-range-start", never, { "value": { "alias": "value"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeDateRangeEndComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeDateRangeEndComponent, "acme-date-range-end", never, { "value": { "alias": "value"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeTabsComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeTabsComponent, "acme-tabs", never, { "selected": { "alias": "selected"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeTabComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeTabComponent, "acme-tab", never, { "label": { "alias": "label"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeIconComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeIconComponent, "acme-icon", never, { "name": { "alias": "name"; "required": false; }; }, {  }, never, never, true, never>;
}

/* deprecated / retired */
export declare class AcmeAlertComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeAlertComponent, "acme-alert", never, { "tone": { "alias": "tone"; "required": false; }; }, {  }, never, never, true, never>;
}

/**
 * Top-of-page message.
 * @deprecated Use AcmeAlertComponent.
 */
export declare class AcmeBannerComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeBannerComponent, "acme-banner", never, { "tone": { "alias": "tone"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeOldStepperComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeOldStepperComponent, "acme-old-stepper", never, { "steps": { "alias": "steps"; "required": false; }; }, {  }, never, never, true, never>;
}

/* ambiguity: two classes with the same words */
export declare class AcmeAvatarComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeAvatarComponent, "acme-avatar", never, { "src": { "alias": "src"; "required": false; }; "size": { "alias": "size"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AvatarComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AvatarComponent, "internal-avatar", never, { "src": { "alias": "src"; "required": false; }; }, {  }, never, never, true, never>;
}

/* plain names */
export declare class AcmeSpinnerComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeSpinnerComponent, "acme-spinner", never, { "size": { "alias": "size"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeBreadcrumbComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeBreadcrumbComponent, "acme-breadcrumb", never, { "items": { "alias": "items"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmePaginatorComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmePaginatorComponent, "acme-paginator", never, { "page": { "alias": "page"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeProgressBarComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeProgressBarComponent, "acme-progress-bar", never, { "value": { "alias": "value"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeRadioButtonComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeRadioButtonComponent, "acme-radio-button", never, { "value": { "alias": "value"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeRadioGroupComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeRadioGroupComponent, "acme-radio-group", never, { "value": { "alias": "value"; "required": false; }; }, {  }, never, never, true, never>;
}

export declare class AcmeMenuComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeMenuComponent, "acme-menu", never, {  }, {  }, never, never, true, never>;
}

export declare class AcmeMenuItemComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeMenuItemComponent, "acme-menu-item", never, { "label": { "alias": "label"; "required": false; }; }, {  }, never, never, true, never>;
}

/* generics */
export declare class AcmeTableComponent<T> {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeTableComponent<any>, "acme-table", never, { "rows": { "alias": "rows"; "required": false; }; "columns": { "alias": "columns"; "required": false; }; }, {  }, never, never, true, never>;
}

/* noise */
export declare class AcmeThemeService { setTheme(name: string): void; }
export declare const ACME_CONFIG: unknown;
export interface AcmeButtonOptions { size: string }
export declare class AcmeSizePipe {
  static ɵpipe: i0.ɵɵPipeDeclaration<AcmeSizePipe, "acmeSize", true>;
}
export declare class AcmeTooltipDirective {
  static ɵdir: i0.ɵɵDirectiveDeclaration<AcmeTooltipDirective, "[acmeTooltip]", never, { "acmeTooltip": { "alias": "acmeTooltip"; "required": false; }; }, {}, never, never, true, never>;
}
export * from './src/public-api';
