import type { GradeContext, GraderConfig, GraderResult } from './types.js';

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}...` : s);
const normalize = (s: string, caseSensitive?: boolean) => (caseSensitive ? s.trim() : s.trim().toLowerCase());

// Models often wrap JSON in ```json fences. Strip them before parsing.
function stripFences(s: string): string {
  const match = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : s.trim();
}

export function runGrader(grader: GraderConfig, ctx: GradeContext): GraderResult {
  const result = (passed: boolean, reason: string): GraderResult => ({
    type: grader.type,
    passed,
    score: passed ? 1 : 0,
    reason,
  });

  switch (grader.type) {
    case 'exact_match': {
      if (!ctx.expected) return result(false, 'No expected value to compare against');
      const ok = normalize(ctx.output, grader.caseSensitive) === normalize(ctx.expected, grader.caseSensitive);
      return result(ok, ok ? 'Output matches the expected value' : `Expected "${short(ctx.expected)}"`);
    }

    case 'contains': {
      const needle = grader.value ?? ctx.expected;
      if (!needle) return result(false, 'Nothing to look for (no value or expected)');
      const ok = normalize(ctx.output, grader.caseSensitive).includes(normalize(needle, grader.caseSensitive));
      return result(ok, ok ? `Output contains "${short(needle)}"` : `Output does not contain "${short(needle)}"`);
    }

    case 'regex': {
      try {
        const ok = new RegExp(grader.pattern, grader.flags).test(ctx.output);
        return result(ok, ok ? 'Output matches the pattern' : `Output does not match /${short(grader.pattern)}/`);
      } catch {
        return result(false, 'Invalid regular expression');
      }
    }

    case 'json_valid': {
      try {
        JSON.parse(stripFences(ctx.output));
        return result(true, 'Output is valid JSON');
      } catch {
        return result(false, 'Output is not valid JSON');
      }
    }

    case 'llm_judge':
      return { type: 'llm_judge', passed: false, score: 0, skipped: true, reason: 'LLM judge is not available yet' };
  }
}

// Runs every grader on one output and combines them:
// passed = all graders passed, score = average. Skipped graders are ignored.
// No (non-skipped) graders at all means the output is "ungraded" (passed = null).
export function gradeOutput(graders: GraderConfig[], ctx: GradeContext) {
  const results = graders.map((g) => runGrader(g, ctx));
  const active = results.filter((r) => !r.skipped);
  if (active.length === 0) return { passed: null as boolean | null, score: null as number | null, results };
  return {
    passed: active.every((r) => r.passed) as boolean | null,
    score: (active.reduce((sum, r) => sum + r.score, 0) / active.length) as number | null,
    results,
  };
}
