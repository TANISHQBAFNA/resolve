/**
 * Prototype readiness (`resolve ready`, MCP `ready`).
 * Lives in its own module so the server and code-engine line budgets stay put.
 * Every finding is a warning. The process exits 0 unless `--strict` is on.
 */

export const READY_ITEMS = ["components", "vendor", "tokens", "variants", "screens", "accessibility"] as const;
export type ReadyItemId = (typeof READY_ITEMS)[number];

/** `--strict` exit. Lowest code wins. 1 is a missing project folder. */
export const READY_EXIT: Record<ReadyItemId, number> = {
  components: 2,
  vendor: 3,
  tokens: 4,
  variants: 5,
  screens: 6,
  accessibility: 7,
};

export interface ReadyFinding {
  code: string;
  message: string;
  next: string;
  file?: string;
  line?: number;
}

export interface ReadyItem {
  id: ReadyItemId;
  status: "pass" | "warning";
  summary: string;
  findings: ReadyFinding[];
}

export interface ReadyResult {
  ok: boolean;
  project: string;
  reportPath: string;
  written: boolean;
  /** Process exit. 0 unless strict is on and something warned. */
  exitCode: number;
  /** What `--strict` would use. 0 when every item passes. */
  strictExitCode: number;
  items: ReadyItem[];
  markdown: string;
}

export const READY_USAGE = [
  "  resolve ready [project] [--json] [--strict] [--out <file>]",
  "      Readiness check for a vanilla HTML/CSS/JS prototype before it goes to developers.",
  "      Project folder: project.config.json, 2-brief/screens.md, 4-code/prototype (vendor/<name>@<ref>).",
  "      Writes 5-readiness/report.md. Each item is a pass or a warning with a next: step. Exit 0.",
  "      --strict (opt-in) exits 1 when the project folder is missing, else 2 components, 3 vendor, 4 tokens,",
  "      5 variants, 6 screens, 7 accessibility. The lowest code wins. The report is still written.",
];

export const READY_TOOL = {
  name: "ready",
  description:
    "Readiness check for a vanilla HTML, CSS and JS prototype before it goes to developers. Reads project.config.json, 2-brief/screens.md and 4-code/prototype, including the pinned vendor/<name>@<ref> copy. Writes 5-readiness/report.md. Each item is a pass or a warning with a next step. Never blocks. strict is opt-in and only changes exitCode on the result.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project folder. Default is the current working directory. It holds project.config.json, 2-brief/screens.md and 4-code/prototype.",
      },
      strict: {
        type: "boolean",
        description: "Opt-in. When true, exitCode is the finding code (lowest wins). The report is still written. The process is not stopped.",
      },
      out: {
        type: "string",
        description: "Report file. Default is 5-readiness/report.md inside the project folder.",
      },
    },
  },
};
