export declare const PHRASES: { notInstalled: string; nothingLearned: string; token: string; viewSeat: string };
export declare function commandPlan(screen?: string, repo?: string): [name: string, input: string][];
export declare function classify(name: string, events: unknown[]): { verdict: "pass" | "needs-Figma" | "fail"; why: string };
