// Writes figma-acme-edge.json: a REST-shaped Acme library file (fileKey ACMEEDGE). Made-up names only.
import { writeFileSync } from "node:fs";
const P = { V: (o) => ({ type: "VARIANT", defaultValue: o[0], variantOptions: o }), B: { type: "BOOLEAN", defaultValue: false }, T: { type: "TEXT", defaultValue: "x" } };
const M = [
  ["1:1", "Button", { Variant: P.V(["Primary", "Secondary"]), Size: P.V(["Small", "Medium"]), Disabled: P.B }, []],
  ["1:2", "Button group", {}, ["1:1"]],
  ["1:3", "Icon button", { Icon: P.T, Disabled: P.B }, ["1:28"]],
  ["1:4", "Button Legacy", { Label: P.T }, [], true],
  ["1:5", "Card", { Title: P.T }, ["1:6"]],
  ["1:6", "Card header", { Title: P.T }, []],
  ["1:7", "Cart", {}, []],
  ["1:8", "Header card", {}, []],
  ["1:9", "Tooltip", {}, []],
  ["1:10", "Chip", { Label: P.T }, []],
  ["1:11", "Tag", {}, []],
  ["1:12", "Badge", {}, []],
  ["1:13", "Pill", {}, []],
  ["1:14", "Toggle", {}, []],
  ["1:15", "Switch", { Checked: P.B }, []],
  ["1:16", "Checkbox", {}, []],
  ["1:17", "Select", {}, []],
  ["1:18", "Dropdown", {}, []],
  ["1:19", "Form field", { Label: P.T, Hint: P.T, Error: P.T }, ["1:20"]],
  ["1:20", "Text input", {}, []],
  ["1:21", "Dialog", {}, ["1:22", "1:23", "1:24", "1:1"]],
  ["1:22", "Dialog header", {}, []],
  ["1:23", "Dialog body", {}, []],
  ["1:24", "Dialog footer", {}, []],
  ["1:25", "Date range picker", {}, []],
  ["1:26", "Tabs", {}, ["1:27"]],
  ["1:27", "Tab", {}, []],
  ["1:28", "Icon", {}, []],
  ["1:29", "Alert", {}, ["1:28"], true],
  ["1:30", "Banner", {}, []],
  ["1:31", "Old Stepper", {}, ["1:1"], true],
  ["1:32", "Avatar", {}, []],
  ["1:33", "Spinner", {}, []],
  ["1:34", "Loader", {}, []],
  ["1:35", "Breadcrumbs", {}, []],
  ["1:36", "Pagination", {}, []],
  ["1:37", "Progress bar", {}, []],
  ["1:38", "Radio", {}, []],
  ["1:39", "Radio group", {}, []],
  ["1:40", "Menu", {}, ["1:41"]],
  ["1:41", "Menu item", {}, []],
  ["1:42", "Table", {}, []],
  ["1:43", "Slider", {}, []],
  ["1:44", "Snackbar", {}, []],
  ["1:45", "Data list", {}, []],
  ["1:46", "Base field", {}, []],
];
const name = Object.fromEntries(M.map(([id, n]) => [id, n]));
let k = 0;
const inst = (cid) => ({ id: `I${++k}:${cid}`, name: name[cid], type: "INSTANCE", componentId: cid });
const comp = ([id, n, props, nests, dep]) => ({
  id, name: n, type: "COMPONENT", ...(Object.keys(props).length ? { componentPropertyDefinitions: props } : {}),
  ...(dep ? { description: "status: deprecated" } : {}), children: nests.map(inst),
});
const live = M.filter((m) => !m[4]).map((m) => m[0]);
export function file(version) {
  k = 0;
  return {
    name: "Acme Edge UI", version,
    document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [
      { id: "0:1", name: "Parts", type: "CANVAS", children: M.map(comp) },
      { id: "0:2", name: "Screens", type: "CANVAS", children: [
        { id: "9:1", name: "Edge screen", type: "FRAME", children: live.map(inst) },
        { id: "9:2", name: "Retired screen", type: "FRAME", children: ["1:4", "1:29", "1:31"].map(inst) },
      ] },
    ] },
    components: Object.fromEntries(M.map(([id, n, , , dep]) => [id, { key: `k-${id}`, name: n, description: dep ? "status: deprecated" : "" }])),
    componentSets: {}, styles: {},
  };
}
writeFileSync(new URL("./figma-acme-edge.json", import.meta.url), JSON.stringify(file("2026.10.1"), null, 1));
writeFileSync(new URL("./figma-acme-edge-v2.json", import.meta.url), JSON.stringify(file("2026.11.0"), null, 1));
