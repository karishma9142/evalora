#!/usr/bin/env node
// EvalBoard CLI: run an evaluation from your terminal or CI and fail the build if quality drops.
// Zero dependencies. Needs Node 18 or newer. Talks to your EvalBoard server over HTTP.

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

const HELP = `EvalBoard CLI: run an evaluation from your terminal or CI and fail the build if quality drops.

Usage:
  evalboard run --suite <name|id> --target <name|id> [options]
  evalboard list

Options for "run":
  --suite <name|id>            The test suite to run (required)
  --target <name|id>           The AI target to test (required)
  --system-prompt-file <path>  Test a new system prompt: makes a copy of the target that uses this file
  --name <label>               Name for the copy made by --system-prompt-file
  --repeat <n>                 Run each case n times (default 1)
  --concurrency <n>            Parallel requests (default 3)
  --baseline <run-id|latest>   Compare with an earlier run of the same suite
  --fail-under <rate>          Fail if the pass rate is below this (write 0.85 or 85)
  --max-drop <rate>            Fail if the pass rate drops more than this versus the baseline
  --max-regressions <n>        Fail if more than n cases that passed in the baseline now fail
  --timeout <seconds>          Stop waiting after this long (default 600)
  --json                       Print machine-readable JSON instead of text
  --url <url>                  EvalBoard address (or set EVALBOARD_URL; default http://localhost:3000)

Sign in with environment variables (never put a password on the command line):
  EVALBOARD_TOKEN              a login token, or
  EVALBOARD_EMAIL and EVALBOARD_PASSWORD

Exit codes:
  0  all checks passed
  1  a quality check failed (pass rate too low, regressions found)
  2  something went wrong (bad options, server unreachable, the run failed)
`;

// ---------- small helpers ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (text, max = 100) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
const pct = (x) => (x === null || x === undefined ? '–' : (Math.round(x * 1000) / 10).toFixed(1) + '%');
const points = (x) => (x > 0 ? '+' : '') + (Math.round(x * 1000) / 10).toFixed(1) + ' pts';
const ms = (x) => (x === null || x === undefined ? '–' : x >= 1000 ? (x / 1000).toFixed(2) + ' s' : Math.round(x) + ' ms');
const usd = (x) => (x === null || x === undefined ? '–' : '$' + (x < 0.01 ? x.toFixed(6) : x.toFixed(4)));
const orUndefined = (v) => (v === null ? undefined : v);

function toNumber(raw, name, { min, max, integer } = {}) {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n)) throw new CliError(`--${name} must be a number (you passed "${raw}")`);
  if (integer && !Number.isInteger(n)) throw new CliError(`--${name} must be a whole number`);
  if (min !== undefined && n < min) throw new CliError(`--${name} must be at least ${min}`);
  if (max !== undefined && n > max) throw new CliError(`--${name} must be at most ${max}`);
  return n;
}

// Accepts 0.85 or 85 (anything above 1 is read as a percentage)
function toRate(raw, name) {
  const n = toNumber(raw, name, { min: 0, max: 100 });
  return n > 1 ? n / 100 : n;
}

