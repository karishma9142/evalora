'use strict';

// ================= tiny toolkit =================
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');

const state = {
  token: localStorage.getItem('evalboard_token'),
  email: localStorage.getItem('evalboard_email') || '',
};
let navId = 0;
let pollTimer = null;

// Builds DOM elements. Text is always added as a text node (never innerHTML),
// so AI output and user input can never inject HTML or scripts into the page.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const a = attrs || {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined || v === false || k === 'value') continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  if (a.value !== undefined && a.value !== null) el.value = a.value; // after children, so <select> works
  return el;
}

function notice(message, kind) {
  const el = h('div', { class: 'toast ' + (kind || 'ok') }, message);
  $toast.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

const pct = (x) => (x === null || x === undefined ? '–' : Math.round(x * 1000) / 10 + '%');
const ms = (x) => (x === null || x === undefined ? '–' : x >= 1000 ? (x / 1000).toFixed(2) + ' s' : Math.round(x) + ' ms');
const usd = (x) => (x === null || x === undefined ? '–' : x < 0.01 ? '$' + x.toFixed(6) : '$' + x.toFixed(4));
const num = (x) => (x === null || x === undefined ? '–' : Number(x).toLocaleString());
const when = (s) =>
  s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const signed = (v, digits) => (v > 0 ? '+' : '') + (Math.round(v * 10 ** digits) / 10 ** digits);
const rateClass = (v) => (v === null || v === undefined ? '' : v >= 0.8 ? 'good' : v >= 0.5 ? 'warn' : 'bad');

// ================= API client =================
class ApiError extends Error {
  constructor(status, data) {
    super(describeError(data));
    this.status = status;
    this.data = data;
  }
}

const FRIENDLY = {
  invalid_credentials: 'Wrong email or password.',
  email_already_registered: 'That email is already registered. Try signing in instead.',
  unauthorized: 'Please sign in again.',
  credential_in_use: 'Delete the targets that use this key first.',
  target_in_use: 'This target already has runs, so it cannot be deleted.',
  suite_has_no_cases: 'Add test cases to this suite first.',
  credential_not_found: 'Pick a credential first.',
};

function describeError(data) {
  if (!data) return 'Request failed';
  if (data.error && FRIENDLY[data.error]) return FRIENDLY[data.error];
  if (data.issues) return data.issues.map((i) => (i.path ? i.path + ': ' : '') + i.message).join('; ');
  if (data.errors) return data.errors.map((e) => 'row ' + e.row + ': ' + e.message).join('; ');
  return data.message || data.error || 'Request failed';
}

async function api(path, opts) {
  const o = opts || {};
  const headers = {};
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  let body;
  if (o.csv !== undefined) {
    headers['content-type'] = 'text/csv';
    body = o.csv;
  } else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const res = await fetch(path, { method: o.method || 'GET', headers, body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: 'Unexpected response from the server' }; }
  if (res.status === 401 && state.token) {
    logout();
    throw new ApiError(401, { message: 'Your session expired. Please sign in again.' });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ================= auth =================
function saveSession(data) {
  state.token = data.token;
  state.email = data.user.email;
  localStorage.setItem('evalboard_token', state.token);
  localStorage.setItem('evalboard_email', state.email);
}

function logout() {
  state.token = null;
  localStorage.removeItem('evalboard_token');
  localStorage.removeItem('evalboard_email');
  route();
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function loginPage() {
  $nav.replaceChildren();
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const pw = h('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'current-password' });
  const err = h('p', { class: 'error' });

  async function submit(kind) {
    err.textContent = '';
    try {
      saveSession(await api('/auth/' + kind, { method: 'POST', body: { email: email.value, password: pw.value } }));
      go('#/');
    } catch (e) {
      err.textContent = e.message;
    }
  }

  $app.replaceChildren(
    h('form', { class: 'card narrow', onsubmit: (ev) => { ev.preventDefault(); submit('login'); } },
      h('h1', {}, 'EvalBoard'),
      h('p', { class: 'muted' }, 'Measure, compare and track the quality of any AI.'),
      email, pw, err,
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'primary' }, 'Sign in'),
        h('button', { type: 'button', onclick: () => submit('register') }, 'Create account'))));
}

// ================= shared components =================
const badge = (status) => h('span', { class: 'badge ' + status }, status);

function stat(label, value, sub, cls) {
  return h('div', { class: 'stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value ' + (cls || '') }, value),
    sub ? h('div', { class: 'sub' }, sub) : null);
}

function rateBar(v) {
  return h('div', { class: 'rate' },
    h('div', { class: 'bar' }, h('i', { class: rateClass(v), style: { width: (v === null || v === undefined ? 0 : v * 100) + '%' } })),
    h('span', {}, pct(v)));
}

function field(label, text) {
  return h('div', { class: 'field' }, h('label', {}, label), h('pre', {}, text));
}

function inp(type, placeholder, extra) {
  return h('input', Object.assign({ type, placeholder }, extra || {}));
}

function sel(options, value) {
  return h('select', { value }, options.map(([v, l]) => h('option', { value: v }, l)));
}

function labeled(text, control, cls) {
  return h('label', { class: cls || '' }, text, control);
}

const optNum = (el) => (el.value === '' ? undefined : Number(el.value));
const optStr = (el) => (el.value.trim() === '' ? undefined : el.value);

async function guarded(fn) {
  try { await fn(); } catch (e) { notice(e.message, 'error'); }
}

// ================= pages =================
let runsFilter = '';

async function runsPage(ctx) {
  const [suites, targets] = await Promise.all([api('/suites'), api('/targets')]);

  if (!suites.length || !targets.length) {
    return ctx.mount(h('div', { class: 'card' },
      h('h2', {}, 'Welcome to EvalBoard'),
      h('p', { class: 'muted' }, 'Three steps to your first evaluation:'),
      h('ol', {},
        h('li', {}, h('a', { href: '#/targets' }, 'Add a credential and a target'), targets.length ? ' ✓' : ' (your AI and your API key)'),
        h('li', {}, h('a', { href: '#/suites' }, 'Create a suite and import test cases'), suites.length ? ' ✓' : ' (questions, and how to grade them)'),
        h('li', {}, 'Come back here and press Start run'))));
  }

  if (!suites.some((s) => s.id === runsFilter)) runsFilter = suites[0].id;
  const runs = await api('/runs?suiteId=' + encodeURIComponent(runsFilter));
  const targetName = (id) => (targets.find((t) => t.id === id) || {}).name || 'deleted target';

  // --- start a run
  const suiteSel = sel(suites.map((s) => [s.id, s.name + ' (' + s.caseCount + ' cases)']), runsFilter);
  suiteSel.addEventListener('change', () => { runsFilter = suiteSel.value; route(); });
  const targetSel = sel(targets.map((t) => [t.id, t.name]), targets[0].id);
  const repeat = inp('number', '1', { min: 1, max: 10, value: 1 });
  const startBtn = h('button', { class: 'primary' }, 'Start run');
  startBtn.addEventListener('click', () => guarded(async () => {
    startBtn.disabled = true;
    try {
      const r = await api('/runs', { method: 'POST', body: { suiteId: suiteSel.value, targetId: targetSel.value, repeat: Number(repeat.value) || 1 } });
      go('#/run/' + r.id);
    } finally { startBtn.disabled = false; }
  }));

  // --- compare selection
  const selected = new Set();
  const compareBtn = h('button', { disabled: true }, 'Select 2 runs to compare');
  compareBtn.addEventListener('click', () => {
    const ordered = [...selected].sort((x, y) => runs.findIndex((r) => r.id === y) - runs.findIndex((r) => r.id === x));
    go('#/compare/' + ordered[0] + '/' + ordered[1]); // older run = baseline (A)
  });
  const updateCompare = () => {
    compareBtn.disabled = selected.size !== 2;
    compareBtn.textContent = selected.size === 2 ? 'Compare selected runs' : 'Select 2 runs to compare';
  };

  const rows = runs.map((r) => {
    const box = h('input', { type: 'checkbox' });
    box.addEventListener('change', () => { if (box.checked) selected.add(r.id); else selected.delete(r.id); updateCompare(); });
    const s = r.summary;
    return h('tr', {},
      h('td', {}, box),
      h('td', {}, h('a', { href: '#/run/' + r.id }, when(r.createdAt))),
      h('td', {}, targetName(r.targetId)),
      h('td', {}, badge(r.status)),
      h('td', {}, rateBar(s.passRate)),
      h('td', {}, s.passed + '/' + s.completed, s.errors ? h('span', { class: 'bad small' }, ' · ' + s.errors + ' errors') : null),
      h('td', {}, ms(s.avgLatencyMs)),
      h('td', {}, usd(s.costUsd)));
  });

  ctx.mount(
    h('div', { class: 'card' },
      h('h2', {}, 'Start a run'),
      h('div', { class: 'form' },
        labeled('Suite', suiteSel), labeled('Target (the AI to test)', targetSel), labeled('Repeat each case', repeat),
        h('div', {}, startBtn))),
    h('div', { class: 'card' },
      h('h2', {}, 'Pass rate over time'),
      h('p', { class: 'muted small' }, 'For the suite selected above. Each dot is one completed run.'),
      trendChart(runs, targetName)),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Runs'), compareBtn),
      runs.length
        ? h('table', {},
            h('thead', {}, h('tr', {}, ['', 'Started', 'Target', 'Status', 'Pass rate', 'Passed', 'Avg latency', 'Cost'].map((t) => h('th', {}, t)))),
            h('tbody', {}, rows))
        : h('p', { class: 'muted' }, 'No runs for this suite yet. Press Start run above.')));
}

