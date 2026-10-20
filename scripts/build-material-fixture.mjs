/**
 * Build fixtures/material/library.json from the public Material 3 spec.
 *
 * The official Material 3 Figma kit was not read. No Figma key or token is used.
 * Color values are the baseline scheme for seed #6750A4 from
 * @material/material-color-utilities 0.3.0 `themeFromSourceColor` (not a dependency).
 * Token names are Material 3 system tokens (md.sys.color.*, md.sys.typescale.*, md.sys.shape.*, md.sys.elevation.*).
 * Component variants follow https://m3.material.io/components
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "material");

const LIGHT = {
  primary: "#6750a4",
  "on-primary": "#ffffff",
  "primary-container": "#e9ddff",
  "on-primary-container": "#22005d",
  secondary: "#625b71",
  "on-secondary": "#ffffff",
  "secondary-container": "#e8def8",
  "on-secondary-container": "#1e192b",
  tertiary: "#7e5260",
  "on-tertiary": "#ffffff",
  "tertiary-container": "#ffd9e3",
  "on-tertiary-container": "#31101d",
  error: "#ba1a1a",
  "on-error": "#ffffff",
  "error-container": "#ffdad6",
  "on-error-container": "#410002",
  background: "#fffbff",
  "on-background": "#1c1b1e",
  surface: "#fffbff",
  "on-surface": "#1c1b1e",
  "surface-variant": "#e7e0eb",
  "on-surface-variant": "#49454e",
  outline: "#7a757f",
  "outline-variant": "#cac4cf",
  shadow: "#000000",
  scrim: "#000000",
  "inverse-surface": "#313033",
  "inverse-on-surface": "#f4eff4",
  "inverse-primary": "#cfbcff",
  "surface-tint": "#6750a4",
};

const DARK = {
  primary: "#cfbcff",
  "on-primary": "#381e72",
  "primary-container": "#4f378a",
  "on-primary-container": "#e9ddff",
  secondary: "#cbc2db",
  "on-secondary": "#332d41",
  "secondary-container": "#4a4458",
  "on-secondary-container": "#e8def8",
  tertiary: "#efb8c8",
  "on-tertiary": "#4a2532",
  "tertiary-container": "#633b48",
  "on-tertiary-container": "#ffd9e3",
  error: "#ffb4ab",
  "on-error": "#690005",
  "error-container": "#93000a",
  "on-error-container": "#ffb4ab",
  background: "#1c1b1e",
  "on-background": "#e6e1e6",
  surface: "#1c1b1e",
  "on-surface": "#e6e1e6",
  "surface-variant": "#49454e",
  "on-surface-variant": "#cac4cf",
  outline: "#948f99",
  "outline-variant": "#49454e",
  shadow: "#000000",
  scrim: "#000000",
  "inverse-surface": "#e6e1e6",
  "inverse-on-surface": "#313033",
  "inverse-primary": "#6750a4",
  "surface-tint": "#cfbcff",
};

/** Public type scale. Size and line height are in dp. https://m3.material.io/styles/typography/type-scale-tokens */
const TYPE = [
  ["display-large", 57, 64],
  ["display-medium", 45, 52],
  ["display-small", 36, 44],
  ["headline-large", 32, 40],
  ["headline-medium", 28, 36],
  ["headline-small", 24, 32],
  ["title-large", 22, 28],
  ["title-medium", 16, 24],
  ["title-small", 14, 20],
  ["body-large", 16, 24],
  ["body-medium", 14, 20],
  ["body-small", 12, 16],
  ["label-large", 14, 20],
  ["label-medium", 12, 16],
  ["label-small", 11, 16],
];

/** https://m3.material.io/styles/shape/shape-scale-tokens */
const SHAPE = [
  ["none", 0],
  ["extra-small", 4],
  ["small", 8],
  ["medium", 12],
  ["large", 16],
  ["extra-large", 28],
  ["full", 999],
];

