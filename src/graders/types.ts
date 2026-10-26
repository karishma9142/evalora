// Mirrors the grader shapes accepted by the suites route.
export type GraderConfig =
  | { type: 'exact_match'; caseSensitive?: boolean }
  | { type: 'contains'; value?: string; caseSensitive?: boolean }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'json_valid' }
  | { type: 'llm_judge'; rubric: string; passScore?: number };

export interface GraderResult {
  type: string;
  passed: boolean;
  score: number; // 0 to 1
  reason: string;
  skipped?: boolean; // true when this grader could not run (e.g. LLM judge, built later)
}

export interface GradeContext {
  output: string;
  expected: string | null;
}
