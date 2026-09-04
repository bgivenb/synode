import type { Classification } from "../core/types.js";

export type RetrievalChannel = "graph" | "keyword" | "vector";

export interface RetrievalCandidate {
  readonly classification: Classification;
  readonly content: string;
  readonly graphPath?: readonly string[];
  readonly id: string;
  readonly sourceUri: string;
  readonly tenantId: string;
}

export interface HybridRetrievalRequest {
  readonly allowedClassifications: ReadonlySet<Classification>;
  readonly anchorIds: readonly string[];
  readonly limit: number;
  readonly query: string;
  readonly tenantId: string;
}

export interface HybridRetrievalHit extends RetrievalCandidate {
  readonly channels: readonly RetrievalChannel[];
  readonly rankByChannel: Readonly<Partial<Record<RetrievalChannel, number>>>;
  readonly score: number;
}

export interface RetrievalBackend {
  retrieve(
    channel: RetrievalChannel,
    request: HybridRetrievalRequest,
  ): Promise<readonly RetrievalCandidate[]>;
}

export interface HybridRetrieverOptions {
  readonly rankConstant?: number;
  readonly weights?: Readonly<Record<RetrievalChannel, number>>;
}

const channels: readonly RetrievalChannel[] = ["keyword", "vector", "graph"];

export class HybridRetriever {
  readonly #backend: RetrievalBackend;
  readonly #rankConstant: number;
  readonly #weights: Readonly<Record<RetrievalChannel, number>>;

  constructor(backend: RetrievalBackend, options: HybridRetrieverOptions = {}) {
    this.#backend = backend;
    this.#rankConstant = options.rankConstant ?? 60;
    this.#weights = options.weights ?? { graph: 1.2, keyword: 1, vector: 1 };
    if (this.#rankConstant <= 0) throw new Error("rankConstant must be positive");
  }

  async retrieve(request: HybridRetrievalRequest): Promise<readonly HybridRetrievalHit[]> {
    if (request.limit <= 0) return [];
    const rankedLists = await Promise.all(
      channels.map(async (channel) => ({
        candidates: await this.#backend.retrieve(channel, request),
        channel,
      })),
    );

    const fused = new Map<
      string,
      {
        candidate: RetrievalCandidate;
        channels: RetrievalChannel[];
        ranks: Partial<Record<RetrievalChannel, number>>;
        score: number;
      }
    >();

    for (const { candidates, channel } of rankedLists) {
      const seen = new Set<string>();
      let visibleRank = 0;
      for (const candidate of candidates) {
        if (
          candidate.tenantId !== request.tenantId ||
          !request.allowedClassifications.has(candidate.classification) ||
          seen.has(candidate.id)
        ) {
          continue;
        }
        seen.add(candidate.id);
        visibleRank += 1;
        const contribution = this.#weights[channel] / (this.#rankConstant + visibleRank);
        const existing = fused.get(candidate.id);
        if (existing) {
          existing.channels.push(channel);
          existing.ranks[channel] = visibleRank;
          existing.score += contribution;
        } else {
          fused.set(candidate.id, {
            candidate,
            channels: [channel],
            ranks: { [channel]: visibleRank },
            score: contribution,
          });
        }
      }
    }

    return [...fused.values()]
      .sort(
        (left, right) =>
          right.score - left.score || left.candidate.id.localeCompare(right.candidate.id),
      )
      .slice(0, request.limit)
      .map(({ candidate, channels: matchedChannels, ranks, score }) => ({
        ...candidate,
        channels: matchedChannels,
        rankByChannel: ranks,
        score,
      }));
  }
}
