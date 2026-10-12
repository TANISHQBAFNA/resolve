import { z } from "zod";

/**
 * Cleaned Figma `componentPropertyDefinitions`.
 * Stored on the component set or the standalone component.
 * Current values on a placed instance stay in `metadata.componentProperties`.
 */
export const COMPONENT_PROPERTY_TYPES = ["VARIANT", "BOOLEAN", "TEXT", "INSTANCE_SWAP", "UNKNOWN"] as const;

export const ComponentPropertyTypeSchema = z.enum(COMPONENT_PROPERTY_TYPES);
export type ComponentPropertyType = z.infer<typeof ComponentPropertyTypeSchema>;

export const ComponentPropertySchema = z.object({
  /** Name with the Figma `#12:3` id removed. */
  name: z.string().min(1),
  type: ComponentPropertyTypeSchema,
  /** Display default. Omitted when the source did not give one. */
  defaultValue: z.string().optional(),
  /** Instance-swap default id or key, kept for verify. Not a display name. */
  defaultId: z.string().optional(),
  defaultUnknown: z.literal(true).optional(),
  /** Allowed values the source named. Booleans are `true` and `false`. */
  options: z.array(z.string()).optional(),
  optionsUnknown: z.literal(true).optional(),
  /** Instance-swap component keys. Not shown as names. */
  keys: z.array(z.string()).optional(),
  /** Preferred swaps whose component name was not in this file. */
  unresolvedPreferred: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
  descriptionUnknown: z.literal(true).optional(),
  /** Set when the name is a Figma placeholder such as "Property 1". */
  rename: z.string().optional(),
});
export type ComponentProperty = z.infer<typeof ComponentPropertySchema>;

const ID_SUFFIX = /#\d+:\d+$/;
const PLACEHOLDER_NAME = /^property\s+\d+$/i;

/** Strip Figma's `#12:3` suffix. Flag placeholder names such as `Property 1`. */
export function cleanPropertyName(raw: string): { name: string; rename?: string } {
  const stripped = raw.replace(ID_SUFFIX, "").trim();
  const name = stripped || raw.trim();
  if (PLACEHOLDER_NAME.test(name)) {
    return { name, rename: `Rename "${name}" in Figma. It is a placeholder.` };
  }
  return { name };
}