/** https://m3.material.io/styles/elevation/tokens */
const ELEVATION = [
  ["level0", 0],
  ["level1", 1],
  ["level2", 3],
  ["level3", 6],
  ["level4", 8],
  ["level5", 12],
];

const BUTTONS = "https://m3.material.io/components/buttons/overview";
const ICON_BUTTONS = "https://m3.material.io/components/icon-buttons/overview";
const FAB = "https://m3.material.io/components/floating-action-button/overview";
const SEGMENTED = "https://m3.material.io/components/segmented-buttons/overview";
const BADGE = "https://m3.material.io/components/badges/overview";
const PROGRESS = "https://m3.material.io/components/progress-indicators/overview";
const SNACKBAR = "https://m3.material.io/components/snackbar/overview";
const TOOLTIP = "https://m3.material.io/components/tooltips/overview";
const SHEET = "https://m3.material.io/components/bottom-sheets/overview";
const CARD = "https://m3.material.io/components/cards/overview";
const DIALOG = "https://m3.material.io/components/dialogs/overview";
const DIVIDER = "https://m3.material.io/components/divider/overview";
const LISTS = "https://m3.material.io/components/lists/overview";
const SIDE = "https://m3.material.io/components/side-sheets/overview";
const NAV_BAR = "https://m3.material.io/components/navigation-bar/overview";
const NAV_DRAWER = "https://m3.material.io/components/navigation-drawer/overview";
const NAV_RAIL = "https://m3.material.io/components/navigation-rail/overview";
const TABS = "https://m3.material.io/components/tabs/overview";
const APP_BAR = "https://m3.material.io/components/top-app-bar/overview";
const CHECKBOX = "https://m3.material.io/components/checkbox/overview";
const CHIPS = "https://m3.material.io/components/chips/overview";
const DATE = "https://m3.material.io/components/date-pickers/overview";
const MENUS = "https://m3.material.io/components/menus/overview";
const RADIO = "https://m3.material.io/components/radio-button/overview";
const SLIDER = "https://m3.material.io/components/sliders/overview";
const SWITCH = "https://m3.material.io/components/switch/overview";
const TIME = "https://m3.material.io/components/time-pickers/overview";
const TEXT = "https://m3.material.io/components/text-fields/overview";
const SEARCH = "https://m3.material.io/components/search/overview";
const ANGULAR = "https://material.angular.dev/components/categories";