// ---------- API client ----------
function createClient(baseUrl, fetchImpl) {
  let token = null;

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers: {
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason = err?.cause?.code || err?.message || 'unknown error';
      throw new CliError(`Cannot reach EvalBoard at ${baseUrl} (${reason}). Is the server running? Check EVALBOARD_URL.`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      if (res.status === 401) {
        throw new CliError(path === '/auth/login'
          ? 'Wrong email or password.'
          : 'Authentication failed. Check EVALBOARD_TOKEN (or your email and password).');
      }
      const detail = data?.issues
        ? data.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
        : data?.message || data?.error || `HTTP ${res.status}`;
      throw new CliError(`${method} ${path} failed: ${detail}`);
    }
    return data;
  }

  return {
    setToken: (t) => { token = t; },
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}

async function authenticate(client, env) {
  if (env.EVALBOARD_TOKEN) return client.setToken(env.EVALBOARD_TOKEN);
  if (env.EVALBOARD_EMAIL && env.EVALBOARD_PASSWORD) {
    const res = await client.post('/auth/login', { email: env.EVALBOARD_EMAIL, password: env.EVALBOARD_PASSWORD });
    return client.setToken(res.token);
  }
  throw new CliError('Not signed in. Set EVALBOARD_TOKEN, or EVALBOARD_EMAIL and EVALBOARD_PASSWORD.');
}

// Find an item by id, or by name (case-insensitive)
function pick(items, key, label) {
  const byId = items.find((i) => i.id === key);
  if (byId) return byId;
  const matches = items.filter((i) => i.name.toLowerCase() === key.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CliError(`More than one ${label} is named "${key}". Use its id instead: ${matches.map((m) => m.id).join(', ')}`);
  }
  const available = items.map((i) => `"${i.name}"`).join(', ') || 'none yet';
  throw new CliError(`No ${label} found with the name or id "${key}". Available: ${available}`);
}

async function waitForRun(client, runId, { timeoutMs, pollMs, onProgress }) {
  const started = Date.now();
  let lastProgress = '';
  for (;;) {
    const run = await client.get(`/runs/${runId}`);
    const progress = `${run.summary.completed}/${run.summary.total}`;
    if (progress !== lastProgress) {
      lastProgress = progress;
      onProgress(progress);
    }
    if (run.status === 'completed' || run.status === 'failed') return run;
    if (Date.now() - started > timeoutMs) {
      throw new CliError(`Timed out after ${timeoutMs / 1000}s waiting for run ${runId}. It may still be running on the server.`);
    }
    await sleep(pollMs);
  }
}

function firstFailureReason(graderResults) {
  const list = graderResults || [];
  const failed = list.find((g) => !g.passed && !g.skipped) || list[0];
  return failed ? failed.reason : null;
}

// ---------- quality gates ----------
export function evaluateGates({ summary, comparison, failUnder, maxDrop, maxRegressions }) {
  const gates = [];
  if (failUnder !== undefined) {
    const ok = summary.passRate >= failUnder - 1e-9;
    gates.push({
      name: 'fail-under',
      passed: ok,
      message: ok
        ? `Pass rate ${pct(summary.passRate)} meets the required ${pct(failUnder)}`
        : `Pass rate ${pct(summary.passRate)} is below the required ${pct(failUnder)}`,
    });
  }
  if (maxDrop !== undefined && comparison) {
    const change = comparison.delta.passRate ?? 0;
    const ok = change >= -maxDrop - 1e-9;
    gates.push({
      name: 'max-drop',
      passed: ok,
      message: `Pass rate changed by ${points(change)} versus the baseline (allowed drop: ${(maxDrop * 100).toFixed(1)} pts)`,
    });
  }
  if (maxRegressions !== undefined && comparison) {
    const n = comparison.counts.regressions;
    gates.push({
      name: 'max-regressions',
      passed: n <= maxRegressions,
      message: `${n} regression${n === 1 ? '' : 's'} versus the baseline (allowed: ${maxRegressions})`,
    });
  }
  return gates;
}

// ---------- reports ----------
function buildReport(r) {
  const s = r.run.summary;
  const lines = [];
  lines.push(`EvalBoard · ${r.suite.name} on ${r.target.name} (${r.target.model})`, '');
  lines.push(`  Pass rate   ${pct(s.passRate)}   (${s.passed} of ${s.passed + s.failed + s.errors} graded)`);
  lines.push(`  Failed ${s.failed}   Errors ${s.errors}   Ungraded ${s.ungraded}`);
  lines.push(`  Latency     avg ${ms(s.avgLatencyMs)}, p95 ${ms(s.p95LatencyMs)}`);
  lines.push(`  Tokens      ${s.inputTokens + s.outputTokens}   Cost ${usd(s.costUsd)}`);
  lines.push(`  Details     ${r.run.url}`);

  if (r.failedCases.length) {
    lines.push('', 'Failed cases');
    for (const c of r.failedCases) {
      lines.push(`  ✗ ${oneLine(c.input, 90)}`);
      if (c.output !== null) lines.push(`      output: ${oneLine(c.output)}`);
      if (c.error) lines.push(`      error:  ${oneLine(c.error)}`);
      if (c.reason) lines.push(`      why:    ${oneLine(c.reason)}`);
    }
    const hidden = s.failed + s.errors - r.failedCases.length;
    if (hidden > 0) lines.push(`  … and ${hidden} more (see the dashboard)`);
  }

  if (r.comparison) {
    const c = r.comparison;
    lines.push('', `Compared with baseline run ${r.baseline.runId} (${r.baseline.target})`);
    lines.push(`  Pass rate ${pct(r.baseline.summary.passRate)} → ${pct(s.passRate)}  (${c.delta.passRate === null ? '–' : points(c.delta.passRate)})`);
    lines.push(`  Regressions ${c.counts.regressions}   Improvements ${c.counts.improvements}   Unchanged ${c.counts.unchanged}`);
    for (const reg of c.regressions.slice(0, 10)) {
      lines.push(`  ✗ ${oneLine(reg.input, 90)}`);
      lines.push(`      before: ${oneLine(reg.a.output)}`);
      lines.push(`      now:    ${oneLine(reg.b.output)}`);
      if (reg.b.reason) lines.push(`      why:    ${oneLine(reg.b.reason)}`);
    }
    if (c.regressions.length > 10) lines.push(`  … and ${c.regressions.length - 10} more regressions`);
  }

  lines.push('', 'Quality gates');
  if (!r.gates.length) lines.push('  (none set. Add --fail-under to make this a pass/fail check)');
  for (const g of r.gates) lines.push(`  ${g.passed ? '✓' : '✗'} ${g.message}`);
  lines.push('', r.passed ? 'RESULT: PASSED' : 'RESULT: FAILED');
  return lines.join('\n');
}

const mdSafe = (text, max = 90) => oneLine(text, max).replace(/[|`*_<>]/g, ' ');

function buildMarkdown(r) {
  const s = r.run.summary;
  const out = [];
  out.push(`### EvalBoard: ${r.passed ? '✅ passed' : '❌ failed'}`, '');
  out.push(`**${mdSafe(r.suite.name)}** on **${mdSafe(r.target.name)}** (${mdSafe(r.target.model)}) · [view run](${r.run.url})`, '');
  out.push('| Pass rate | Failed | Errors | Avg latency | Cost |', '|---|---|---|---|---|');
  out.push(`| ${pct(s.passRate)} | ${s.failed} | ${s.errors} | ${ms(s.avgLatencyMs)} | ${usd(s.costUsd)} |`, '');
  if (r.gates.length) {
    out.push('**Quality gates**', '');
    for (const g of r.gates) out.push(`- ${g.passed ? '✅' : '❌'} ${mdSafe(g.message, 200)}`);
    out.push('');
  }
  if (r.comparison && r.comparison.regressions.length) {
    out.push(`**Regressions versus baseline (${r.comparison.regressions.length})**`, '');
    for (const reg of r.comparison.regressions.slice(0, 10)) {
      out.push(`- ${mdSafe(reg.input)}: was \`${mdSafe(reg.a.output, 40)}\`, now \`${mdSafe(reg.b.output, 40)}\``);
    }
    out.push('');
  }
  return out.join('\n');
}

function emitGithub(result, env, io) {
  if (env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, buildMarkdown(result) + '\n'); } catch { /* not fatal */ }
  }
  if (env.GITHUB_ACTIONS === 'true') {
    for (const g of result.gates.filter((x) => !x.passed)) {
      io.out(`::error title=EvalBoard quality gate::${g.message.replace(/[\r\n]+/g, ' ')}`);
    }
  }
}

