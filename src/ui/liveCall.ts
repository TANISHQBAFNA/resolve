/** What the screen may show after a live call. Sample data is never a stand-in for a failure. */

export interface LiveFailure {
  message: string;
  next: string;
}

export const RULES_LOAD_FAILURE: LiveFailure = {
  message: "Could not load the rules for this project.",
  next: "Reload the page. If it still fails, run npm run resolve -- rules in this project.",
};

export const SCOREBOARD_LOAD_FAILURE: LiveFailure = {
  message: "Could not load the scoreboard.",
  next: "Run npm run resolve -- score phrases in this project, then reload the page.",
};

export const LIBRARY_LOAD_NEXT =
  "Check the Figma link and the token, then try Load Figma again. An example library is not shown in place of this result.";

export type LiveView<T> =
  | { status: "loading" }
  | { status: "live"; data: T }
  | { status: "error"; failure: LiveFailure };

/** ok + a body is the live result. Anything else is an error, even if a sample body was passed in. */
export function viewFromLiveResponse<T>(
  ok: boolean,
  data: T | null | undefined,
  failure: LiveFailure,
): Exclude<LiveView<T>, { status: "loading" }> {
  if (!ok || data == null) return { status: "error", failure };
  return { status: "live", data };
}

/** The live body, or nothing. An error never returns a sample that was sitting nearby. */
export function dataIfLive<T>(view: LiveView<T>): T | undefined {
  if (view.status === "live") return view.data;
  return undefined;
}
