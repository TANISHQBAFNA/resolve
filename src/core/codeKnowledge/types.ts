/** Coded-component knowledge (DSCK) and usage recipes (DSCI) written by an AI tool. */

export type KnowledgeSource = "ai" | "scanner";

export type KnowledgeField = "id" | "props" | "variants" | "parts" | "slots" | "tokens" | "aliases" | "components";

export interface KnowledgeWarning {
  message: string;
  next: string;
}

/** One claim from the AI file or from the scanner. */
export interface KnowledgePair {
  id: string;
  field: KnowledgeField;
  value: string;
  source: KnowledgeSource;
}

export interface KnowledgeAgreement {
  id: string;
  field: KnowledgeField;
  value: string;
}

export interface Evidence {
  file: string;
  line: number;
}

export interface ParsedClaim {
  name: string;
  evidence?: Evidence;
}

export interface ParsedComponent {
  id: string;
  name: string;
  figma?: string;
  props: ParsedClaim[];
  variants: ParsedClaim[];
  parts: ParsedClaim[];
  slots: ParsedClaim[];
  tokens: ParsedClaim[];
  aliases: ParsedClaim[];
  evidence?: Evidence;
}

export interface ParsedRecipe {
  id: string;
  components: string[];
  evidence?: Evidence;
}

/** What the scanner already found. The AI draft is compared with this. It does not replace it. */
export interface ScannedComponent {
  name: string;
  kind: "block" | "recipe";
  dsId?: string;
  variants: string[];
  elements: string[];
  tokens: string[];
  aliases: string[];
}

export interface ScannerSnapshot {
  files: string[];
  components: ScannedComponent[];
}

/** A mapping row for the same review file scanner drafts use. Never confirmed here. */
export interface MappingDraft {
  figma: string;
  code: string;
  status: "proposed";
  tier: "suggested";
  reason: "AI draft";
}

export interface KnowledgeReport {
  exitCode: 0;
  status: "proposed" | "confirmed" | "none";
  confirmed: boolean;
  warnings: KnowledgeWarning[];
  pairs: KnowledgePair[];
  agreements: KnowledgeAgreement[];
  disagreements: KnowledgePair[];
  mapping: MappingDraft[];
  draft?: { file: string; status: "proposed" | "confirmed" };
  mappingFile?: string;
  mappingProposed?: number;
  instructions?: string;
}
