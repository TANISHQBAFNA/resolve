import lexicon from "@/data/screen-jobs.json";

/**
 * Screen jobs. A job word has a meaning ("inquiry": look up something that already exists).
 * The parts of a job come only from verified frames in SOCK, never from this file.
 */

export interface ScreenJob {
  id: string;
  meaning: string;
  words: string[];
}

export const SCREEN_JOBS: ScreenJob[] = lexicon.jobs;

const JOB_BY_WORD = new Map(SCREEN_JOBS.flatMap((job) => job.words.map((word) => [word, job.id] as const)));

/** Words that never identify a screen type on their own. */
const GENERIC_SCREEN_WORDS = new Set([
  "screen",
  "page",
  "frame",
  "view",
  "untitled",
  "copy",
  "artboard",
  "section",
  "canvas",
  "layer",
  "default",
  "draft",
  "wip",
  "temp",
  "tmp",
  "final",
  "component",
  "group",
  "variant",
  "master",
  "instance",
  "node",
]);

export function isGenericScreenToken(token: string): boolean {
  if (GENERIC_SCREEN_WORDS.has(token)) return true;
  return /^v\d+$/.test(token);
}

/** Small words an ask may carry around a job ("the payment screen"). */
const FILLER_WORDS = new Set(["a", "an", "the", "for", "of", "my", "our"]);

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function jobById(id: string): ScreenJob | undefined {
  return SCREEN_JOBS.find((job) => job.id === id);
}

/**
 * The jobs an ask is made of, in ask order, when every word left after generic screen words is a job word.
 * "inquiry screen" -> ["inquiry"]; "approval summary" -> ["approval", "summary"]; "payment button" -> undefined.
 */
export function jobsInAsk(ask: string): string[] | undefined {
  const words = tokensOf(ask).filter((token) => !isGenericScreenToken(token) && !FILLER_WORDS.has(token));
  if (!words.length) return undefined;
  const jobs: string[] = [];
  for (const word of words) {
    const job = JOB_BY_WORD.get(word);
    if (!job) return undefined;
    if (!jobs.includes(job)) jobs.push(job);
  }
  return jobs;
}

/** The one job a frame name or journey names, among any other words. Two different jobs, or none: undefined. */
export function jobOfName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const jobs = new Set(tokensOf(text).flatMap((token) => (JOB_BY_WORD.has(token) ? [JOB_BY_WORD.get(token)!] : [])));
  return jobs.size === 1 ? [...jobs][0] : undefined;
}
