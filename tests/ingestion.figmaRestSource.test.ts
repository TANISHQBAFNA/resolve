import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exponentialBackoffMs,
  fetchFigmaRestDocument,
  memoryCheckpointStore,
  parseRetryAfterMs,
} from "@/core/ingestion/adapters/figmaRestSource";

const FILE_KEY = "DEMOFILEKEY0000000001";

const restFile = {
  name: "Live File",
  version: "1",
  lastModified: "2026-01-01T00:00:00Z",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "Page 1",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "Screen",
            type: "FRAME",
            children: [
              { id: "1:2", name: "Button", type: "INSTANCE", componentId: "2:1" },
            ],
          },
        ],
      },
    ],
  },
  components: { "2:1": { name: "Button", key: "btn-key" } },
  componentSets: {},
  styles: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFigmaRestDocument", () => {
  it("builds a SourceDocument from the file endpoint and ignores a 403 on variables", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith(`/v1/files/${FILE_KEY}`)) {
        return new Response(JSON.stringify(restFile), { status: 200 });
      }
      if (url.endsWith(`/v1/files/${FILE_KEY}/variables/local`)) {
        return new Response(JSON.stringify({ err: "Forbidden" }), { status: 403 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const doc = await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      scope: "file",
    });

    expect(doc.fileKey).toBe(FILE_KEY);
    expect(doc.fileName).toBe("Live File");
    expect(doc.source.kind).toBe("figma-rest");
    expect(doc.root.children?.[0]?.children?.[0]?.children?.[0]?.componentId).toBe("2:1");
    expect(doc.components["2:1"]?.name).toBe("Button");
    expect(Object.keys(doc.variables)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("geometry=");
  });

  it("fails closed on a bad token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ err: "Invalid token" }), { status: 403 })),
    );

    await expect(
      fetchFigmaRestDocument(FILE_KEY, { token: "figd_SECRET", origin: "https://api.figma.com" }),
    ).rejects.toThrow(/authorization failed.*Invalid token/);
  });

  it("does not echo the token in error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ err: "Invalid token" }), { status: 403 })),
    );
    const error = await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_SECRET",
      origin: "https://api.figma.com",
      scope: "file",
    }).then(
      () => {
        throw new Error("expected failure");
      },
      (cause: unknown) => cause as Error,
    );
    expect(error.message).toMatch(/authorization failed/);
    expect(error.message).not.toContain("figd_SECRET");
  });

  it("rejects a missing token without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchFigmaRestDocument(FILE_KEY, { token: "   ", origin: "https://api.figma.com", scope: "file" }),
    ).rejects.toThrow(/authentication failed: missing access token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names 401 as authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ err: "Token expired" }), { status: 401 })),
    );
    await expect(
      fetchFigmaRestDocument(FILE_KEY, { token: "figd_SECRET", origin: "https://api.figma.com" }),
    ).rejects.toThrow(/authentication failed.*Token expired/);
  });

  it("names 429 as rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ err: "Rate limit exceeded" }), { status: 429 })),
    );
    await expect(
      fetchFigmaRestDocument(FILE_KEY, {
        token: "figd_SECRET",
        origin: "https://api.figma.com",
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/rate limited.*Rate limit exceeded/i);
  });

  it("names an abort as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        throw new Error("signal should already be aborted");
      }),
    );
    const signal = AbortSignal.abort();
    await expect(
      fetchFigmaRestDocument(FILE_KEY, { token: "figd_SECRET", origin: "https://api.figma.com", signal }),
    ).rejects.toThrow(/timed out/);
  });

  it("names a fetch throw as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(
      fetchFigmaRestDocument(FILE_KEY, { token: "figd_SECRET", origin: "https://api.figma.com" }),
    ).rejects.toThrow(/network error/);
  });

  it("rejects a 200 body that is not a Figma file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/variables/")) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ name: "nope" }), { status: 200 });
      }),
    );
    await expect(
      fetchFigmaRestDocument(FILE_KEY, {
        token: "figd_SECRET",
        origin: "https://api.figma.com",
        scope: "file",
      }),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("fetches /nodes?ids= for a shared screen URL and skips the whole file", async () => {
    const nodesBody = {
      name: "Live File",
      version: "1",
      lastModified: "2026-01-01T00:00:00Z",
      nodes: {
        "1:1": {
          document: restFile.document.children[0].children[0],
          components: restFile.components,
          componentSets: {},
          styles: {},
        },
      },
    };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/variables/")) return new Response("{}", { status: 404 });
      if (url.includes(`/v1/files/${FILE_KEY}/nodes?ids=`)) {
        expect(url).toContain(encodeURIComponent("1:1"));
        return new Response(JSON.stringify(nodesBody), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const doc = await fetchFigmaRestDocument(
      `https://www.figma.com/design/${FILE_KEY}/Name?node-id=1-1`,
      { token: "figd_test", origin: "https://api.figma.com" },
    );

    expect(doc.fileName).toBe("Live File");
    expect(doc.root.children?.[0]?.name).toBe("Shared");
    expect(doc.root.children?.[0]?.children?.[0]?.id).toBe("1:1");
    expect(doc.components["2:1"]?.name).toBe("Button");
    expect(fetchMock.mock.calls.map((call) => String(call[0])).join("\n")).not.toMatch(
      new RegExp(`/v1/files/${FILE_KEY}(?:\\?|$)`),
    );
  });

  it("walks each top-level screen when the URL has no node-id", async () => {
    const outline = {
      name: "Live File",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [
          {
            id: "1:0",
            name: "Page 1",
            type: "CANVAS",
            children: [
              { id: "1:1", name: "Screen A", type: "FRAME" },
              { id: "1:9", name: "Screen B", type: "FRAME" },
            ],
          },
        ],
      },
    };
    const nodePayload = (id: string, name: string) => ({
      name: "Live File",
      nodes: {
        [id]: {
          document: { id, name, type: "FRAME", children: [] },
          components: {},
          componentSets: {},
          styles: {},
        },
      },
    });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/variables/")) return new Response("{}", { status: 404 });
      if (url.endsWith(`/v1/files/${FILE_KEY}?depth=2`)) {
        return new Response(JSON.stringify(outline), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:1")}`)) {
        return new Response(JSON.stringify(nodePayload("1:1", "Screen A")), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:9")}`)) {
        return new Response(JSON.stringify(nodePayload("1:9", "Screen B")), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const names: string[] = [];
    const doc = await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      onProgress: (info) => {
        if (info.phase === "screen") names.push(`${info.done}:${info.name}`);
      },
    });

    expect(doc.root.children?.[0]?.children?.map((child) => child.name)).toEqual([
      "Screen A",
      "Screen B",
    ]);
    expect(names).toContain("0:Screen A");
    expect(names).toContain("1:Screen B");
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/nodes?")).length).toBe(2);
  });

  it("parses Retry-After seconds and HTTP-date", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    const future = new Date(Date.now() + 5000).toUTCString();
    const wait = parseRetryAfterMs(future);
    expect(wait).toBeGreaterThan(1000);
    expect(wait).toBeLessThan(8000);
  });

  it("waits Retry-After on 429 then continues the section walk", async () => {
    const outline = {
      name: "Live File",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [
          {
            id: "1:0",
            name: "Page 1",
            type: "CANVAS",
            children: [
              { id: "1:1", name: "Screen A", type: "FRAME" },
              { id: "1:9", name: "Screen B", type: "FRAME" },
            ],
          },
        ],
      },
    };
    const nodePayload = (id: string, name: string) => ({
      name: "Live File",
      nodes: {
        [id]: {
          document: { id, name, type: "FRAME", children: [] },
          components: {},
          componentSets: {},
          styles: {},
        },
      },
    });
    let bHits = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/variables/")) return new Response("{}", { status: 404 });
      if (url.endsWith(`/v1/files/${FILE_KEY}?depth=2`)) {
        return new Response(JSON.stringify(outline), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:1")}`)) {
        return new Response(JSON.stringify(nodePayload("1:1", "Screen A")), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:9")}`)) {
        bHits += 1;
        if (bHits === 1) {
          return new Response(JSON.stringify({ err: "Rate limit exceeded" }), {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        }
        return new Response(JSON.stringify(nodePayload("1:9", "Screen B")), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const slept: number[] = [];

    const doc = await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([2000]);
    expect(doc.root.children?.[0]?.children?.map((child) => child.name)).toEqual([
      "Screen A",
      "Screen B",
    ]);
  });

  it("keeps completed sections on a long Retry-After and resumes on re-run", async () => {
    const outline = {
      name: "Live File",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [
          {
            id: "1:0",
            name: "Page 1",
            type: "CANVAS",
            children: [
              { id: "1:1", name: "Screen A", type: "FRAME" },
              { id: "1:9", name: "Screen B", type: "FRAME" },
            ],
          },
        ],
      },
    };
    const nodePayload = (id: string, name: string) => ({
      name: "Live File",
      nodes: {
        [id]: {
          document: { id, name, type: "FRAME", children: [] },
          components: {},
          componentSets: {},
          styles: {},
        },
      },
    });
    let bHits = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/variables/")) return new Response("{}", { status: 404 });
      if (url.endsWith(`/v1/files/${FILE_KEY}?depth=2`)) {
        return new Response(JSON.stringify(outline), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:1")}`)) {
        return new Response(JSON.stringify(nodePayload("1:1", "Screen A")), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:9")}`)) {
        bHits += 1;
        if (bHits === 1) {
          return new Response(JSON.stringify({ err: "Rate limit exceeded" }), {
            status: 429,
            headers: { "Retry-After": "120" },
          });
        }
        return new Response(JSON.stringify(nodePayload("1:9", "Screen B")), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const checkpoint = memoryCheckpointStore();

    await expect(
      fetchFigmaRestDocument(FILE_KEY, {
        token: "figd_test",
        origin: "https://api.figma.com",
        checkpoint,
        maxRetryAfterMs: 30_000,
      }),
    ).rejects.toThrow(/120s/);

    expect(checkpoint.load(FILE_KEY)?.completedIds).toEqual(["1:1"]);
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("ids=1")).length).toBeGreaterThan(0);

    const doc = await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      checkpoint,
      maxRetryAfterMs: 30_000,
    });

    expect(doc.root.children?.[0]?.children?.map((child) => child.name)).toEqual([
      "Screen A",
      "Screen B",
    ]);
    const nodeCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/nodes?"));
    expect(nodeCalls.filter((call) => String(call[0]).includes(encodeURIComponent("1:1"))).length).toBe(1);
    expect(nodeCalls.filter((call) => String(call[0]).includes(encodeURIComponent("1:9"))).length).toBe(2);
    expect(checkpoint.load(FILE_KEY)).toBeUndefined();
  });

  it("labels unnamed sections in progress instead of a blank name", async () => {
    const outline = {
      name: "Live File",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [
          {
            id: "1:0",
            name: "Search",
            type: "CANVAS",
            children: [{ id: "1:1", name: "", type: "SECTION" }],
          },
        ],
      },
    };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/variables/")) return new Response("{}", { status: 404 });
      if (url.endsWith(`/v1/files/${FILE_KEY}?depth=2`)) {
        return new Response(JSON.stringify(outline), { status: 200 });
      }
      if (url.includes("/nodes?")) {
        return new Response(
          JSON.stringify({
            name: "Live File",
            nodes: {
              "1:1": { document: { id: "1:1", name: "", type: "SECTION", children: [] } },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const names: string[] = [];
    await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      onProgress: (info) => {
        if (info.phase === "screen") names.push(info.name);
      },
    });
    expect(names.some((name) => name.trim().length > 0)).toBe(true);
    expect(names.join(" ")).toMatch(/Search/);
  });

  it("uses exponential backoff when 429 has no Retry-After", async () => {
    expect(exponentialBackoffMs(0)).toBe(1000);
    expect(exponentialBackoffMs(1)).toBe(2000);
    expect(exponentialBackoffMs(2)).toBe(4000);

    let hits = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/variables/")) return new Response("{}", { status: 404 });
        if (url.endsWith(`/v1/files/${FILE_KEY}`)) {
          hits += 1;
          if (hits < 3) {
            return new Response(JSON.stringify({ err: "Rate limit exceeded" }), { status: 429 });
          }
          return new Response(JSON.stringify(restFile), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const slept: number[] = [];
    const doc = await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      scope: "file",
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([1000, 2000]);
    expect(doc.fileName).toBe("Live File");
  });

  it("retries the variables request through the same 429 policy", async () => {
    let varHits = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/variables/")) {
          varHits += 1;
          if (varHits === 1) {
            return new Response(JSON.stringify({ err: "Rate limit exceeded" }), { status: 429 });
          }
          return new Response(JSON.stringify({ meta: { variables: {} } }), { status: 200 });
        }
        if (url.endsWith(`/v1/files/${FILE_KEY}`)) {
          return new Response(JSON.stringify(restFile), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const slept: number[] = [];
    await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      scope: "file",
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(varHits).toBe(2);
    expect(slept).toEqual([1000]);
  });

  it("discards an ingest checkpoint when the file version changed", async () => {
    const outline = (version: string) => ({
      name: "Live File",
      version,
      lastModified: `t-${version}`,
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [
          {
            id: "1:0",
            name: "Page 1",
            type: "CANVAS",
            children: [
              { id: "1:1", name: "Screen A", type: "FRAME" },
              { id: "1:9", name: "Screen B", type: "FRAME" },
            ],
          },
        ],
      },
    });
    const nodePayload = (id: string, name: string) => ({
      name: "Live File",
      nodes: {
        [id]: {
          document: { id, name, type: "FRAME", children: [] },
          components: {},
          componentSets: {},
          styles: {},
        },
      },
    });
    const checkpoint = memoryCheckpointStore();
    checkpoint.save(FILE_KEY, {
      fileKey: FILE_KEY,
      version: "1",
      lastModified: "t-1",
      completedIds: ["1:1", "1:9"],
      pages: {},
      components: {},
      componentSets: {},
      styles: {},
    });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/variables/")) return new Response("{}", { status: 404 });
      if (url.endsWith(`/v1/files/${FILE_KEY}?depth=2`)) {
        return new Response(JSON.stringify(outline("2")), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:1")}`)) {
        return new Response(JSON.stringify(nodePayload("1:1", "Screen A")), { status: 200 });
      }
      if (url.includes(`/nodes?ids=${encodeURIComponent("1:9")}`)) {
        return new Response(JSON.stringify(nodePayload("1:9", "Screen B")), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchFigmaRestDocument(FILE_KEY, {
      token: "figd_test",
      origin: "https://api.figma.com",
      checkpoint,
    });

    const nodeCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/nodes?"));
    expect(nodeCalls.filter((call) => String(call[0]).includes(encodeURIComponent("1:1"))).length).toBe(1);
    expect(nodeCalls.filter((call) => String(call[0]).includes(encodeURIComponent("1:9"))).length).toBe(1);
  });
});

