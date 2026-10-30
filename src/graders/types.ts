// Mirrors the grader shapes accepted by the suites route.
export type GraderConfig =
  | { type: 'exact_match'; caseSensitive?: boolean }
  | { type: 'contains'; value?: string; caseSensitive?: boolean }
  | { type: 'keywords'; keywords: string[]; minMatch?: number; caseSensitive?: boolean }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'json_valid' }
  | { type: 'llm_judge'; rubric?: string; scale?: 'yesno' | 'score'; passScore?: number };

export interface GraderResult {
  type: string;
  passed: boolean;
  score: number; // 0 to 1
  reason: string;
  skipped?: boolean; // true when this grader could not run (for example an llm_judge with no judge chosen)
  detail?: string; // for llm_judge: what the judge actually replied, so you can see how it decided
}

export interface GradeContext {
  output: string;
  expected: string | null;
  input?: string; // the question, used by the LLM judge
}
