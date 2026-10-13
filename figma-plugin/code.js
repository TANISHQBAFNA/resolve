/**
 * Resolve — graph export plugin.
 *
 * Runs inside Figma and emits a `SourceDocument`: the same normalised shape the
 * REST and MCP adapters produce, so it drops straight into the app with no
 * conversion. Running in-document is what makes it strictly better than either:
 *
 *   - `instance.getMainComponentAsync()` gives exact instance -> component
 *     links, so nothing has to be inferred from layer names.
 *   - `figma.variables` gives variables and collections without an Enterprise
 *     plan and without a second endpoint.
 *   - `node.reactions` gives every prototype interaction, not just the single
 *     transition REST exposes.
 *   - `node.annotations` gives dev-mode annotations.
 *
 * No AST of the design is sent anywhere. The output is JSON you download.
 */

figma.showUI(__html__, { width: 380, height: 460 });

/* ------------------------------------------------------------------ utils */

const MIXED = figma.mixed;

function boundsOf(node) {
  const box = node.absoluteBoundingBox;
  if (!box) return undefined;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function hasImageFill(node) {
  const fills = node.fills;
  if (!fills || fills === MIXED || !Array.isArray(fills)) return false;
  return fills.some((fill) => fill.type === "IMAGE" || fill.type === "VIDEO");
}

/** Style slot -> style id, skipping mixed and empty slots. */
function styleIdsOf(node, styleIds) {
  const slots = {
    fill: node.fillStyleId,
    stroke: node.strokeStyleId,
    text: node.textStyleId,
    effect: node.effectStyleId,
    grid: node.gridStyleId,
  };
  const out = {};
  for (const slot of Object.keys(slots)) {
    const id = slots[slot];
    if (!id || id === MIXED || typeof id !== "string") continue;
    out[slot] = id;
    styleIds.add(id);
  }
  return Object.keys(out).length ? out : undefined;
}

function variableIdsOf(node, variableIds) {
  const bound = node.boundVariables;
  if (!bound) return undefined;
  const out = {};
  for (const property of Object.keys(bound)) {
    const value = bound[property];
    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        if (entry && entry.id) {
          out[property + "[" + i + "]"] = entry.id;
          variableIds.add(entry.id);
        }
      });
    } else if (value && value.id) {
      out[property] = value.id;
      variableIds.add(value.id);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Every prototype interaction, not just the first. */
function transitionsOf(node) {
  const reactions = node.reactions;
  if (!reactions || !reactions.length) return undefined;

  const out = [];
  for (const reaction of reactions) {
    const actions = reaction.actions || (reaction.action ? [reaction.action] : []);
    for (const action of actions) {
      if (!action || !action.destinationId) continue;
      const transition = action.transition || {};
      out.push({
        destinationId: action.destinationId,
        trigger: reaction.trigger ? reaction.trigger.type : "ON_CLICK",
        action: action.navigation || action.type || "NAVIGATE",
        durationMs:
          typeof transition.duration === "number"
            ? Math.round(transition.duration * 1000)
            : undefined,
        easing: transition.easing ? transition.easing.type : undefined,
      });
    }
  }
  return out.length ? out : undefined;
}

function linksOf(node) {
  const links = [];
  if (node.type === "TEXT") {
    const hyperlink = node.hyperlink;
    if (hyperlink && hyperlink.type === "URL" && hyperlink.value) {
      links.push({ url: hyperlink.value });
    }
  }
  if (Array.isArray(node.documentationLinks)) {
    for (const entry of node.documentationLinks) {
      if (entry && entry.uri) links.push({ url: entry.uri, label: "Documentation" });
    }
  }
  return links.length ? links : undefined;
}

function annotationsOf(node) {
  const annotations = node.annotations;
  if (!Array.isArray(annotations) || !annotations.length) return undefined;
  return annotations
    .filter((annotation) => annotation && (annotation.label || annotation.labelMarkdown))
    .map((annotation) => ({
      label: annotation.label || annotation.labelMarkdown,
      properties: Array.isArray(annotation.properties)
        ? annotation.properties.reduce((acc, property) => {
            if (property && property.type) acc[property.type] = "true";
            return acc;
          }, {})
        : undefined,
    }));
}

/* ------------------------------------------------------------------ walk */

async function walk(node, context) {
  const { components, styleIds, variableIds, options, counters } = context;

  if (counters.visited >= options.maxNodes) {
    context.truncated = true;
    return undefined;
  }

  counters.visited += 1;
  if (counters.visited % 400 === 0) {
    figma.ui.postMessage({ type: "progress", visited: counters.visited });
    // Yield so the plugin UI stays responsive on a large file.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.visible === false) out.visible = false;
  if (node.description) out.description = node.description;

  const bounds = boundsOf(node);
  if (bounds) out.bounds = bounds;

  if (node.layoutMode && node.layoutMode !== "NONE") out.layoutMode = node.layoutMode;
  if (hasImageFill(node)) out.hasImageFill = true;

  const styles = styleIdsOf(node, styleIds);
  if (styles) out.styleIds = styles;

  const variables = variableIdsOf(node, variableIds);
  if (variables) out.variableIds = variables;

  const transitions = transitionsOf(node);
  if (transitions) out.transitions = transitions;

  const links = linksOf(node);
  if (links) out.links = links;

  const annotations = annotationsOf(node);
  if (annotations) out.annotations = annotations;

  if (node.type === "INSTANCE") {
    // The whole reason to run in-document: an exact link, not a name guess.
    const main = await node.getMainComponentAsync();
    if (main) {
      out.componentId = main.id;
      if (!components[main.id]) {
        const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
        components[main.id] = {
          id: main.id,
          key: main.key,
          name: main.name,
          description: main.description || undefined,
          componentSetId: set ? set.id : undefined,
          remote: Boolean(main.remote),
          identity: "id",
        };
        if (set && !context.componentSets[set.id]) {
          context.componentSets[set.id] = {
            id: set.id,
            key: set.key,
            name: set.name,
            description: set.description || undefined,
            remote: Boolean(set.remote),
            identity: "id",
          };
        }
      }
    }
    if (node.variantProperties) out.variantProperties = node.variantProperties;
    if (node.componentProperties) {
      out.componentProperties = JSON.parse(JSON.stringify(node.componentProperties));
    }
  }

  if (node.type === "COMPONENT") {
    if (node.parent && node.parent.type === "COMPONENT_SET") out.componentSetId = node.parent.id;
    if (node.variantProperties) out.variantProperties = node.variantProperties;
    if (!components[node.id]) {
      components[node.id] = {
        id: node.id,
        key: node.key,
        name: node.name,
        description: node.description || undefined,
        componentSetId: out.componentSetId,
        remote: Boolean(node.remote),
        identity: "id",
      };
    }
  }

  if (node.type === "COMPONENT_SET" && !context.componentSets[node.id]) {
    context.componentSets[node.id] = {
      id: node.id,
      key: node.key,
      name: node.name,
      description: node.description || undefined,
      remote: Boolean(node.remote),
      identity: "id",
    };
  }

  if ("children" in node && node.children.length && context.depth < options.maxDepth) {
    context.depth += 1;
    out.children = [];
    for (const child of node.children) {
      const next = await walk(child, context);
      if (!next) break;
      out.children.push(next);
    }
    context.depth -= 1;
  }

  return out;
}

/* ------------------------------------------------------- foundations */

async function collectStyles(styleIds) {
  const styles = {};

  const locals = [].concat(
    await figma.getLocalPaintStylesAsync(),
    await figma.getLocalTextStylesAsync(),
    await figma.getLocalEffectStylesAsync(),
    await figma.getLocalGridStylesAsync(),
  );
  for (const style of locals) {
    styles[style.id] = {
      id: style.id,
      key: style.key,
      name: style.name,
      styleType: style.type,
      description: style.description || undefined,
      remote: Boolean(style.remote),
    };
  }

  // Styles consumed from a library are not in the local lists.
  for (const id of styleIds) {
    if (styles[id]) continue;
    try {
      const style = await figma.getStyleByIdAsync(id);
      if (!style) continue;
      styles[id] = {
        id: style.id,
        key: style.key,
        name: style.name,
        styleType: style.type,
        description: style.description || undefined,
        remote: Boolean(style.remote),
      };
    } catch (error) {
      // A style we cannot resolve is reported by the app as UNRESOLVED_STYLE.
    }
  }

  return styles;
}

async function collectVariables(variableIds) {
  const collections = {};
  const variables = {};

  for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
    collections[collection.id] = {
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((mode) => ({ id: mode.modeId, name: mode.name })),
      remote: Boolean(collection.remote),
    };
  }

  const record = (variable) => {
    const aliasOf = [];
    const valuesByMode = {};
    for (const modeId of Object.keys(variable.valuesByMode || {})) {
      const value = variable.valuesByMode[modeId];
      valuesByMode[modeId] = value;
      if (value && value.type === "VARIABLE_ALIAS" && value.id) aliasOf.push(value.id);
    }
    variables[variable.id] = {
      id: variable.id,
      key: variable.key,
      name: variable.name,
      collectionId: variable.variableCollectionId,
      resolvedType: variable.resolvedType,
      description: variable.description || undefined,
      remote: Boolean(variable.remote),
      aliasOf: aliasOf.length ? aliasOf : undefined,
      valuesByMode,
    };
  };

  for (const variable of await figma.variables.getLocalVariablesAsync()) record(variable);

  // Library variables bound by nodes in this file.
  for (const id of variableIds) {
    if (variables[id]) continue;
    try {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      record(variable);
      if (!collections[variable.variableCollectionId]) {
        const collection = await figma.variables.getVariableCollectionByIdAsync(
          variable.variableCollectionId,
        );
        if (collection) {
          collections[collection.id] = {
            id: collection.id,
            name: collection.name,
            modes: collection.modes.map((mode) => ({ id: mode.modeId, name: mode.name })),
            remote: Boolean(collection.remote),
          };
        }
      }
    } catch (error) {
      // Reported by the app as UNRESOLVED_VARIABLE.
    }
  }

  return { collections, variables };
}

/* ------------------------------------------------------------------ main */

async function buildSourceDocument(options) {
  const context = {
    components: {},
    componentSets: {},
    styleIds: new Set(),
    variableIds: new Set(),
    options,
    depth: 0,
    counters: { visited: 0 },
    truncated: false,
  };

  let roots = [];

  if (options.scope === "selection") {
    roots = figma.currentPage.selection.slice();
    if (!roots.length) throw new Error("Nothing is selected.");
  } else if (options.scope === "page") {
    await figma.currentPage.loadAsync();
    roots = [figma.currentPage];
  } else {
    await figma.loadAllPagesAsync();
    roots = figma.root.children.slice();
  }

  const children = [];
  for (const root of roots) {
    const walked = await walk(root, context);
    if (!walked) break;
    children.push(walked);
  }

  figma.ui.postMessage({ type: "progress", visited: context.counters.visited });

  const styles = await collectStyles(context.styleIds);
  const { collections, variables } = await collectVariables(context.variableIds);

  const libraries = {};
  const remoteEntities = []
    .concat(Object.values(context.components))
    .concat(Object.values(context.componentSets))
    .concat(Object.values(styles))
    .concat(Object.values(variables))
    .concat(Object.values(collections));

  for (const entity of remoteEntities) {
    if (!entity.remote) continue;
    // The plugin API does not name the source library either, so remote
    // entities group under one node exactly as they do over REST.
    entity.libraryId = "external-unknown";
    libraries["external-unknown"] = {
      id: "external-unknown",
      name: "External libraries (source unknown)",
    };
  }

  return {
    fileKey: figma.fileKey || "local-file",
    fileName: figma.root.name,
    root: {
      id: figma.root.id,
      name: figma.root.name,
      type: "DOCUMENT",
      children: children,
    },
    components: context.components,
    componentSets: context.componentSets,
    styles: styles,
    variables: variables,
    variableCollections: collections,
    libraries: libraries,
    source: {
      kind: "figma-plugin",
      ingestedAt: new Date().toISOString(),
      truncated: context.truncated === true,
    },
  };
}

figma.ui.onmessage = async (message) => {
  if (message.type === "export") {
    try {
      const document = await buildSourceDocument({
        scope: message.scope || "page",
        maxDepth: message.maxDepth || 60,
        maxNodes: message.maxNodes || 200000,
      });

      const json = JSON.stringify(document);
      figma.ui.postMessage({
        type: "result",
        json: json,
        fileName: figma.root.name,
        stats: {
          bytes: json.length,
          components: Object.keys(document.components).length,
          componentSets: Object.keys(document.componentSets).length,
          styles: Object.keys(document.styles).length,
          variables: Object.keys(document.variables).length,
        },
      });
    } catch (error) {
      figma.ui.postMessage({ type: "error", message: String(error && error.message ? error.message : error) });
    }
  }

  if (message.type === "close") figma.closePlugin();
};
