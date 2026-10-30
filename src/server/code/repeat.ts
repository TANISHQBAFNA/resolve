import { readFileSync } from "node:fs";
import { mulberry32 } from "@/core/layout/force";
import type { ResolveConfig } from "../mode.ts";
import { pickComponents } from "./pick.ts";
import { buildCatalog, catalogDigest, loadCatalog, type CodeCatalog } from "./scan.ts";

/** One request. `expect` and `alt` (acceptable alternates) are component names, used only for accuracy. */
export interface PickRequest {
  request: string;
  expect?: string;
  alt?: string[];
}

export interface RepeatOptions {
  runs: number;
  rescan?: boolean;
  shuffle?: boolean;
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export function readRequests(file: string): PickRequest[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const list = Array.isArray(data) ? data : (data as { requests?: unknown }).requests;
  if (!Array.isArray(list)) throw new Error(`${file}: expected a JSON array of requests (or { "requests": [...] }).`);
  return list.map((item) => (typeof item === "string" ? { request: item } : (item as PickRequest)));
}

/** Run every request `runs` times, optionally rebuilding the catalog (and reading files in a shuffled order) each time. */
export function repeatCheck(cfg: ResolveConfig, requests: PickRequest[], options: RepeatOptions) {
  const runs = Math.max(1, Math.floor(options.runs));
  const top3: string[][][] = []; // [run][request] -> names
  const digests: string[] = [];
  for (let run = 0; run < runs; run += 1) {
    const catalog: CodeCatalog = options.rescan || options.shuffle ? buildCatalog(cfg, options.shuffle ? (items) => shuffled(items, run + 1) : undefined) : loadCatalog(cfg);
    digests.push(catalogDigest(catalog));
    top3.push(requests.map((r) => pickComponents(catalog, r.request, 3).components.map((c) => c.name)));
  }
  const rows = requests.map((r, i) => {
    const first = (top3[0] as string[][])[i] as string[];
    const same = top3.every((run) => (run[i] as string[])[0] === first[0]);
    const sameTop3 = top3.every((run) => (run[i] as string[]).join("|") === first.join("|"));
    const ok = r.expect ? [r.expect, ...(r.alt ?? [])] : [];
    return { request: r.request, expect: r.expect, top3: first, top1Same: same, top3Same: sameTop3, hit1: ok.length ? ok.includes(first[0] ?? "") : undefined, hit3: ok.length ? first.some((n) => ok.includes(n)) : undefined };
  });
  const count = (f: (row: (typeof rows)[number]) => boolean | undefined) => rows.filter((row) => f(row) === true).length;
  const scored = rows.filter((row) => row.hit1 !== undefined).length;
  return {
    runs,
    mode: `${options.rescan || options.shuffle ? "rescan" : "saved catalog"}${options.shuffle ? " + shuffled file order" : ""}`,
    requests: rows.length,
    catalogDigests: [...new Set(digests)],
    catalogSame: new Set(digests).size === 1,
    top1Same: count((r) => r.top1Same),
    top3Same: count((r) => r.top3Same),
    ...(scored ? { scored, top1Accuracy: count((r) => r.hit1), top3Accuracy: count((r) => r.hit3) } : {}),
    rows,
  };
}