/** @type {Array<{ page: string, items: Spec[] }>} */
const PAGES = [
  {
    page: "Actions",
    items: [
      spec("Button", BUTTONS, "Five button types from the Material 3 spec.", [["Type", ["Filled", "Outlined", "Text", "Elevated", "Tonal"]]], [
        prop("Label", "TEXT", "Button"),
        prop("Disabled", "BOOLEAN", false),
        prop("Icon", "SLOT"),
      ], "md.sys.color.primary"),
      spec("Icon button", ICON_BUTTONS, "Icon button. Standard, filled, tonal, and outlined.", [["Type", ["Standard", "Filled", "Tonal", "Outlined"]]], [
        prop("Toggle", "BOOLEAN", false),
      ], "md.sys.color.primary"),
      spec("FAB", FAB, "Floating action button. Small, regular, and large.", [["Size", ["Small", "Regular", "Large"]]], [
        prop("Icon", "SLOT"),
      ], "md.sys.color.primary-container"),
      spec("Mini FAB", FAB, "Small floating action button.", [], [prop("Icon", "SLOT")], "md.sys.color.primary-container"),
      spec("Extended FAB", FAB, "Floating action button with a label.", [["Size", ["Small", "Medium", "Large"]]], [
        prop("Label", "TEXT", "Create"),
        prop("Icon", "SLOT"),
      ], "md.sys.color.primary-container"),
      spec("Legacy button", BUTTONS, "deprecated. Replaced by Button.", [], [
        prop("Label", "TEXT", "Old"),
      ], "md.sys.color.primary"),
      spec("Button toggle", SEGMENTED, "Segmented button. Single or multi select.", [], [
        prop("Selected", "BOOLEAN", false),
        prop("Label", "TEXT", "Option"),
      ], "md.sys.color.secondary-container"),
    ],
  },
  {
    page: "Communication",
    items: [
      spec("Badge", BADGE, "Small status mark on another part.", [], [prop("Label", "TEXT", "1")], "md.sys.color.error"),
      spec("Progress bar", PROGRESS, "Linear progress indicator.", [], [prop("Indeterminate", "BOOLEAN", false)], "md.sys.color.primary"),
      spec("Progress spinner", PROGRESS, "Circular progress indicator.", [], [prop("Indeterminate", "BOOLEAN", true)], "md.sys.color.primary"),
      spec("Snackbar", SNACKBAR, "Brief message at the bottom of the screen.", [], [
        prop("Message", "TEXT", "Saved"),
        prop("Action", "SLOT"),
      ], "md.sys.color.inverse-surface"),
      spec("Tooltip", TOOLTIP, "Label for an icon-only control.", [], [prop("Label", "TEXT", "More")], "md.sys.color.inverse-surface"),
    ],
  },
  {
    page: "Containment",
    items: [
      spec("Bottom sheet", SHEET, "Surface that slides up from the bottom.", [], [
        prop("Content", "SLOT"),
        prop("Actions", "SLOT"),
      ], "md.sys.color.surface"),
      spec("Card", CARD, "Elevated, filled, and outlined cards.", [["Type", ["Elevated", "Filled", "Outlined"]]], [
        prop("Media", "SLOT"),
        prop("Content", "SLOT"),
        prop("Actions", "SLOT"),
      ], "md.sys.color.surface"),
      spec("Dialog", DIALOG, "Basic dialog and full-screen dialog.", [["Type", ["Basic", "Full-screen"]]], [
        prop("Headline", "TEXT", "Title"),
        prop("Content", "SLOT"),
        prop("Actions", "SLOT"),
      ], "md.sys.color.surface"),
      spec("Divider", DIVIDER, "Hairline between items.", [], [], "md.sys.color.outline-variant"),
      spec("List", LISTS, "Vertical list of rows.", [], [prop("Rows", "SLOT")], "md.sys.color.surface"),
      spec("List item", LISTS, "One, two, or three line row.", [["Lines", ["One", "Two", "Three"]]], [
        prop("Leading", "SLOT"),
        prop("Headline", "TEXT", "Title"),
        prop("Trailing", "SLOT"),
      ], "md.sys.color.surface"),
      spec("Side sheet", SIDE, "Sheet docked to the side. Material 3 has no separate Angular class for this.", [], [
        prop("Content", "SLOT"),
      ], "md.sys.color.surface"),
    ],
  },
  {
    page: "Navigation",
    items: [
      spec("Navigation bar", NAV_BAR, "Bottom navigation. Material 3. No matching Angular Material class.", [], [prop("Destinations", "SLOT")], "md.sys.color.surface"),
      spec("Navigation rail", NAV_RAIL, "Side rail for a few destinations. No matching Angular Material class.", [], [prop("Destinations", "SLOT")], "md.sys.color.surface"),
      spec("Sidenav", NAV_DRAWER, "Navigation drawer.", [], [prop("Content", "SLOT")], "md.sys.color.surface"),
      spec("Tabs", TABS, "Tabs.", [], [prop("Tabs", "SLOT")], "md.sys.color.primary"),
      spec("Toolbar", APP_BAR, "Top app bar.", [["Type", ["Center aligned", "Small", "Medium", "Large"]]], [
        prop("Title", "TEXT", "Title"),
        prop("Trailing", "SLOT"),
      ], "md.sys.color.surface"),
    ],
  },
  {
    page: "Selection",
    items: [
      spec("Checkbox", CHECKBOX, "Select one or more.", [], [prop("Checked", "BOOLEAN", false)], "md.sys.color.primary"),
      spec("Chip", CHIPS, "Assist, filter, input, and suggestion chips.", [["Type", ["Assist", "Filter", "Input", "Suggestion"]]], [
        prop("Label", "TEXT", "Chip"),
        prop("Selected", "BOOLEAN", false),
        prop("Leading", "SLOT"),
      ], "md.sys.color.secondary-container"),
      spec("Date picker", DATE, "Pick a date.", [], [prop("Headline", "SLOT")], "md.sys.color.surface"),
      spec("Menu", MENUS, "List of choices anchored to a control.", [], [prop("Items", "SLOT")], "md.sys.color.surface"),
      spec("Radio button", RADIO, "Pick one of a set.", [], [prop("Checked", "BOOLEAN", false)], "md.sys.color.primary"),
      spec("Slider", SLIDER, "Pick a value along a track.", [], [prop("Value", "TEXT", "40")], "md.sys.color.primary"),
      spec("Slide toggle", SWITCH, "Switch. On or off.", [], [prop("Checked", "BOOLEAN", false)], "md.sys.color.primary"),
      spec("Time picker", TIME, "Pick a time.", [], [prop("Headline", "SLOT")], "md.sys.color.surface"),
      spec("Select", `${ANGULAR}`, "Closed menu of options. Angular Material select. Material 3 uses a menu for this job.", [], [
        prop("Label", "TEXT", "Choose"),
        prop("Options", "SLOT"),
      ], "md.sys.color.surface"),
    ],
  },
  {
    page: "Text inputs",
    items: [
      spec("Text field", TEXT, "Filled and outlined text fields.", [["Type", ["Filled", "Outlined"]]], [
        prop("Label", "TEXT", "Label"),
        prop("Supporting text", "TEXT", ""),
        prop("Error", "BOOLEAN", false),
        prop("Leading", "SLOT"),
        prop("Trailing", "SLOT"),
      ], "md.sys.color.surface"),
      spec("Form field", TEXT, "Label, hint, and error around an input.", [], [
        prop("Label", "TEXT", "Label"),
        prop("Input", "SLOT"),
      ], "md.sys.color.surface"),
      spec("Search bar", SEARCH, "Search. Material 3 search. Angular Material has no search-bar class.", [], [
        prop("Query", "TEXT", "Search"),
        prop("Leading", "SLOT"),
        prop("Trailing", "SLOT"),
      ], "md.sys.color.surface"),
    ],
  },
  {
    page: "Collections",
    items: [
      spec("Table", `${ANGULAR}`, "Data table.", [], [prop("Header", "SLOT"), prop("Rows", "SLOT")], "md.sys.color.surface"),
      spec("Paginator", `${ANGULAR}`, "Pages of a table.", [], [prop("Label", "TEXT", "1–10 of 40")], "md.sys.color.surface"),
      spec("Stepper", `${ANGULAR}`, "Steps in a task.", [], [prop("Steps", "SLOT")], "md.sys.color.surface"),
      spec("Expansion panel", `${ANGULAR}`, "A row that opens to show more.", [], [
        prop("Title", "TEXT", "Details"),
        prop("Content", "SLOT"),
      ], "md.sys.color.surface"),
      spec("Autocomplete", `${ANGULAR}`, "Text field with suggested options.", [], [prop("Options", "SLOT")], "md.sys.color.surface"),
      spec("Icon", `${ANGULAR}`, "Icon glyph.", [], [prop("Name", "TEXT", "search")], "md.sys.color.on-surface"),
      spec("Sort", `${ANGULAR}`, "Sortable column header.", [], [prop("Active", "BOOLEAN", false)], "md.sys.color.on-surface"),
      spec("Grid list", `${ANGULAR}`, "Tiles in a grid.", [], [prop("Tiles", "SLOT")], "md.sys.color.surface"),
      spec("Tree", `${ANGULAR}`, "Nested rows.", [], [prop("Nodes", "SLOT")], "md.sys.color.surface"),
    ],
  },
];