function trendChart(runs, targetName) {
  const pts = runs.filter((r) => r.status === 'completed' && r.summary.passRate !== null).slice(0, 20).reverse();
  if (pts.length < 2) return h('p', { class: 'muted' }, 'Run this suite at least twice to see a trend.');
  const W = 640, H = 180, P = { l: 40, r: 12, t: 12, b: 20 };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('class', 'chart');
  const x = (i) => P.l + (i * (W - P.l - P.r)) / (pts.length - 1);
  const y = (v) => P.t + (1 - v) * (H - P.t - P.b);
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (const t of [0, 0.5, 1]) {
    add('line', { x1: P.l, x2: W - P.r, y1: y(t), y2: y(t), class: 'grid' });
    add('text', { x: P.l - 6, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' }, Math.round(t * 100) + '%');
  }
  add('polyline', { points: pts.map((r, i) => x(i) + ',' + y(r.summary.passRate)).join(' '), class: 'line', fill: 'none' });
  pts.forEach((r, i) => {
    const c = add('circle', { cx: x(i), cy: y(r.summary.passRate), r: 5, class: 'dot' });
    const title = document.createElementNS(ns, 'title');
    title.textContent = targetName(r.targetId) + ' · ' + when(r.createdAt) + ' · ' + pct(r.summary.passRate);
    c.append(title);
  });
  return svg;
}

// ---------- one run ----------
function resultItem(r, repeat) {
  const st = r.error ? 'error' : r.output === null ? 'pending' : r.passed === null ? 'ungraded' : r.passed ? 'passed' : 'failed';
  return h('details', { class: 'result ' + st },
    h('summary', {},
      h('span', { class: 'badge' }, st),
      h('span', { class: 'q' }, r.input),
      repeat > 1 ? h('span', { class: 'meta' }, 'attempt ' + r.attempt) : null,
      h('span', { class: 'meta' }, ms(r.latencyMs))),
    h('div', { class: 'detail' },
      field('Input', r.input),
      field('Output', r.output === null ? '(no output)' : r.output),
      r.expected ? field('Expected', r.expected) : null,
      r.error ? field('Error', r.error) : null,
      (r.graderResults || []).map((g) =>
        h('p', { class: 'grader ' + (g.skipped ? 'skip' : g.passed ? 'ok' : 'bad') }, g.type + ': ' + g.reason)),
      h('p', { class: 'muted small' }, num(r.inputTokens) + ' tokens in · ' + num(r.outputTokens) + ' out · ' + usd(r.costUsd))));
}

async function runPage(ctx, id) {
  const [run, suites, targets] = await Promise.all([api('/runs/' + id), api('/suites'), api('/targets')]);
  const suite = suites.find((s) => s.id === run.suiteId);
  const target = targets.find((t) => t.id === run.targetId);
  const s = run.summary;
  const running = run.status === 'queued' || run.status === 'running';

  const progressText = h('span', {}, s.completed + ' / ' + s.total + ' done');
  const progressBar = h('i', { style: { width: (s.total ? (s.completed / s.total) * 100 : 0) + '%' } });

  const list = h('div', {});
  let current = 'all';
  const tabsEl = h('div', { class: 'tabs' });
  const tabDefs = [['all', 'All', s.total], ['failed', 'Failed', s.failed], ['passed', 'Passed', s.passed], ['error', 'Errors', s.errors], ['ungraded', 'Ungraded', s.ungraded]];

  async function load() {
    list.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    tabsEl.replaceChildren(...tabDefs.map(([key, label, n]) => {
      const b = h('button', { class: key === current ? 'on' : '' }, label + ' (' + n + ')');
      b.addEventListener('click', () => { current = key; load(); });
      return b;
    }));
    await guarded(async () => {
      const rows = await api('/runs/' + id + '/results?limit=500' + (current === 'all' ? '' : '&status=' + current));
      list.replaceChildren(...(rows.length ? rows.map((r) => resultItem(r, run.repeat)) : [h('p', { class: 'muted' }, 'Nothing here.')]));
    });
  }

  ctx.mount(
    h('p', {}, h('a', { href: '#/' }, '← All runs')),
    h('div', { class: 'row' },
      h('h2', { class: 'grow' }, (target ? target.name : 'Run') + ' on ' + (suite ? suite.name : 'suite')),
      badge(run.status)),
    h('p', { class: 'muted small' }, 'Started ' + when(run.startedAt || run.createdAt) + (run.finishedAt ? ' · finished ' + when(run.finishedAt) : '') + (target ? ' · model ' + target.model : '') + (run.repeat > 1 ? ' · repeated ×' + run.repeat : '')),
    run.error ? h('div', { class: 'banner' }, run.error) : null,
    running
      ? h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, 'Running…'), progressText), h('div', { class: 'bar big' }, progressBar),
          h('p', { class: 'muted small' }, 'This page updates by itself. Local models can take a few seconds per test.'))
      : null,
    h('div', { class: 'stats' },
      stat('Pass rate', pct(s.passRate), s.passed + ' of ' + (s.passed + s.failed + s.errors) + ' graded', rateClass(s.passRate)),
      stat('Failed', num(s.failed), null, s.failed ? 'bad' : ''),
      stat('Errors', num(s.errors), 'provider problems', s.errors ? 'bad' : ''),
      stat('Avg latency', ms(s.avgLatencyMs), 'p95 ' + ms(s.p95LatencyMs)),
      stat('Tokens', num(s.inputTokens + s.outputTokens), num(s.inputTokens) + ' in · ' + num(s.outputTokens) + ' out'),
      stat('Cost', usd(s.costUsd), s.costUsd === null ? 'no prices set on target' : null)),
    running ? null : h('div', {}, h('h3', {}, 'Results'), tabsEl, list));

  if (!running) await load();

  if (running) {
    pollTimer = setInterval(async () => {
      if (!ctx.alive()) { clearInterval(pollTimer); return; }
      try {
        const r = await api('/runs/' + id);
        progressText.textContent = r.summary.completed + ' / ' + r.summary.total + ' done';
        progressBar.style.width = (r.summary.total ? (r.summary.completed / r.summary.total) * 100 : 0) + '%';
        if (r.status !== 'queued' && r.status !== 'running') { clearInterval(pollTimer); route(); }
      } catch { /* keep polling */ }
    }, 2000);
  }
}

