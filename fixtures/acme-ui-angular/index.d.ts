import * as i0 from "@angular/core";

export declare class AcmeButtonComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeButtonComponent, "button[acme-button], a[acme-button]", never, { "variant": { "alias": "variant"; "required": false; }; "size": { "alias": "size"; "required": false; }; "disabled": { "alias": "disabled"; "required": false; "isSignal": true; }; }, { "pressed": "pressed"; }, never, never, false, never>;
}

export declare class AcmeButtonModule {
  static ɵmod: i0.ɵɵNgModuleDeclaration<AcmeButtonModule, [typeof AcmeButtonComponent], never, [typeof AcmeButtonComponent]>;
}

export declare class AcmeIconButtonComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeIconButtonComponent, "button[acme-icon-button]", never, { "icon": { "alias": "icon"; "required": false; }; "disabled": { "alias": "disabled"; "required": false; "isSignal": true; }; }, { "pressed": "pressed"; }, never, never, true, never>;
}

export declare class AcmeTextFieldComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeTextFieldComponent, "acme-text-field", never, { "label": { "alias": "label"; "required": false; }; "value": { "alias": "value"; "required": false; }; "error": { "alias": "error"; "required": false; "isSignal": true; }; }, { "valueChange": "valueChange"; }, never, never, true, never>;
}

export declare class AcmePayeePickerComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmePayeePickerComponent, "acme-payee-picker", never, { "payees": { "alias": "payees"; "required": false; }; "selected": { "alias": "selected"; "required": false; }; }, { "selectedChange": "selectedChange"; }, never, never, true, never>;
}

export declare class AcmeOldButtonComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeOldButtonComponent, "acme-old-button", never, { "label": "label"; }, {}, never, never, false, never>;
}

export declare class AcmeLegacyModule {
  static ɵmod: i0.ɵɵNgModuleDeclaration<AcmeLegacyModule, [typeof AcmeOldButtonComponent], never, [typeof AcmeOldButtonComponent]>;
}

export declare class AcmeBannerComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeBannerComponent, "acme-banner", never, { "tone": { "alias": "tone"; "required": false; "isSignal": true; }; }, {}, never, never, true, never>;
}

export declare class AcmeChipComponent {
  static ɵcmp: i0.ɵɵComponentDeclaration<AcmeChipComponent, "acme-chip", never, {}, {}, never, never, true, never>;
}
