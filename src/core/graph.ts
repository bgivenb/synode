import type { Classification, JsonObject } from "./types.js";

export interface KnowledgeNode {
  readonly attributes: JsonObject;
  readonly classification: Classification;
  readonly id: string;
  readonly kind: string;
  readonly tenantId: string;
}

export interface KnowledgeEdge {
  readonly from: string;
  readonly id: string;
  readonly relation: string;
  readonly tenantId: string;
  readonly to: string;
}

export interface RetrievalRequest {
  readonly allowedClassifications: ReadonlySet<Classification>;
  readonly anchorIds: readonly string[];
  readonly maxDepth: number;
  readonly query?: string;
  readonly tenantId: string;
}

export interface RetrievalHit {
  readonly depth: number;
  readonly node: KnowledgeNode;
  readonly path: readonly string[];
  readonly score: number;
}

function searchableText(node: KnowledgeNode): string {
  return `${node.kind} ${node.id} ${JSON.stringify(node.attributes)}`.toLowerCase();
}

export class KnowledgeGraph {
  readonly #edges = new Map<string, KnowledgeEdge>();
  readonly #nodes = new Map<string, KnowledgeNode>();

  addNode(node: KnowledgeNode): void {
    this.#nodes.set(`${node.tenantId}:${node.id}`, structuredClone(node));
  }

  addEdge(edge: KnowledgeEdge): void {
    const from = this.#nodes.get(`${edge.tenantId}:${edge.from}`);
    const to = this.#nodes.get(`${edge.tenantId}:${edge.to}`);
    if (!from || !to) {
      throw new Error(`Both edge endpoints must exist in tenant ${edge.tenantId}`);
    }
    this.#edges.set(`${edge.tenantId}:${edge.id}`, structuredClone(edge));
  }

  retrieve(request: RetrievalRequest): readonly RetrievalHit[] {
    const terms = request.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const queue = request.anchorIds.map((id) => ({ id, depth: 0, path: [id] }));
    const visited = new Set<string>();
    const hits: RetrievalHit[] = [];

    while (queue.length > 0) {
      const cursor = queue.shift();
      if (!cursor || visited.has(cursor.id) || cursor.depth > request.maxDepth) continue;
      visited.add(cursor.id);

      const node = this.#nodes.get(`${request.tenantId}:${cursor.id}`);
      if (!node || !request.allowedClassifications.has(node.classification)) continue;

      const text = searchableText(node);
      const termMatches = terms.filter((term) => text.includes(term)).length;
      hits.push({
        depth: cursor.depth,
        node: structuredClone(node),
        path: cursor.path,
        score: Math.max(0, 100 - cursor.depth * 15 + termMatches * 10),
      });

      for (const edge of this.#edges.values()) {
        if (edge.tenantId !== request.tenantId) continue;
        const neighbor =
          edge.from === cursor.id ? edge.to : edge.to === cursor.id ? edge.from : null;
        if (neighbor && !visited.has(neighbor)) {
          queue.push({ id: neighbor, depth: cursor.depth + 1, path: [...cursor.path, neighbor] });
        }
      }
    }

    return hits.sort(
      (left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id),
    );
  }

  export(
    tenantId: string,
    allowedClassifications: ReadonlySet<Classification>,
  ): {
    readonly edges: readonly KnowledgeEdge[];
    readonly nodes: readonly KnowledgeNode[];
  } {
    const nodes = [...this.#nodes.values()].filter(
      (node) => node.tenantId === tenantId && allowedClassifications.has(node.classification),
    );
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = [...this.#edges.values()].filter(
      (edge) => edge.tenantId === tenantId && nodeIds.has(edge.from) && nodeIds.has(edge.to),
    );
    return { edges: structuredClone(edges), nodes: structuredClone(nodes) };
  }
}