// ---------- compare ----------
function sideCard(title, side) {
  const s = side.summary;
  return h('div', { class: 'card' },
    h('div', { class: 'small muted' }, title),
    h('h3', {}, side.target),
    h('p', { class: 'muted small' }, side.model),
    h('div', { class: 'value ' + rateClass(s.passRate), style: { fontSize: '28px', fontWeight: '700' } }, pct(s.passRate)),
    h('p', { class: 'muted small' }, s.passed + ' passed · ' + s.failed + ' failed · ' + s.errors + ' errors'),
    h('p', { class: 'muted small' }, 'avg ' + ms(s.avgLatencyMs) + ' · ' + num(s.inputTokens + s.outputTokens) + ' tokens · ' + usd(s.costUsd)));
}

function deltaStat(label, value, text, higherIsBetter) {
  if (value === null || value === undefined) return stat(label, '–');
  const cls = value === 0 || higherIsBetter === null ? '' : (value > 0) === higherIsBetter ? 'good' : 'bad';
  return stat(label, value === 0 ? 'no change' : text, null, cls);
}

function caseDiff(item) {
  const side = (label, v) => h('div', { class: 'side ' + (v.passRate === 1 ? 'ok' : v.passRate === 0 ? 'bad' : 'mixed') },
    h('div', { class: 'small muted' }, label + ' · pass rate ' + pct(v.passRate)),
    h('pre', {}, v.output === null ? '(no output)' : v.output),
    v.reason ? h('p', { class: 'small' }, v.reason) : null);
  return h('div', { class: 'card' },
    h('h4', {}, item.input),
    item.expected ? h('p', { class: 'muted small' }, 'Expected: ' + item.expected) : null,
    h('div', { class: 'grid2' }, side('A', item.a), side('B', item.b)));
}

