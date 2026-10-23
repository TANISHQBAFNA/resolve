/**
 * Published Angular Material overview sentences, library id `angular-material`.
 * Each string is one sentence or one table cell from the v22.2.3 component
 * markdown (https://github.com/angular/components/tree/v22.2.3/src/material).
 * Hard wraps in that markdown are spaces. Nothing else is changed.
 * Pages: https://material.angular.dev/components/<slug>/overview
 * Documentation license: CC BY 4.0, © Google LLC.
 */
export const ANGULAR_MATERIAL_LIBRARY_ID = "angular-material";

export const DOC_ATTRIBUTION = "© Google LLC. Licensed under CC BY 4.0.";

export interface DocExcerpt {
  url: string;
  text: string;
}

const button = "https://material.angular.dev/components/button/overview";

const ANGULAR_MATERIAL_DOCS: Record<string, DocExcerpt> = {
  Button: {
    url: button,
    text: "Angular Material buttons are native `<button>` or `<a>` elements enhanced with Material Design styling.",
  },
  Checkbox: {
    url: "https://material.angular.dev/components/checkbox/overview",
    text: "`<mat-checkbox>` provides the same functionality as a native `<input type=\"checkbox\">` enhanced with Material Design styling and animations.",
  },
  Chip: {
    url: "https://material.angular.dev/components/chips/overview",
    text: "Chips allow users to view information, make selections, filter content, and enter data.",
  },
  "Date picker": {
    url: "https://material.angular.dev/components/datepicker/overview",
    text: "The datepicker allows users to enter a date either through text input, or by choosing a date from the calendar.",
  },
  Dialog: {
    url: "https://material.angular.dev/components/dialog/overview",
    text: "The `MatDialog` service can be used to open modal dialogs with Material Design styling and animations.",
  },
  "Expansion panel": {
    url: "https://material.angular.dev/components/expansion/overview",
    text: "`<mat-expansion-panel>` provides an expandable details-summary view.",
  },
  "Extended FAB": {
    url: button,
    text: "However, you can add the `extended` attribute to allow the fab to expand into a rounded rectangle shape with space for a text label in addition to the icon.",
  },
  FAB: {
    url: button,
    text: "Rectangular button w/ elevation and rounded corners, meant to contain an icon. Can be [extended](https://material.angular.dev/components/button/overview#extended-fab-buttons) to a rectangle to also fit a label",
  },
  "Icon button": {
    url: button,
    text: "Smaller, circular button, meant to contain an icon and no text",
  },
  List: {
    url: "https://material.angular.dev/components/list/overview",
    text: "`<mat-list>` is a container component that wraps and formats a series of `<mat-list-item>`.",
  },
  "List item": {
    url: "https://material.angular.dev/components/list/overview",
    text: "If a list item needs to show a single line of textual information, the text can be inserted directly into the `<mat-list-item>` element.",
  },
  Menu: {
    url: "https://material.angular.dev/components/menu/overview",
    text: "`<mat-menu>` is a floating panel containing list of options.",
  },
  "Mini FAB": {
    url: button,
    text: "Smaller variant of `matFab`",
  },
  Paginator: {
    url: "https://material.angular.dev/components/paginator/overview",
    text: "`<mat-paginator>` provides navigation for paged information, typically used with a table.",
  },
  "Radio button": {
    url: "https://material.angular.dev/components/radio/overview",
    text: "`<mat-radio-button>` provides the same functionality as a native `<input type=\"radio\">` enhanced with Material Design styling and animations.",
  },
  Select: {
    url: "https://material.angular.dev/components/select/overview",
    text: "`<mat-select>` is a form control for selecting a value from a set of options, similar to the native `<select>` element.",
  },
  "Slide toggle": {
    url: "https://material.angular.dev/components/slide-toggle/overview",
    text: "`<mat-slide-toggle>` is an on/off control that can be toggled via clicking.",
  },
  Slider: {
    url: "https://material.angular.dev/components/slider/overview",
    text: "`<mat-slider>` allows for the selection of a value from a range via mouse, touch, or keyboard, similar to `<input type=\"range\">`.",
  },
  Snackbar: {
    url: "https://material.angular.dev/components/snack-bar/overview",
    text: "`MatSnackBar` is a service for displaying snack-bar notifications.",
  },
  Tabs: {
    url: "https://material.angular.dev/components/tabs/overview",
    text: "Angular Material tabs organize content into separate views where only one view can be visible at a time.",
  },
  Tooltip: {
    url: "https://material.angular.dev/components/tooltip/overview",
    text: "The Angular Material tooltip provides a text label that is displayed when the user hovers over or longpresses an element.",
  },
};

/** Doc excerpts for a library id. Any other id, including a file name, gets none. */
export function docsForLibrary(libraryId: string | undefined): Record<string, DocExcerpt> | undefined {
  if (libraryId === ANGULAR_MATERIAL_LIBRARY_ID) return ANGULAR_MATERIAL_DOCS;
  return undefined;
}
