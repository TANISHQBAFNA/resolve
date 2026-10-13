import { describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion";
import type { IngestionSource, SourceDocument } from "@/core/ingestion/types";
import { useGraphStore } from "@/state/graphStore";

function doc(name: string): SourceDocument {
  return adaptFigmaRestFile({
    fileKey: "FILEKEY0000000001",
    file: { name, document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [] } },
    kind: "json",
    ingestedAt: "2026-01-01T00:00:00.000Z",
  });
}

function source(id: string, load: () => Promise<SourceDocument>): IngestionSource {
  return { id, label: id, kind: "json", load };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("graph store loads", () => {
  it("drops an older load that finishes after a newer source", async () => {
    const older = deferred<SourceDocument>();
    const newer = deferred<SourceDocument>();
    const first = useGraphStore.getState().loadSource(source("older", () => older.promise));
    const second = useGraphStore.getState().loadSource(source("newer", () => newer.promise));
    newer.resolve(doc("Newer"));
    await second;
    older.resolve(doc("Older"));
    await first;
    expect(useGraphStore.getState().status).toBe("ready");
    expect(useGraphStore.getState().graph?.fileName).toBe("Newer");
    expect(useGraphStore.getState().sourceLabel).toBe("newer");
  });

  it("does not let an older failure overwrite a newer graph", async () => {
    const failed = deferred<SourceDocument>();
    const ok = deferred<SourceDocument>();
    const first = useGraphStore.getState().loadSource(source("bad", () => failed.promise));
    const second = useGraphStore.getState().loadSource(source("ok", () => ok.promise));
    ok.resolve(doc("Ok"));
    await second;
    failed.reject(new Error("stale"));
    await first;
    expect(useGraphStore.getState().status).toBe("ready");
    expect(useGraphStore.getState().error).toBeUndefined();
    expect(useGraphStore.getState().graph?.fileName).toBe("Ok");
  });
});