function compareView(c) {
  const d = c.delta;
  return h('div', {},
    h('div', { class: 'grid2', style: { marginBottom: '16px' } }, sideCard('A · baseline', c.a), sideCard('B · new version', c.b)),
    h('div', { class: 'card deltas' },
      deltaStat('Pass rate', d.passRate, d.passRate === null ? '' : signed(d.passRate * 100, 1) + ' pts', true),
      deltaStat('Avg latency', d.avgLatencyMs, d.avgLatencyMs === null ? '' : signed(d.avgLatencyMs, 0) + ' ms', false),
      deltaStat('Tokens', d.totalTokens, signed(d.totalTokens, 0), null),
      deltaStat('Cost', d.costUsd, d.costUsd === null ? '' : signed(d.costUsd * 1e6, 2) + ' µ$', false)),
    h('h3', { class: bad(c.counts.regressions) }, 'Regressions (' + c.counts.regressions + ')'),
    c.regressions.length ? c.regressions.map(caseDiff) : h('p', { class: 'muted' }, 'No regressions. Nothing that passed before fails now.'),
    h('h3', { class: c.counts.improvements ? 'good' : '' }, 'Improvements (' + c.counts.improvements + ')'),
    c.improvements.length ? c.improvements.map(caseDiff) : h('p', { class: 'muted' }, 'No improvements.'),
    h('p', { class: 'muted small' }, c.counts.unchanged + ' cases unchanged' + (c.counts.skipped ? ' · ' + c.counts.skipped + ' skipped (ungraded or missing in one run)' : '')));
}
const bad = (n) => (n ? 'bad' : '');

