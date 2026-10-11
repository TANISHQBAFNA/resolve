import { describe, expect, it } from "vitest";
import { top1Label, top3Label } from "@/core/query/scoreLabels";
import { LIBRARY_LOAD_NEXT, RULES_LOAD_FAILURE, SCOREBOARD_LOAD_FAILURE, dataIfLive, viewFromLiveResponse } from "@/ui/liveCall";

const exampleRules = {
  rules: [{ label: "require payment/primary-action → Pay CTA" }, { label: "prefer Shared DS over Storefront" }],
  hint: "Sample from src/data/bind-rules.example.json",
};

describe("live call honesty", () => {
  it("a failed rules call is an error with a next step, and the example rules are not the result", () => {
    const failed = viewFromLiveResponse(false, exampleRules, RULES_LOAD_FAILURE);
    expect(failed.status).toBe("error");
    if (failed.status !== "error") return;
    expect(failed.failure.message).toMatch(/could not load the rules/i);
    expect(failed.failure.next).toMatch(/npm run resolve -- rules/);
    expect(dataIfLive(failed)).toBeUndefined();
    expect(JSON.stringify(failed)).not.toMatch(/Pay CTA/);
    expect(JSON.stringify(failed)).not.toMatch(/Shared DS/);
  });

  it("a thrown scoreboard call does not keep a sample score", () => {
    const sample = { latest: { pass: true, cases: 75, tools: [{ tool: "recommend", top1: 1 }] } };
    const failed = viewFromLiveResponse(false, undefined, SCOREBOARD_LOAD_FAILURE);
    expect(failed).toEqual({ status: "error", failure: SCOREBOARD_LOAD_FAILURE });
    expect(dataIfLive(failed)).toBeUndefined();
    expect(dataIfLive({ status: "live", data: sample })).toBe(sample);
    expect(SCOREBOARD_LOAD_FAILURE.next).toMatch(/score phrases/);
  });

  it("a live empty body is the result, not the example file", () => {
    const live = viewFromLiveResponse(true, { rules: [], hint: "Read-only." }, RULES_LOAD_FAILURE);
    expect(live).toEqual({ status: "live", data: { rules: [], hint: "Read-only." } });
    expect(dataIfLive(live)).toEqual({ rules: [], hint: "Read-only." });
    expect(dataIfLive(live)).not.toBe(exampleRules);
  });

  it("a missing body is an error, not a silent sample", () => {
    expect(viewFromLiveResponse(true, null, RULES_LOAD_FAILURE).status).toBe("error");
    expect(viewFromLiveResponse(true, undefined, RULES_LOAD_FAILURE).status).toBe("error");
  });

  it("the library failure names a next step and refuses to stand in with an example", () => {
    expect(LIBRARY_LOAD_NEXT).toMatch(/Next:|Check the Figma link/i);
    expect(LIBRARY_LOAD_NEXT).toMatch(/example library is not shown/i);
  });

  it("top-1 is a count, and top-3 on one card is not a rate", () => {
    expect(top1Label(56, 56)).toBe("56/56");
    expect(top1Label(0, 0)).toBe("n/a");
    expect(top3Label(1, 1)).toBe("n/a (N=1)");
    expect(top3Label(0, 0)).toBe("n/a (N=0)");
    expect(top3Label(12, 20)).toBe("12/20");
  });
});
