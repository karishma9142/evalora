
import { runJudge, type JudgeConfig } from './judge.js';
import type { GradeContext, GraderConfig, GraderResult } from './types.js';

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}...` : s);

const normalize = (s: string, caseSensitive?: boolean) =>
  caseSensitive ? s.trim() : s.trim().toLowerCase();

// Used only by the contains grader to handle whitespace differences.
const normalizeContains = (s: string, caseSensitive?: boolean) => {
  const text = s.replace(/\s+/g, '');
  return caseSensitive ? text : text.toLowerCase();
};

const LONG_TEXT_HINT =
  ' (Tip: for sentence-length expected answers, use the "keywords" or "llm_judge" grader.)';

// Models often wrap JSON in ```json fences. Strip them before parsing.
function stripFences(s: string): string {
  const match = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : s.trim();
}

const SKIPPED_JUDGE: GraderResult = {
  type: 'llm_judge',
  passed: false,
  score: 0,
  skipped: true,
  reason: 'No judge was chosen for this run, so this check was skipped',
};

// Synchronous graders. llm_judge needs a network call, so it is handled by gradeOutputAsync.
export function runGrader(
  grader: GraderConfig,
  ctx: GradeContext,
): GraderResult {
  const result = (passed: boolean, reason: string): GraderResult => ({
    type: grader.type,
    passed,
    score: passed ? 1 : 0,
    reason,
  });

  switch (grader.type) {
    case 'exact_match': {
      if (!ctx.expected) {
        return result(false, 'No expected value to compare against');
      }

      const ok =
        normalize(ctx.output, grader.caseSensitive) ===
        normalize(ctx.expected, grader.caseSensitive);

      return result(
        ok,
        ok
          ? 'Output matches the expected value'
          : `Expected "${short(ctx.expected)}"${
              ctx.expected.length > 40 ? LONG_TEXT_HINT : ''
            }`,
      );
    }

    case 'contains': {
      const needle = grader.value ?? ctx.expected;

      if (!needle) {
        return result(false, 'Nothing to look for (no value or expected)');
      }

      const ok =
        normalizeContains(ctx.output, grader.caseSensitive).includes(
          normalizeContains(needle, grader.caseSensitive),
        );

      return result(
        ok,
        ok
          ? `Output contains "${short(needle)}"`
          : `Output does not contain "${short(needle)}"${
              needle.length > 40 ? LONG_TEXT_HINT : ''
            }`,
      );
    }

    case 'keywords': {
      // Passes when the key phrases appear. Wording around them does not matter.
      const out = normalize(ctx.output, grader.caseSensitive);

      const found = grader.keywords.filter((k) =>
        out.includes(normalize(k, grader.caseSensitive)),
      );

      const missing = grader.keywords.filter((k) => !found.includes(k));
      const ratio = grader.keywords.length
        ? found.length / grader.keywords.length
        : 0;

      const ok = ratio >= (grader.minMatch ?? 1) - 1e-9;

      return {
        type: 'keywords',
        passed: ok,
        score: ratio,
        reason: missing.length
          ? `Found ${found.length} of ${grader.keywords.length} key phrases. Missing: ${missing
              .map((m) => `"${short(m)}"`)
              .join(', ')}`
          : `Found all ${grader.keywords.length} key phrases`,
      };
    }

    case 'regex': {
      try {
        const ok = new RegExp(grader.pattern, grader.flags).test(ctx.output);

        return result(
          ok,
          ok
            ? 'Output matches the pattern'
            : `Output does not match /${short(grader.pattern)}/`,
        );
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
      return SKIPPED_JUDGE;
  }
}

// Combines several grader results: passed = all passed, score = average.
// Skipped graders are ignored. No (non-skipped) graders at all means "ungraded" (passed = null).
function combine(results: GraderResult[]) {
  const active = results.filter((r) => !r.skipped);

  if (active.length === 0) {
    return {
      passed: null as boolean | null,
      score: null as number | null,
      results,
    };
  }

  return {
    passed: active.every((r) => r.passed) as boolean | null,
    score: active.reduce((sum, r) => sum + r.score, 0) / active.length,
    results,
  };
}

export function gradeOutput(graders: GraderConfig[], ctx: GradeContext) {
  return combine(graders.map((g) => runGrader(g, ctx)));
}

// Same as gradeOutput, but also runs llm_judge graders using the given judge.
export async function gradeOutputAsync(
  graders: GraderConfig[],
  ctx: GradeContext,
  judge: JudgeConfig | null,
) {
  const results: GraderResult[] = [];

  for (const g of graders) {
    if (g.type === 'llm_judge') {
      results.push(judge ? await runJudge(judge, g, ctx) : SKIPPED_JUDGE);
    } else {
      results.push(runGrader(g, ctx));
    }
  }

  return combine(results);
}