function prop(name, type, defaultValue) {
  return { name, type, defaultValue };
}

function spec(name, specUrl, blurb, variants, props, token) {
  return { name, specUrl, blurb, variants, props, token };
}

function hexToRgba(hex) {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return { r: round(r), g: round(g), b: round(b), a: 1 };
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

let seq = 1;
const nid = () => `1:${seq++}`;

const variableIds = [];
const variables = {};
const LIGHT_MODE = "1:0";
const DARK_MODE = "1:1";

function addColor(role) {
  const id = `VariableID:color:${role}`;
  variableIds.push(id);
  variables[id] = {
    id,
    name: `md.sys.color.${role}`,
    key: `md.sys.color.${role}`,
    variableCollectionId: "VariableCollectionId:m3:color",
    resolvedType: "COLOR",
    valuesByMode: {
      [LIGHT_MODE]: hexToRgba(LIGHT[role]),
      [DARK_MODE]: hexToRgba(DARK[role]),
    },
    remote: false,
    description: `Material 3 baseline color role md.sys.color.${role}. Seed #6750A4.`,
    hiddenFromPublishing: false,
    scopes: ["ALL_FILLS", "STROKE_COLOR"],
    codeSyntax: { WEB: `md.sys.color.${role}` },
  };
  return id;
}

function addFloat(name, value, description) {
  const id = `VariableID:float:${name}`;
  variableIds.push(id);
  variables[id] = {
    id,
    name,
    key: name,
    variableCollectionId: "VariableCollectionId:m3:metric",
    resolvedType: "FLOAT",
    valuesByMode: { [LIGHT_MODE]: value },
    remote: false,
    description,
    hiddenFromPublishing: false,
    scopes: ["ALL_SCOPES"],
    codeSyntax: { WEB: name },
  };
  return id;
}

for (const role of Object.keys(LIGHT)) addColor(role);
const metricIds = [];
for (const [name, size, line] of TYPE) {
  metricIds.push(addFloat(`md.sys.typescale.${name}.size`, size, `Material 3 type scale ${name}, font size.`));
  metricIds.push(addFloat(`md.sys.typescale.${name}.line-height`, line, `Material 3 type scale ${name}, line height.`));
}
for (const [name, value] of SHAPE) {
  metricIds.push(addFloat(`md.sys.shape.corner.${name}`, value, `Material 3 shape corner ${name}.`));
}
for (const [name, value] of ELEVATION) {
  metricIds.push(addFloat(`md.sys.elevation.${name}`, value, `Material 3 elevation ${name}.`));
}

const colorIds = variableIds.filter((id) => id.startsWith("VariableID:color:"));
const tokenId = Object.fromEntries(Object.values(variables).map((row) => [row.name, row.id]));

const components = {};
const componentSets = {};
const pages = [];
/** @type {Record<string, { setId?: string, variantId: string }>} */
const placed = {};

for (const page of PAGES) {
  const children = [];
  for (const item of page.items) {
    const defs = {};
    for (const [axis, options] of item.variants) {
      defs[axis] = { type: "VARIANT", defaultValue: options[0], variantOptions: options };
    }
    for (const row of item.props) {
      const body = { type: row.type };
      if (row.type !== "SLOT") body.defaultValue = row.defaultValue;
      defs[row.name] = body;
    }
    const setId = nid();
    const axes = item.variants;
    const combos = axes.length ? axes[0][1].map((value) => [[axes[0][0], value]]) : [[]];
    const variantNodes = [];
    for (const combo of combos) {
      const variantId = nid();
      const variantName = combo.length ? combo.map(([key, value]) => `${key}=${value}`).join(", ") : item.name;
      const node = {
        id: variantId,
        name: variantName,
        type: axes.length ? "COMPONENT" : "COMPONENT",
        description: item.blurb,
        documentationLinks: [{ uri: item.specUrl }],
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 48 },
      };
      if (axes.length) node.componentSetId = setId;
      if (item.token && combo === combos[0]) {
        node.boundVariables = {
          fills: [{ type: "VARIABLE_ALIAS", id: tokenId[item.token] }],
        };
      }
      if (!axes.length) {
        if (Object.keys(defs).length) node.componentPropertyDefinitions = defs;
        components[variantId] = { key: `m3spec-${slug(item.name)}`, name: item.name, description: item.blurb };
      } else {
        components[variantId] = {
          key: `m3spec-${slug(item.name)}-${slug(variantName)}`,
          name: variantName,
          description: item.blurb,
          componentSetId: setId,
        };
      }
      variantNodes.push(node);
      if (!placed[item.name]) placed[item.name] = { variantId, setId: axes.length ? setId : undefined, byValue: {} };
      const axisValue = combo[0]?.[1];
      if (axisValue) placed[item.name].byValue[axisValue] = variantId;
    }
    if (axes.length) {
      const setNode = {
        id: setId,
        name: item.name,
        type: "COMPONENT_SET",
        description: item.blurb,
        documentationLinks: [{ uri: item.specUrl }],
        absoluteBoundingBox: { x: 0, y: 0, width: 640, height: 160 },
        componentPropertyDefinitions: defs,
        children: variantNodes,
      };
      componentSets[setId] = { key: `m3spec-${slug(item.name)}`, name: item.name, description: item.blurb };
      children.push(setNode);
    } else {
      children.push(variantNodes[0]);
    }
  }
  pages.push({
    id: nid(),
    name: page.page,
    type: "CANVAS",
    children,
  });
}

