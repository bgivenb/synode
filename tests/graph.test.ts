import { describe, expect, it } from "vitest";
import { KnowledgeGraph } from "../src/core/graph.js";

function graph(): KnowledgeGraph {
  const graph = new KnowledgeGraph();
  graph.addNode({
    attributes: { title: "Case alpha" },
    classification: "internal",
    id: "case",
    kind: "case",
    tenantId: "a",
  });
  graph.addNode({
    attributes: { title: "Verified evidence" },
    classification: "restricted",
    id: "evidence",
    kind: "document",
    tenantId: "a",
  });
  graph.addNode({
    attributes: { title: "Other tenant secret" },
    classification: "restricted",
    id: "secret",
    kind: "document",
    tenantId: "b",
  });
  graph.addEdge({
    from: "case",
    id: "edge",
    relation: "supported_by",
    tenantId: "a",
    to: "evidence",
  });
  return graph;
}

describe("knowledge graph", () => {
  it("returns provenance paths without crossing tenant boundaries", () => {
    const hits = graph().retrieve({
      allowedClassifications: new Set(["internal", "restricted"]),
      anchorIds: ["case", "secret"],
      maxDepth: 2,
      query: "verified evidence",
      tenantId: "a",
    });
    expect(hits.map((hit) => hit.node.id)).toEqual(["evidence", "case"]);
    expect(hits[0]?.path).toEqual(["case", "evidence"]);
    expect(hits.some((hit) => hit.node.id === "secret")).toBe(false);
  });

  it("filters classifications before traversal and export", () => {
    const instance = graph();
    const hits = instance.retrieve({
      allowedClassifications: new Set(["internal"]),
      anchorIds: ["case"],
      maxDepth: 3,
      tenantId: "a",
    });
    expect(hits.map((hit) => hit.node.id)).toEqual(["case"]);
    expect(instance.export("a", new Set(["internal"]))).toEqual({
      edges: [],
      nodes: [hits[0]?.node],
    });
  });

  it("requires edge endpoints to exist in the same tenant", () => {
    const instance = new KnowledgeGraph();
    instance.addNode({
      attributes: {},
      classification: "public",
      id: "one",
      kind: "case",
      tenantId: "a",
    });
    expect(() =>
      instance.addEdge({ from: "one", id: "bad", relation: "links", tenantId: "a", to: "missing" }),
    ).toThrow("Both edge endpoints");
  });
});