// ---------- commands ----------
async function listCommand(client, io) {
  const [suites, targets] = await Promise.all([client.get('/suites'), client.get('/targets')]);
  io.out('Suites');
  io.out(suites.length ? suites.map((s) => `  ${s.name}  (${s.caseCount} cases)  id ${s.id}`).join('\n') : '  none yet');
  io.out('\nTargets');
  io.out(targets.length ? targets.map((t) => `  ${t.name}  model ${t.model}  id ${t.id}`).join('\n') : '  none yet');
  return 0;
}

async function runCommand(values, env, io, client, baseUrl) {
  if (!values.suite) throw new CliError('--suite is required. Run "evalboard list" to see your suites.');
  if (!values.target) throw new CliError('--target is required. Run "evalboard list" to see your targets.');

  const repeat = values.repeat !== undefined ? toNumber(values.repeat, 'repeat', { min: 1, max: 10, integer: true }) : 1;
  const concurrency = values.concurrency !== undefined ? toNumber(values.concurrency, 'concurrency', { min: 1, max: 10, integer: true }) : 3;
  const failUnder = values['fail-under'] !== undefined ? toRate(values['fail-under'], 'fail-under') : undefined;
  const maxDrop = values['max-drop'] !== undefined ? toRate(values['max-drop'], 'max-drop') : undefined;
  const maxRegressions = values['max-regressions'] !== undefined ? toNumber(values['max-regressions'], 'max-regressions', { min: 0, integer: true }) : undefined;
  const timeoutMs = (values.timeout !== undefined ? toNumber(values.timeout, 'timeout', { min: 0 }) : 600) * 1000;
  const pollMs = Number(env.EVALBOARD_POLL_MS) || 2000;
  if ((maxDrop !== undefined || maxRegressions !== undefined) && !values.baseline) {
    throw new CliError('--max-drop and --max-regressions need --baseline <run-id|latest>.');
  }

  let promptText;
  if (values['system-prompt-file']) {
    try { promptText = readFileSync(values['system-prompt-file'], 'utf8').replace(/\s+$/, ''); }
    catch { throw new CliError(`Cannot read the prompt file "${values['system-prompt-file']}".`); }
    if (!promptText) throw new CliError(`The prompt file "${values['system-prompt-file']}" is empty.`);
  }

  await authenticate(client, env);
  const [suites, targets] = await Promise.all([client.get('/suites'), client.get('/targets')]);
  const suite = pick(suites, values.suite, 'suite');
  let target = pick(targets, values.target, 'target');

  // Resolve the baseline BEFORE starting, so "latest" can never pick up our own new run
  let baselineId = null;
  if (values.baseline === 'latest') {
    const earlier = await client.get('/runs?suiteId=' + encodeURIComponent(suite.id));
    baselineId = (earlier.find((r) => r.status === 'completed') || {}).id || null;
    if (!baselineId) io.err('Note: no earlier completed run of this suite, so there is nothing to compare with yet.');
  } else if (values.baseline) {
    baselineId = values.baseline;
  }

  // Test a new prompt: make a copy of the target that uses it (the original is never changed)
  if (promptText) {
    const stamp = (env.GITHUB_SHA || '').slice(0, 7) || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const name = (values.name || `${target.name} [ci ${stamp}]`).slice(0, 100);
    target = await client.post('/targets', {
      name,
      credentialId: target.credentialId,
      model: target.model,
      systemPrompt: promptText,
      temperature: orUndefined(target.temperature),
      maxTokens: orUndefined(target.maxTokens),
      inputPricePerM: orUndefined(target.inputPricePerM),
      outputPricePerM: orUndefined(target.outputPricePerM),
    });
    io.err(`Created target "${target.name}" from ${values['system-prompt-file']}`);
  }

  const started = await client.post('/runs', { suiteId: suite.id, targetId: target.id, repeat, concurrency });
  io.err(`Run ${started.id} started (${started.total} executions)`);
  const run = await waitForRun(client, started.id, {
    timeoutMs,
    pollMs,
    onProgress: (p) => io.err(`  ${p} done`),
  });
  if (run.status === 'failed') throw new CliError(`The run failed: ${run.error || 'unknown reason'}`);
  if (run.summary.passRate === null) {
    throw new CliError('Nothing was graded: none of the cases in this suite have graders. Add graders (for example a "grader" column in your CSV).');
  }

  let comparison = null;
  let baseline = null;
  if (baselineId) {
    comparison = await client.get(`/runs/compare?a=${encodeURIComponent(baselineId)}&b=${encodeURIComponent(run.id)}`);
    baseline = { runId: baselineId, target: comparison.a.target, model: comparison.a.model, summary: comparison.a.summary };
  }

  const [failed, errored] = await Promise.all([
    run.summary.failed ? client.get(`/runs/${run.id}/results?status=failed&limit=10`) : [],
    run.summary.errors ? client.get(`/runs/${run.id}/results?status=error&limit=5`) : [],
  ]);
  const failedCases = [...failed, ...errored].map((c) => ({
    input: c.input,
    expected: c.expected,
    output: c.output,
    error: c.error,
    reason: c.error ? null : firstFailureReason(c.graderResults),
  }));

  const gates = evaluateGates({ summary: run.summary, comparison, failUnder, maxDrop, maxRegressions });
  const passed = gates.every((g) => g.passed);
  const result = {
    passed,
    exitCode: passed ? 0 : 1,
    suite: { id: suite.id, name: suite.name },
    target: { id: target.id, name: target.name, model: target.model },
    run: { id: run.id, status: run.status, url: `${baseUrl}/#/run/${run.id}`, summary: run.summary },
    baseline,
    comparison: comparison && { delta: comparison.delta, counts: comparison.counts, regressions: comparison.regressions },
    gates,
    failedCases,
  };

  io.out(values.json ? JSON.stringify(result, null, 2) : buildReport(result));
  emitGithub(result, env, io);
  return result.exitCode;
}