const signIn = nid();
const email = placed["Text field"].variantId;
const button = placed["Button"].variantId;
const checkbox = placed["Checkbox"].variantId;
const toolbar = placed["Toolbar"].variantId;
const outlined = placed["Text field"].byValue["Outlined"];
const tonal = placed["Button"].byValue["Tonal"];
pages.push({
  id: nid(),
  name: "Screens",
  type: "CANVAS",
  children: [
    {
      id: signIn,
      name: "Sign in",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        instance(nid(), "Toolbar", toolbar),
        instance(nid(), "Text field", email),
        instance(nid(), "Text field", email),
        instance(nid(), "Checkbox", checkbox),
        instance(nid(), "Button", button),
      ],
    },
    {
      id: nid(),
      name: "Field sample",
      type: "FRAME",
      absoluteBoundingBox: { x: 420, y: 0, width: 390, height: 844 },
      children: [
        instance(nid(), "Form field", placed["Form field"].variantId),
        instance(nid(), "Text field", outlined),
        instance(nid(), "Button", tonal),
      ],
    },
  ],
});


function instance(id, name, componentId) {
  return {
    id,
    name,
    type: "INSTANCE",
    componentId,
    absoluteBoundingBox: { x: 16, y: 16, width: 358, height: 48 },
  };
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const file = {
  name: "Material 3",
  version: "public-spec-2026-10-20",
  lastModified: "2026-10-20T00:00:00.000Z",
  fileKey: "M3SPEC",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: pages,
  },
  components,
  componentSets,
  variables: {
    meta: {
      variableCollections: {
        "VariableCollectionId:m3:color": {
          id: "VariableCollectionId:m3:color",
          name: "md.sys.color",
          key: "md.sys.color",
          modes: [
            { modeId: LIGHT_MODE, name: "Light" },
            { modeId: DARK_MODE, name: "Dark" },
          ],
          defaultModeId: LIGHT_MODE,
          remote: false,
          hiddenFromPublishing: false,
          variableIds: colorIds,
        },
        "VariableCollectionId:m3:metric": {
          id: "VariableCollectionId:m3:metric",
          name: "md.sys.metric",
          key: "md.sys.metric",
          modes: [{ modeId: LIGHT_MODE, name: "Value" }],
          defaultModeId: LIGHT_MODE,
          remote: false,
          hiddenFromPublishing: false,
          variableIds: metricIds,
        },
      },
      variables,
    },
  },
};

writeFileSync(join(root, "library.json"), `${JSON.stringify(file, null, 2)}\n`);
process.stdout.write(`Wrote ${join(root, "library.json")} (${pages.length} pages).\n`);
