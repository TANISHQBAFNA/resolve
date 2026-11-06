/** Shared MCP input fields. Described in full on the first tool; later tools point back. */
export const graphIdProperty = {
  graphId: {
    type: "string",
    description: "Graph to query. Optional when exactly one graph is stored.",
  },
};

/** Who the screen is for, and the accessibility bar. From the requirements or FSD, or the context pack. */
export const screenContextProperties = {
  audience: {
    type: "string",
    description: "Who the screen is for, taken from the requirements or FSD. Overrides the context pack for this call. Leave off when the document does not say.",
  },
  a11y: {
    type: "string",
    description: 'Accessibility bar from the requirements or FSD, e.g. "wcag-aa". Overrides the context pack for this call. Leave off when the document does not say. Does not run an audit.',
  },
};