// ---------- entry point ----------
const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

export async function main(argv, env = process.env, io = defaultIo, fetchImpl = globalThis.fetch) {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          suite: { type: 'string' },
          target: { type: 'string' },
          'system-prompt-file': { type: 'string' },
          name: { type: 'string' },
          repeat: { type: 'string' },
          concurrency: { type: 'string' },
          baseline: { type: 'string' },
          'fail-under': { type: 'string' },
          'max-drop': { type: 'string' },
          'max-regressions': { type: 'string' },
          timeout: { type: 'string' },
          json: { type: 'boolean' },
          url: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (err) {
      throw new CliError(`${err.message}\nRun "evalboard --help" for usage.`);
    }

    const { values, positionals } = parsed;
    const command = positionals[0];
    if (values.help || command === 'help') { io.out(HELP); return 0; }
    if (!command) { io.out(HELP); return 2; }
    if (command !== 'run' && command !== 'list') {
      throw new CliError(`Unknown command "${command}". Use "run" or "list".`);
    }

    const baseUrl = (values.url || env.EVALBOARD_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const client = createClient(baseUrl, fetchImpl);

    if (command === 'list') {
      await authenticate(client, env);
      return await listCommand(client, io);
    }
    return await runCommand(values, env, io, client, baseUrl);
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`error: ${err.message}`);
      return err.exitCode;
    }
    io.err(`error: unexpected problem: ${err?.message || err}`);
    return 2;
  }
}

// Run only when executed directly (not when imported by the tests)
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
