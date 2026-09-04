import { describe, expect, it } from "vitest";
import {
  HybridRetriever,
  type RetrievalBackend,
  type RetrievalCandidate,
  type RetrievalChannel,
} from "../src/retrieval/hybrid.js";

const candidate = (
  id: string,
  tenantId = "northstar",
  classification: RetrievalCandidate["classification"] = "internal",
): RetrievalCandidate => ({
  classification,
  content: `Evidence ${id}`,
  graphPath: ["case", id],
  id,
  sourceUri: `urn:evidence:${id}`,
  tenantId,
});

function backend(
  results: Record<RetrievalChannel, readonly RetrievalCandidate[]>,
): RetrievalBackend {
  return {
    async retrieve(channel) {
      return results[channel];
    },
  };
}

const request = {
  allowedClassifications: new Set(["internal"] as const),
  anchorIds: ["case"],
  limit: 5,
  query: "verified ownership",
  tenantId: "northstar",
};

describe("hybrid retrieval", () => {
  it("fuses keyword, vector, and graph ranks with inspectable provenance", async () => {
    const retriever = new HybridRetriever(
      backend({
        graph: [candidate("b"), candidate("a")],
        keyword: [candidate("a"), candidate("c")],
        vector: [candidate("a"), candidate("b")],
      }),
      { rankConstant: 10 },
    );

    const hits = await retriever.retrieve(request);
    expect(hits.map((hit) => hit.id)).toEqual(["a", "b", "c"]);
    expect(hits[0]).toMatchObject({
      channels: ["keyword", "vector", "graph"],
      graphPath: ["case", "a"],
      rankByChannel: { graph: 2, keyword: 1, vector: 1 },
      sourceUri: "urn:evidence:a",
    });
  });

  it("applies tenant and classification scope before rank positions are assigned", async () => {
    const retriever = new HybridRetriever(
      backend({
        graph: [candidate("cross-tenant", "other"), candidate("visible")],
        keyword: [candidate("restricted", "northstar", "restricted"), candidate("visible")],
        vector: [candidate("visible"), candidate("visible")],
      }),
      { rankConstant: 10 },
    );

    const hits = await retriever.retrieve(request);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rankByChannel).toEqual({ graph: 1, keyword: 1, vector: 1 });
  });

  it("is deterministic for ties and honors a zero result limit", async () => {
    const retriever = new HybridRetriever(
      backend({ graph: [], keyword: [candidate("z"), candidate("a")], vector: [] }),
    );
    const tied = new HybridRetriever(
      backend({ graph: [candidate("z")], keyword: [candidate("a")], vector: [] }),
      { weights: { graph: 1, keyword: 1, vector: 1 } },
    );

    expect(await retriever.retrieve({ ...request, limit: 0 })).toEqual([]);
    expect((await tied.retrieve(request)).map((hit) => hit.id)).toEqual(["a", "z"]);
  });

  it("rejects invalid fusion configuration", () => {
    expect(
      () =>
        new HybridRetriever(backend({ graph: [], keyword: [], vector: [] }), { rankConstant: 0 }),
    ).toThrow("rankConstant must be positive");
  });
});