async function comparePage(ctx, a, b) {
  const [runs, targets, suites] = await Promise.all([api('/runs'), api('/targets'), api('/suites')]);
  const done = runs.filter((r) => r.status === 'completed');
  const label = (r) =>
    ((suites.find((s) => s.id === r.suiteId) || {}).name || '?') + ' · ' + ((targets.find((t) => t.id === r.targetId) || {}).name || '?') + ' · ' + when(r.createdAt) + ' · ' + pct(r.summary.passRate);
  const opts = done.map((r) => [r.id, label(r)]);

  let body = h('p', { class: 'muted' }, done.length < 2
    ? 'You need at least two completed runs of the same suite. Start runs from the Runs page.'
    : 'Pick a baseline (A) and a new version (B), both from the same suite.');

  const aSel = sel(opts.length ? opts : [['', 'no completed runs']], a || (opts[1] || opts[0] || [''])[0]);
  const bSel = sel(opts.length ? opts : [['', 'no completed runs']], b || (opts[0] || [''])[0]);
  const btn = h('button', { class: 'primary' }, 'Compare');
  btn.addEventListener('click', () => { if (aSel.value && bSel.value) go('#/compare/' + aSel.value + '/' + bSel.value); });

  if (a && b) {
    try { body = compareView(await api('/runs/compare?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b))); }
    catch (e) { body = h('div', { class: 'banner' }, e.message); }
  }

  ctx.mount(
    h('div', { class: 'card' },
      h('h2', {}, 'Compare two runs'),
      h('div', { class: 'form' }, labeled('A · baseline', aSel), labeled('B · new version', bSel), h('div', {}, btn))),
    body);
}

// ---------- suites ----------
async function suitesPage(ctx) {
  const suites = await api('/suites');

  const name = inp('text', 'e.g. Customer support questions');
  const desc = inp('text', 'Optional description');
  const create = h('button', { class: 'primary' }, 'Create suite');
  create.addEventListener('click', () => guarded(async () => {
    await api('/suites', { method: 'POST', body: { name: name.value, description: optStr(desc) } });
    notice('Suite created');
    route();
  }));

  const sample = 'input,expected,tags,grader\nWhat is the capital of France?,Paris,geography,contains\n"Reply with a JSON object with a key called name.",,format,json_valid';

  const cards = suites.map((s) => {
    const csv = h('textarea', { placeholder: sample });
    const file = h('input', { type: 'file', accept: '.csv,text/csv' });
    file.addEventListener('change', async () => { if (file.files[0]) csv.value = await file.files[0].text(); });
    const importBtn = h('button', { class: 'primary' }, 'Import cases');
    importBtn.addEventListener('click', () => guarded(async () => {
      if (!csv.value.trim()) throw new Error('Paste CSV text or choose a file first.');
      const r = await api('/suites/' + s.id + '/import-csv', { method: 'POST', csv: csv.value });
      notice('Imported ' + r.imported + ' cases');
      route();
    }));
    const del = h('button', { class: 'danger' }, 'Delete suite');
    del.addEventListener('click', () => guarded(async () => {
      if (!confirm('Delete "' + s.name + '" with its cases AND all of its runs?')) return;
      await api('/suites/' + s.id, { method: 'DELETE' });
      route();
    }));

    const casesBox = h('div', { class: 'muted small' }, 'Open to load cases…');
    const details = h('details', { class: 'card' },
      h('summary', { style: { cursor: 'pointer' } }, h('strong', {}, s.name), h('span', { class: 'muted' }, '  ·  ' + s.caseCount + ' cases' + (s.description ? '  ·  ' + s.description : ''))),
      h('div', { style: { marginTop: '12px' } },
        h('h4', {}, 'Import from CSV'),
        h('p', { class: 'muted small' }, 'Columns: input (required), expected, context, tags (separate with ;), grader (contains, exact_match or json_valid).'),
        csv, h('div', { class: 'row', style: { marginTop: '8px' } }, file, importBtn, h('span', { class: 'grow' }), del),
        h('h4', { style: { marginTop: '16px' } }, 'Cases'), casesBox));
    let loaded = false;
    details.addEventListener('toggle', () => {
      if (!details.open || loaded) return;
      loaded = true;
      guarded(async () => {
        const data = await api('/suites/' + s.id + '/cases?limit=100');
        casesBox.replaceChildren(data.cases.length
          ? h('table', {}, h('thead', {}, h('tr', {}, ['Input', 'Expected', 'Graders', 'Tags'].map((t) => h('th', {}, t)))),
              h('tbody', {}, data.cases.map((c) => h('tr', {}, h('td', {}, c.input), h('td', {}, c.expected || '–'), h('td', {}, c.graders.map((g) => g.type).join(', ') || '–'), h('td', {}, c.tags.join(', ') || '–')))))
          : 'No cases yet.');
      });
    });
    return details;
  });

  ctx.mount(
    h('div', { class: 'card' },
      h('h2', {}, 'New suite'),
      h('div', { class: 'form' }, labeled('Name', name), labeled('Description', desc), h('div', {}, create))),
    cards.length ? cards : h('p', { class: 'muted' }, 'No suites yet. Create one above, then import test cases from CSV.'));
}

// ---------- credentials and targets ----------
async function targetsPage(ctx) {
  const [creds, targets] = await Promise.all([api('/credentials'), api('/targets')]);

  // --- add credential
  const cLabel = inp('text', 'e.g. My Claude key');
  const cProvider = sel([['anthropic', 'Anthropic (Claude)'], ['openai-compatible', 'OpenAI-compatible (OpenAI, Ollama, Groq...)']], 'anthropic');
  const cUrl = inp('url', 'http://localhost:11434/v1');
  const cUrlLabel = labeled('Base URL', cUrl, 'hidden');
  const cKey = inp('password', 'Paste your API key', { autocomplete: 'off' });
  const syncUrl = () => cUrlLabel.classList.toggle('hidden', cProvider.value !== 'openai-compatible');
  cProvider.addEventListener('change', syncUrl);
  const preset = h('button', { type: 'button' }, 'Use Ollama preset');
  preset.addEventListener('click', () => {
    cLabel.value = 'Ollama (local)'; cProvider.value = 'openai-compatible'; cUrl.value = 'http://localhost:11434/v1'; cKey.value = 'ollama-local'; syncUrl();
  });
  const addCred = h('button', { class: 'primary' }, 'Save credential');
  addCred.addEventListener('click', () => guarded(async () => {
    await api('/credentials', { method: 'POST', body: { label: cLabel.value, provider: cProvider.value, baseUrl: cProvider.value === 'openai-compatible' ? optStr(cUrl) : undefined, apiKey: cKey.value } });
    notice('Credential saved (encrypted)');
    route();
  }));

  const credItems = creds.map((c) => {
    const del = h('button', { class: 'danger' }, 'Delete');
    del.addEventListener('click', () => guarded(async () => {
      if (!confirm('Delete credential "' + c.label + '"?')) return;
      await api('/credentials/' + c.id, { method: 'DELETE' });
      route();
    }));
    return h('div', { class: 'item' }, h('div', { class: 'grow' }, h('strong', {}, c.label), h('div', { class: 'muted small' }, c.provider + (c.baseUrl ? ' · ' + c.baseUrl : '') + ' · key ' + c.keyHint)), del);
  });

  // --- add target
  const tName = inp('text', 'e.g. Support bot v1');
  const tCred = sel(creds.length ? creds.map((c) => [c.id, c.label]) : [['', 'add a credential first']], creds.length ? creds[0].id : '');
  const tModel = inp('text', 'exact model name, e.g. llama3.2:1b');
  const tSystem = h('textarea', { placeholder: 'Optional system prompt, e.g. Answer in one short sentence.' });
  const tTemp = inp('number', 'optional', { step: '0.1', min: 0, max: 2 });
  const tMax = inp('number', 'optional', { min: 1 });
  const tIn = inp('number', 'optional', { step: 'any', min: 0 });
  const tOut = inp('number', 'optional', { step: 'any', min: 0 });
  const addTarget = h('button', { class: 'primary' }, 'Save target');
  addTarget.addEventListener('click', () => guarded(async () => {
    await api('/targets', { method: 'POST', body: { name: tName.value, credentialId: tCred.value, model: tModel.value, systemPrompt: optStr(tSystem), temperature: optNum(tTemp), maxTokens: optNum(tMax), inputPricePerM: optNum(tIn), outputPricePerM: optNum(tOut) } });
    notice('Target saved');
    route();
  }));

  const targetItems = targets.map((t) => {
    const cred = creds.find((c) => c.id === t.credentialId);
    const prompt = inp('text', 'Type a test prompt', { class: 'grow' });
    const out = h('div', {});
    const send = h('button', {}, 'Send');
    send.addEventListener('click', () => guarded(async () => {
      send.disabled = true; out.replaceChildren(h('p', { class: 'muted small' }, 'Waiting for the model…'));
      try {
        const r = await api('/targets/' + t.id + '/test', { method: 'POST', body: { prompt: prompt.value } });
        out.replaceChildren(field('Output', r.output), h('p', { class: 'muted small' }, num(r.inputTokens) + ' in · ' + num(r.outputTokens) + ' out · ' + ms(r.latencyMs) + ' · ' + usd(r.costUsd)));
      } catch (e) { out.replaceChildren(h('p', { class: 'error' }, e.message)); }
      finally { send.disabled = false; }
    }));
    const box = h('div', { class: 'hidden', style: { width: '100%' } }, h('div', { class: 'row' }, prompt, send), out);
    const testBtn = h('button', {}, 'Test');
    testBtn.addEventListener('click', () => box.classList.toggle('hidden'));
    const del = h('button', { class: 'danger' }, 'Delete');
    del.addEventListener('click', () => guarded(async () => {
      if (!confirm('Delete target "' + t.name + '"?')) return;
      await api('/targets/' + t.id, { method: 'DELETE' });
      route();
    }));
    return h('div', { class: 'item' },
      h('div', { class: 'grow' }, h('strong', {}, t.name), h('div', { class: 'muted small' }, t.model + ' · ' + (cred ? cred.label : '?') + (t.systemPrompt ? ' · prompt: ' + t.systemPrompt.slice(0, 60) : ''))),
      testBtn, del, box);
  });

  ctx.mount(
    h('div', { class: 'card' },
      h('h2', {}, 'Credentials'),
      h('p', { class: 'muted small' }, 'Your own API keys. They are stored encrypted and are never shown again after saving.'),
      credItems.length ? credItems : h('p', { class: 'muted' }, 'No credentials yet.'),
      h('h4', { style: { marginTop: '16px' } }, 'Add a credential'),
      h('div', { class: 'form' }, labeled('Label', cLabel), labeled('Provider', cProvider), cUrlLabel, labeled('API key', cKey),
        h('div', { class: 'row' }, addCred, preset))),
    h('div', { class: 'card' },
      h('h2', {}, 'Targets'),
      h('p', { class: 'muted small' }, 'A target is the AI you are testing: a credential + a model + an optional system prompt.'),
      targetItems.length ? targetItems : h('p', { class: 'muted' }, 'No targets yet.'),
      h('h4', { style: { marginTop: '16px' } }, 'Add a target'),
      h('div', { class: 'form' },
        labeled('Name', tName), labeled('Credential', tCred), labeled('Model', tModel),
        labeled('System prompt', tSystem, 'wide'),
        labeled('Temperature', tTemp), labeled('Max output tokens', tMax),
        labeled('Input price ($ per 1M tokens)', tIn), labeled('Output price ($ per 1M tokens)', tOut),
        h('div', {}, addTarget))));
}

// ================= router =================
const links = [['#/', 'Runs'], ['#/compare', 'Compare'], ['#/suites', 'Suites'], ['#/targets', 'Targets']];

function renderNav() {
  const cur = location.hash || '#/';
  const active = (href) => (href === '#/' ? cur === '#/' || cur.startsWith('#/run/') : cur.startsWith(href));
  $nav.replaceChildren(
    ...links.map(([href, text]) => h('a', { href, class: active(href) ? 'active' : '' }, text)),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted small' }, state.email),
    h('button', { class: 'link', onclick: logout }, 'Sign out'));
}

const routes = [
  [/^#\/?$/, runsPage],
  [/^#\/run\/([\w-]+)$/, runPage],
  [/^#\/compare(?:\/([\w-]+)\/([\w-]+))?$/, comparePage],
  [/^#\/suites$/, suitesPage],
  [/^#\/targets$/, targetsPage],
];

async function route() {
  clearInterval(pollTimer);
  const id = ++navId;
  if (!state.token) return loginPage();
  renderNav();
  const ctx = {
    alive: () => id === navId,
    mount: (...nodes) => { if (id === navId) { $app.replaceChildren(...nodes.flat(Infinity)); window.scrollTo(0, 0); } },
  };
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    try { await fn(ctx, ...m.slice(1)); }
    catch (e) { if (id === navId) ctx.mount(h('div', { class: 'banner' }, e.message)); }
    return;
  }
  go('#/');
}

window.addEventListener('hashchange', route);
route();
