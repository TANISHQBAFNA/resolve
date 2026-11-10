import lexicon from "@/data/element-jobs.json";

/**
 * Element jobs. One vocabulary for every library.
 * The file names no product, brand, or master.
 */

export const JOB_GROUPS = ["act", "enter", "choose a setting", "show", "tell", "mark", "structure"] as const;
export type JobGroup = (typeof JOB_GROUPS)[number];

export interface ElementJob {
  id: string;
  group: JobGroup;
  meaning: string;
  words: readonly string[];
}

function isGroup(value: string): value is JobGroup {
  return (JOB_GROUPS as readonly string[]).includes(value);
}

export const ELEMENT_JOBS: readonly ElementJob[] = lexicon.jobs.flatMap((job) => {
  if (!isGroup(job.group)) return [];
  return [{ id: job.id, group: job.group, meaning: job.meaning, words: job.words }];
});

const BY_WORD = new Map<string, string[]>();
for (const job of ELEMENT_JOBS) {
  for (const word of job.words) {
    const key = word.toLowerCase();
    const list = BY_WORD.get(key);
    if (list) list.push(job.id);
    else BY_WORD.set(key, [job.id]);
  }
}

const BY_ID = new Map(ELEMENT_JOBS.map((job) => [job.id, job]));

export function elementJob(id: string): ElementJob | undefined {
  return BY_ID.get(id);
}

export function jobsForWord(word: string): readonly string[] {
  return BY_WORD.get(word.toLowerCase()) ?? [];
}

export function jobWordSet(): ReadonlySet<string> {
  return new Set(BY_WORD.keys());
}
