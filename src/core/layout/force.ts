/**
 * Deterministic force-directed layout.
 *
 * Fruchterman-Reingold with three additions that matter for a design graph:
 * repulsion is computed through a spatial grid (so a few thousand nodes stay
 * interactive), nodes are pulled toward their community centroid (so clusters
 * read as clusters), and initial placement is seeded per community rather than
 * at random (so it converges fast and lands in the same place every run).
 *
 * No RNG beyond a seeded PRNG, so the same graph always produces the same
 * picture — which matters when two people compare screenshots of the same file.
 */

export interface SimulationNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  community: number;
  radius: number;
  pinned?: boolean;
}

export interface SimulationEdge {
  source: string;
  target: string;
  weight: number;
}

export interface SimulationOptions {
  width?: number;
  height?: number;
  /** Ideal edge length. Derived from area/node count when omitted. */
  idealDistance?: number;
  /** Pull toward the community centroid. 0 disables clustering. */
  communityStrength?: number;
  /** Pull toward the origin, keeps disconnected nodes from drifting away. */
  gravity?: number;
  seed?: number;
  /** Iterations before the layout is considered settled. */
  iterations?: number;
}

/** Seeded random numbers (same seed, same order). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Simulation {
  nodes: SimulationNode[];
  byId: Map<string, SimulationNode>;
  /** Runs one iteration. Returns the remaining temperature (0 = settled). */
  tick(): number;
  /** Runs to completion. */
  run(): SimulationNode[];
  reheat(): void;
  progress(): number;
}

export function createSimulation(
  inputNodes: ReadonlyArray<{ id: string; degree: number; community: number; radius?: number }>,
  inputEdges: readonly SimulationEdge[],
  options: SimulationOptions = {},
): Simulation {
  const width = options.width ?? 1600;
  const height = options.height ?? 1200;
  const iterations = options.iterations ?? 420;
  const communityStrength = options.communityStrength ?? 0.06;
  const gravity = options.gravity ?? 0.035;
  const random = mulberry32(options.seed ?? 1);

  const area = width * height;
  const k = options.idealDistance ?? Math.sqrt(area / Math.max(1, inputNodes.length)) * 0.58;

  // Seed each community on its own ring so clusters start apart instead of
  // untangling from a single hairball.
  const communities = [...new Set(inputNodes.map((node) => node.community))].sort((a, b) => a - b);
  const communityAngle = new Map<number, number>();
  communities.forEach((community, i) => {
    communityAngle.set(community, (2 * Math.PI * i) / Math.max(1, communities.length));
  });

  const clusterRadius = Math.min(width, height) * 0.22;

  const nodes: SimulationNode[] = inputNodes.map((node) => {
    const angle = communityAngle.get(node.community) ?? 0;
    const jitter = k * 3;
    return {
      id: node.id,
      x: Math.cos(angle) * clusterRadius + (random() - 0.5) * jitter,
      y: Math.sin(angle) * clusterRadius + (random() - 0.5) * jitter,
      vx: 0,
      vy: 0,
      degree: node.degree,
      community: node.community,
      radius: node.radius ?? 3,
    };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = inputEdges
    .map((edge) => ({
      a: byId.get(edge.source),
      b: byId.get(edge.target),
      weight: edge.weight || 1,
    }))
    .filter((edge): edge is { a: SimulationNode; b: SimulationNode; weight: number } =>
      Boolean(edge.a && edge.b),
    );

  let temperature = Math.min(width, height) / 8;
  const cooling = Math.pow(0.02, 1 / iterations);
  let step = 0;

  const cellSize = k * 2;
  const grid = new Map<string, SimulationNode[]>();
  const cellKey = (x: number, y: number) => `${Math.floor(x / cellSize)}|${Math.floor(y / cellSize)}`;

  function rebuildGrid(): void {
    grid.clear();
    for (const node of nodes) {
      const key = cellKey(node.x, node.y);
      const bucket = grid.get(key);
      if (bucket) bucket.push(node);
      else grid.set(key, [node]);
    }
  }

  function tick(): number {
    if (step >= iterations) return 0;
    step += 1;

    for (const node of nodes) {
      node.vx = 0;
      node.vy = 0;
    }

    // Repulsion, limited to the 3x3 neighbourhood of cells.
    rebuildGrid();
    for (const node of nodes) {
      const cx = Math.floor(node.x / cellSize);
      const cy = Math.floor(node.y / cellSize);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bucket = grid.get(`${cx + ox}|${cy + oy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === node) continue;
            let dx = node.x - other.x;
            let dy = node.y - other.y;
            let distance = Math.hypot(dx, dy);
            if (distance < 1e-4) {
              // Perfectly coincident nodes need a deterministic nudge.
              dx = (random() - 0.5) * 0.01;
              dy = (random() - 0.5) * 0.01;
              distance = Math.hypot(dx, dy) || 1e-4;
            }
            let force = (k * k) / distance;
            // Hard floor so discs never sit on top of each other.
            const minimum = node.radius + other.radius + 2;
            if (distance < minimum) force += (minimum - distance) * k * 0.6;
            node.vx += (dx / distance) * force;
            node.vy += (dy / distance) * force;
          }
        }
      }
    }

    // Attraction along edges.
    for (const edge of edges) {
      const dx = edge.a.x - edge.b.x;
      const dy = edge.a.y - edge.b.y;
      const distance = Math.hypot(dx, dy) || 1e-4;
      const force = ((distance * distance) / k) * Math.min(3, edge.weight);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      edge.a.vx -= fx;
      edge.a.vy -= fy;
      edge.b.vx += fx;
      edge.b.vy += fy;
    }

    // Community cohesion.
    if (communityStrength > 0) {
      const centroids = new Map<number, { x: number; y: number; n: number }>();
      for (const node of nodes) {
        const entry = centroids.get(node.community);
        if (entry) {
          entry.x += node.x;
          entry.y += node.y;
          entry.n += 1;
        } else {
          centroids.set(node.community, { x: node.x, y: node.y, n: 1 });
        }
      }
      for (const node of nodes) {
        const centroid = centroids.get(node.community);
        if (!centroid || centroid.n < 2) continue;
        node.vx += (centroid.x / centroid.n - node.x) * communityStrength * k;
        node.vy += (centroid.y / centroid.n - node.y) * communityStrength * k;
      }
    }

    // Gravity + integration, displacement capped by temperature.
    for (const node of nodes) {
      if (node.pinned) continue;
      node.vx -= node.x * gravity;
      node.vy -= node.y * gravity;

      const speed = Math.hypot(node.vx, node.vy) || 1e-4;
      const limited = Math.min(speed, temperature);
      node.x += (node.vx / speed) * limited;
      node.y += (node.vy / speed) * limited;
    }

    temperature *= cooling;
    return temperature;
  }

  return {
    nodes,
    byId,
    tick,
    run() {
      while (tick() > 0);
      return nodes;
    },
    reheat() {
      step = 0;
      temperature = Math.min(width, height) / 8;
    },
    progress() {
      return Math.min(1, step / iterations);
    },
  };
}
