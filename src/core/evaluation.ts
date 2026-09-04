import type { JsonObject } from "./types.js";

export interface EvaluationExpectation {
  readonly actual: JsonObject[keyof JsonObject];
  readonly expected: JsonObject[keyof JsonObject];
  readonly label: string;
}

export interface EvaluationCase {
  readonly id: string;
  readonly name: string;
  run(): Promise<readonly EvaluationExpectation[]>;
}

export interface EvaluationCaseResult {
  readonly assertions: readonly (EvaluationExpectation & { readonly passed: boolean })[];
  readonly id: string;
  readonly name: string;
  readonly passed: boolean;
}

export interface EvaluationReport {
  readonly cases: readonly EvaluationCaseResult[];
  readonly failed: number;
  readonly passed: number;
  readonly total: number;
}

export async function evaluate(cases: readonly EvaluationCase[]): Promise<EvaluationReport> {
  const results: EvaluationCaseResult[] = [];
  for (const scenario of cases) {
    const expectations = await scenario.run();
    const assertions = expectations.map((expectation) => ({
      ...expectation,
      passed: JSON.stringify(expectation.actual) === JSON.stringify(expectation.expected),
    }));
    results.push({
      assertions,
      id: scenario.id,
      name: scenario.name,
      passed: assertions.every((assertion) => assertion.passed),
    });
  }
  const passed = results.filter((result) => result.passed).length;
  return { cases: results, failed: results.length - passed, passed, total: results.length };
}
