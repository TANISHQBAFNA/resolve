import { formatLearnedAt } from "../src/server/localTime.ts";

const iso = process.env["LEARNED_AT"] ?? "";
process.stdout.write(formatLearnedAt(iso));
