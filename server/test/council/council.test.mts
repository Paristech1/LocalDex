// Integration test: the real council code against stand-in vendor CLIs (no accounts, no network).
// Run with: npm run test:council -w server
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const SRC = new URL('../../src', import.meta.url).pathname;
const DEMO = process.env.DEMO_DIR!;
const { bus } = await import(`${SRC}/agent/bus.ts`);
const { memberStatuses, clearLimit, markLimited } = await import(`${SRC}/council/registry.ts`);
const { classify, parseCommand, findImageRefs } = await import(`${SRC}/council/router.ts`);
const { runCouncil, runSummary, runVia } = await import(`${SRC}/council/orchestrator.ts`);
const { memberEnv } = await import(`${SRC}/council/proc.ts`);
const { updateSettings, getSettings, mergeCouncil } = await import(`${SRC}/config.ts`);
const { resetStats } = await import(`${SRC}/council/stats.ts`);
const { DEFAULT_COUNCIL } = await import(`${SRC}/../../shared/src/index.ts`);

const CTL = process.env.FAKE_CTL!;
const flag = (n: string, on: boolean) => (on ? fs.writeFileSync(path.join(CTL, n), '1') : fs.rmSync(path.join(CTL, n), { force: true }));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); };

// Auto-approve edit prompts, and count them.
let approvals = 0; let denyNext = false;
const events: Record<string, number> = {};
bus.subscribe((ev: any) => {
  events[ev.type] = (events[ev.type] ?? 0) + 1;
  if (ev.type === 'approval_request') { approvals++; setTimeout(() => bus.resolvePrompt(ev.id, !denyNext), 20); }
});

const session: any = { id: 's-test', title: 't', messages: [], workers: {}, plan: [], councilRuns: [], usage: { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0 } };
const ctx = (signal = new AbortController().signal) => ({ session, signal, persist: () => {}, delegateLocal: async () => 'local report' });
const reset = () => { execSync('git checkout -q -- . && git clean -qfd', { cwd: DEMO }); for (const f of fs.readdirSync(CTL)) fs.rmSync(path.join(CTL, f)); for (const m of ['claude','codex','gemini','cursor'] as const) clearLimit(m); };

// 1. env stripping
process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak'; process.env.OPENAI_API_KEY = 'sk-x'; process.env.GEMINI_API_KEY = 'g';
const env = memberEnv();
check('API-key env vars are stripped', !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY && !env.GEMINI_API_KEY);

// 2. statuses
reset();
let st = await memberStatuses(true);
const by = (id: string) => st.find((s: any) => s.id === id)!;
check('claude: installed, signed in, plan', by('claude').installed && by('claude').signedIn && by('claude').billing === 'plan', JSON.stringify({ v: by('claude').version, acct: by('claude').account }));
check('codex: installed, signed in, plan', by('codex').signedIn && by('codex').billing === 'plan', by('codex').version);
check('gemini: signed in via Google, plan', by('gemini').signedIn && by('gemini').billing === 'plan', by('gemini').account);
check('cursor: SDK found, signed in', by('cursor').installed && by('cursor').signedIn, by('cursor').path);

// 3. router
const r = (t: string) => { const x = parseCommand(t) ?? classify(t); return `${x.pattern}/${x.role}${x.member ? `/${x.member}` : ''}`; };
check('router: /ask claude', r('/ask claude explain the auth flow') === 'single/builder/claude');
check('router: /vote', r('/vote zod or valibot?') === 'vote/researcher');
check('router: comparison → vote', r('Should we use zod or valibot here?') === 'vote/researcher');
check('router: review', r('review the rate limiter for bugs') === 'single/reviewer');
check('router: small fix → builder', r('fix the typo in README') === 'single/builder');
check('router: feature → pbr', r('add rate limiting to the API with tests') === 'plan_build_review/backend');
check('router: short question → quick', r('what does add() do?') === 'single/quick');
check('router: design → planner', r('design a caching strategy for the API') === 'single/planner');

// 4. single member runs, read-only, per vendor
for (const m of ['claude', 'codex', 'gemini', 'cursor'] as const) {
  reset();
  const run = await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: m, task: 'What does src/math.ts do?', note: 'test' });
  const s = run.steps[0];
  check(`${m}: single read-only run`, run.status === 'done' && s.status === 'done' && s.access === 'read' && /add/.test(s.output ?? ''), `tools=${s.transcript.filter((t: any) => t.kind === 'tool').length} usage=${JSON.stringify(s.usage)} model=${s.model}`);
  check(`${m}: tool call paired with result`, s.transcript.some((t: any) => t.kind === 'tool' && t.ok === true && t.result));
}

// 5. plan → build → review (cursor builds; codex reviews)
reset(); approvals = 0;
let run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
console.log(runSummary(run));
check('pbr: planner=claude(opus), builder=cursor(write), reviewer=codex', run.steps.map((s: any) => `${s.role}:${s.member}:${s.access}`).join(',') === 'planner:claude:read,builder:cursor:write,reviewer:codex:read' && run.steps[0].model === 'opus');
check('pbr: asked before the edit step', approvals === 1);
check('pbr: builder actually changed files, reviewer saw diff', fs.existsSync(`${DEMO}/src/rateLimit.ts`));
check('pbr: result shows approval', /Approved/.test(run.result ?? ''), runVia(run));

// 6. review → fix round
reset(); approvals = 0; flag('review_changes', true);
run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting', note: 'test' });
check('fix round: reviewer → builder fix → re-review', run.steps.map((s: any) => s.role).join(',') === 'planner,builder,reviewer,builder,reviewer' && /Approved/.test(run.result ?? ''), run.steps.map((s: any) => `${s.role}:${s.member}`).join(' '));
check('fix round: second edit also asked first', approvals === 2);

// 7. usage limit → fallback
reset(); flag('cursor_limit', true);
run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', task: 'fix the typo in README', note: 'test' });
check('limit: cursor limited → codex takes over', run.steps[0].status === 'limited' && run.steps[1]?.member === 'codex' && run.steps[1].status === 'done', run.steps.map((s: any) => `${s.member}:${s.status}`).join(' '));
st = await memberStatuses();
check('limit: cursor marked cooling down', !!by('cursor').limitedUntil);
run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', task: 'fix another typo', note: 'test' });
check('limit: next run skips cursor up front', run.steps[0].member === 'codex', run.steps[0].note);

// 8. claude limit with epoch reset parsed
reset(); flag('claude_limit', true);
run = await runCouncil(ctx(), { pattern: 'single', role: 'planner', task: 'plan it', note: 'test' });
st = await memberStatuses();
check('claude limit → gemini fallback, reset time parsed', run.steps[0].status === 'limited' && run.steps[1]?.member === 'gemini' && Math.abs((by('claude').limitedUntil ?? 0) - (Date.now() + 3600_000)) < 120_000);

// 9. billing guard: codex on API key is refused before running
reset(); flag('codex_api', true);
await memberStatuses(true);
run = await runCouncil(ctx(), { pattern: 'single', role: 'reviewer', member: 'codex', task: 'review', note: 'test' });
check('billing: codex with API key refused (subscription-only)', /API key/.test(run.result ?? ''), (run.result ?? '').slice(0, 90));
run = await runCouncil(ctx(), { pattern: 'single', role: 'reviewer', task: 'review the code', note: 'test' });
check('billing: router skips API-key member', run.steps[0].member !== 'codex', run.steps[0].note);

// 10. claude starts on API billing mid-run → stopped
reset(); flag('claude_api', true); await memberStatuses(true);
st = await memberStatuses();
check('billing: claude auth status api_key → billing api', by('claude').billing === 'api');

// 11. declined edits
reset(); await memberStatuses(true); denyNext = true; approvals = 0;
run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'fix the typo', note: 'test' });
check('decline: edit step skipped, no file changes', run.steps[0].status === 'skipped' && !fs.existsSync(`${DEMO}/src/rateLimit.ts`));
denyNext = false;

// 12. vote with judge
reset();
run = await runCouncil(ctx(), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
check('vote: 3 voters in parallel + judge', run.steps.filter((s: any) => s.role === 'voter').length === 3 && run.steps.at(-1).role === 'judge' && /Recommendation/.test(run.result ?? ''));
const v = run.steps.filter((s: any) => s.role === 'voter');
const overlap = v.every((a: any) => v.every((b: any) => a === b || (a.startedAt < b.endedAt && b.startedAt < a.endedAt)));
check('vote: voters ran concurrently', overlap);

// 13. allowWrite off → builder is read-only, nobody asked
reset(); updateSettings({ council: { ...getSettings().council, allowWrite: false } }); approvals = 0;
run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'fix the typo', note: 'test' });
check('edits off: builder runs read-only, no prompt', run.steps[0].access === 'read' && approvals === 0);
check('edits off: router sends changes to planner', classify('fix the typo in README').role === 'planner');
updateSettings({ council: { ...getSettings().council, allowWrite: true } });

// 14. stop mid-run kills the member
reset();
const ac = new AbortController();
setTimeout(() => ac.abort(), 600);
const t0 = Date.now();
run = await runCouncil(ctx(ac.signal), { pattern: 'single', role: 'researcher', member: 'gemini', task: 'slow', note: 'test' });
check('stop: run cancelled quickly', run.status === 'cancelled' && Date.now() - t0 < 5000, `${Date.now() - t0}ms ${run.steps[0]?.status}`);

// 15. project config is not trusted by default (untrusted repo can't add hooks/MCP servers/instructions)
const last = (m: string) => JSON.parse(fs.readFileSync(path.join(CTL, `${m}.last.json`), 'utf8'));
const hasPair = (argv: string[], a: string, b: string) => argv.some((x, i) => x === a && argv[i + 1] === b);
reset(); process.env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'claude', task: 'What does src/math.ts do?', note: 'test' });
let cl = last('claude').argv as string[];
check('trust off: claude gets --setting-sources user + --strict-mcp-config', hasPair(cl, '--setting-sources', 'user') && cl.includes('--strict-mcp-config') && !cl.includes('--bare'), cl.join(' '));
await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'gemini', task: 'What does src/math.ts do?', note: 'test' });
let gm = last('gemini');
check('trust off: gemini runs without --skip-trust and without the trust env var', !gm.argv.includes('--skip-trust') && gm.trustEnv === null, gm.argv.filter((x: string) => x.startsWith('-')).join(' '));
await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'cursor', task: 'What does src/math.ts do?', note: 'test' });
check('trust off: cursor loads user settings only', JSON.stringify(last('cursor').opts?.local?.settingSources) === '["user"]', JSON.stringify(last('cursor').opts?.local?.settingSources));

reset(); flag('gemini_untrusted', true);
run = await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'gemini', task: 'What does src/math.ts do?', note: 'test' });
const gErr = run.steps[0]?.error ?? '';
check('untrusted folder: gemini refusal becomes an actionable error', run.steps[0]?.member === 'gemini' && run.steps[0].status === 'error' && /doesn't trust this folder/.test(gErr) && /choose Trust/.test(gErr) && /Trust project config/.test(gErr), gErr.slice(0, 120));
check('untrusted folder: not mistaken for sign-in or usage limit', !/not signed in/i.test(gErr) && run.steps[0]?.status !== 'limited');

reset(); updateSettings({ council: { ...getSettings().council, trustProjectConfig: true } }); flag('gemini_untrusted', true);
await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'claude', task: 'What does src/math.ts do?', note: 'test' });
cl = last('claude').argv as string[];
check('trust on: claude loads project settings and MCP config', hasPair(cl, '--setting-sources', 'user,project,local') && !cl.includes('--strict-mcp-config'), cl.join(' '));
run = await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'gemini', task: 'What does src/math.ts do?', note: 'test' });
gm = last('gemini');
check('trust on: gemini gets --skip-trust and runs', gm.argv.includes('--skip-trust') && run.steps[0].status === 'done');
await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'cursor', task: 'What does src/math.ts do?', note: 'test' });
check('trust on: cursor loads user + project settings', JSON.stringify(last('cursor').opts?.local?.settingSources) === '["user","project"]');
updateSettings({ council: { ...getSettings().council, trustProjectConfig: false } }); delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
// 16. secret redaction before anything goes to a cloud member
{
  const { redactSecrets } = await import(`${SRC}/council/redact.ts`);
  const positives: [string, string][] = [
    ['anthropic', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd done'],
    ['openai project', 'sk-proj-AbC123dEf456GhI789jKl012MnO345'],
    ['openai', 'sk-1234567890abcdefghijABCDEFGHIJ'],
    ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['github ghp', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github pat', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'],
    ['slack', 'xoxb-1234567890-abcdefghij'],
    ['aws key id', 'AKIA' + 'IOSFODNN7ABCDEFG'],
    ['aws secret', 'aws_secret_access_key = ' + 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYzzzzzzzzzz'],
    ['stripe', 'sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
    ['pem cut off in a diff', '+-----BEGIN PRIVATE KEY-----\n+MIIEowIBAAKCAQEA'],
    ['bearer', 'Authorization: Bearer abcdef0123456789abcdef'],
    ['url password', 'postgres://admin:s3cretPass@db.local/app'],
    ['API_KEY=', 'API_KEY=abc123def456ghi789'],
    ['PASSWORD=', 'DB_PASSWORD=hunter2hunter2'],
    ['"apiKey": "…"', '"apiKey": "AbC123dEf456GhI789"'],
    ["token: '…'", "token: 'abcd1234efgh5678'"],
  ];
  const missed = positives.filter(([, t]) => redactSecrets(t).count === 0 || /sk-ant-api03|hunter2|s3cretPass|MIIEow/.test(redactSecrets(t).text)).map(([n]) => n);
  check('redact: known secret formats are replaced', missed.length === 0, missed.join(', '));
  const keep = redactSecrets('API_KEY=abc123def456ghi789');
  check('redact: keeps the name, marks the kind', keep.text === 'API_KEY=[REDACTED:api-key]' && keep.kinds[0] === 'api-key', keep.text);
  const url = redactSecrets('postgres://admin:s3cretPass@db.local/app');
  check('redact: URL keeps user and host', url.text === 'postgres://admin:[REDACTED:url-password]@db.local/app', url.text);
  const negatives = [
    'API_KEY=your-key-here', 'API_KEY=${API_KEY}', 'const apiKey = process.env.OPENAI_API_KEY', 'token: "xxx"', 'SECRET=short',
    'const maxTokens = 1234567890123', 'password: "correcthorsebattery"', 'const token = getTokenFromStorage()', 'const secret = config.auth.secretValue',
    'sk-ant-your-key-here', 'postgres://user:${PASS}@host', 'headers: { Authorization: `Bearer ${token}` }', 'the secret is out', 'inputTokens: 1234567890123',
    'const secretName = "projects/123/secrets/abc"', 'risk-assessment-module-version-2', 'https://example.com/a?b=1', 'const API_KEY_ENV = "OPENAI_API_KEY"',
    'export function add(a: number, b: number) {\n  return a + b;\n}',
  ];
  const fps = negatives.filter((t) => redactSecrets(t).count > 0);
  check('redact: ordinary code and placeholders untouched', fps.length === 0, fps.join(' | '));
  const twice = redactSecrets(redactSecrets('ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789').text);
  check('redact: idempotent on already-redacted text', twice.count === 0);

  const KEY = 'sk-ant-api03-ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-QQQQ';
  const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----';
  const task = `Why does login fail? My key is ${KEY} and the deploy key is\n${PEM}`;
  const lastPrompt = (m: string) => { try { return JSON.parse(fs.readFileSync(path.join(CTL, `${m}.last.json`), 'utf8')).prompt as string; } catch { return ''; } };

  reset();
  run = await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'claude', task, note: 'test' });
  let sent = lastPrompt('claude');
  check('redact: cloud member gets the task without the key or PEM', !!sent && !sent.includes(KEY) && !sent.includes('b3BlbnNzaC1rZXkt') && sent.includes('[REDACTED:anthropic-key]') && sent.includes('[REDACTED:private-key]'), sent.slice(0, 120));
  check('redact: step records 2 removals with a note', run.steps[0].redactions === 2 && run.steps[0].transcript.some((t: any) => t.kind === 'note' && /Removed 2 secrets before sending \(anthropic key, private key\)/.test(t.text)), JSON.stringify(run.steps[0].transcript.find((t: any) => t.kind === 'note')));

  // The local model never leaves the machine, so it gets the task as written.
  let localGot = '';
  const prevModel = getSettings().model;
  updateSettings({ model: 'stand-in-local-model' });
  const localCtx = { ...ctx(), delegateLocal: async (_n: string, t: string) => { localGot = t; return 'local report'; } };
  run = await runCouncil(localCtx, { pattern: 'single', role: 'quick', member: 'local', task, note: 'test' });
  updateSettings({ model: prevModel });
  check('redact: local member is not redacted', localGot.includes(KEY) && !run.steps[0]?.redactions, (run.result ?? '').slice(0, 90));

  // Diffs handed to the reviewer are redacted too.
  reset();
  const { gitSnapshot, gitDiffSince } = await import(`${SRC}/council/orchestrator.ts`);
  const snap = gitSnapshot(DEMO);
  fs.writeFileSync(`${DEMO}/README.md`, `# Demo\nSTRIPE_KEY=${'sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc'}\n`);
  const diff = gitDiffSince(DEMO, snap);
  check('redact: git diff for reviewers is redacted', /\[REDACTED:stripe-key\]/.test(diff) && !diff.includes('4eC39HqLyjWDarjtT1zdp7dc'), diff.split('\n').filter((l: string) => l.startsWith('+')).join(' '));

  reset();
  updateSettings({ council: { ...getSettings().council, redactSecrets: false } });
  run = await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'claude', task, note: 'test' });
  sent = lastPrompt('claude');
  check('redact: setting off sends the task as-is', sent.includes(KEY) && sent.includes('b3BlbnNzaC1rZXkt') && !run.steps[0].redactions);
  updateSettings({ council: { ...getSettings().council, redactSecrets: true } });
}

// 17. consult triggers: system prompt + Solo-mode nudges
{
  const { mainSystemPrompt } = await import(`${SRC}/agent/prompts.ts`);
  const { ConsultNudger, consultEnabled, FAILURES_HINT } = await import(`${SRC}/agent/consultNudge.ts`);
  const on = mainSystemPrompt();
  check('consult: prompt lists triggers when council on', /Ask a member when:/.test(on) && /Two attempts to fix the same failure/.test(on) && /migration, auth, deleting data, public API/.test(on) && /different vendor/.test(on) && /not this chat/.test(on) && /plan limits/.test(on));
  updateSettings({ council: { ...getSettings().council, enabled: false } });
  const off = mainSystemPrompt();
  check('consult: no triggers when council off', !/Ask a member when/.test(off) && !/ask_member/.test(off));
  updateSettings({ council: { ...getSettings().council, enabled: true } });

  check('consult: enabled only with council + ask_member + setting', consultEnabled({ councilAvailable: true, toolNames: ['ask_member'], setting: true })
    && !consultEnabled({ councilAvailable: false, toolNames: ['ask_member'], setting: true })
    && !consultEnabled({ councilAvailable: true, toolNames: ['council'], setting: true })
    && !consultEnabled({ councilAvailable: true, toolNames: ['ask_member'], setting: false }));
  check('consult: setting defaults to on', getSettings().council.consultNudges === true);

  const sh = (command: string, ok: boolean) => ({ name: 'shell_run', args: JSON.stringify({ command }), ok });
  const edit = { name: 'edit_file', args: '{}', ok: true };
  let n = new ConsultNudger(true);
  check('consult: first failure does not nudge', n.observe([sh('npm test', false)]) === null);
  check('consult: same failure without edits does not nudge', n.observe([sh('npm  test', false)]) === null);
  n.observe([edit]);
  const hint = n.observe([sh('npm test', false)]);
  check('consult: same command fails after an edit → nudge', !!hint && /ask_member/.test(hint) && /npm test/.test(hint), hint ?? '');
  n.observe([edit]);
  check('consult: repeat nudge fires once per run', n.observe([sh('npm test', false)]) === null);
  check('consult: failures hint once per run', n.failuresHint().includes(FAILURES_HINT) && n.failuresHint() === '');

  n = new ConsultNudger(true);
  n.observe([sh('npm test', false)]); n.observe([edit]); n.observe([sh('npm test', true)]); n.observe([edit]);
  check('consult: a pass in between resets tracking', n.observe([sh('npm test', false)]) === null);

  n = new ConsultNudger(false);
  n.observe([sh('npm test', false), edit]);
  check('consult: disabled → never nudges', n.observe([sh('npm test', false)]) === null && n.failuresHint() === '');

  n = new ConsultNudger(true);
  n.observe([sh('npm test', false), edit, { name: 'ask_member', args: '{}', ok: true }]);
  check('consult: no nudge after the model already asked', n.observe([sh('npm test', false)]) === null && n.failuresHint() === '');
}

// 18. member scorecard: persistent per-member stats
{
  const statsPath = path.join(process.env.LOCALDEX_HOME!, 'council-stats.json');
  const readStats = () => JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  check('stats: file written by earlier runs', fs.existsSync(statsPath) && Object.keys(readStats().members).length > 0);
  resetStats();
  check('stats: reset leaves an empty file', Object.keys(readStats().members).length === 0);
  let statEvents = 0;
  const off = bus.subscribe((ev: any) => { if (ev.type === 'council_stats') statEvents++; });

  reset(); await memberStatuses(true);
  await runCouncil(ctx(), { pattern: 'single', role: 'researcher', member: 'claude', task: 'What does src/math.ts do?', note: 'test' });
  reset(); flag('review_changes', true);
  await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting', note: 'test' });
  reset(); flag('cursor_limit', true);
  await runCouncil(ctx(), { pattern: 'single', role: 'builder', task: 'fix the typo in README', note: 'test' });
  off();

  const m = readStats().members;
  const sum = (x: any) => `${x?.runs}/${x?.done}/${x?.errors}/${x?.limited}`;
  check('stats: claude = researcher + planner, both done', m.claude?.runs === 2 && m.claude.done === 2 && m.claude.byRole.researcher?.done === 1 && m.claude.byRole.planner?.done === 1, sum(m.claude));
  check('stats: cursor = build + fix + limit hit', m.cursor?.runs === 3 && m.cursor.done === 2 && m.cursor.limited === 1 && m.cursor.byRole.builder?.runs === 3, sum(m.cursor));
  check('stats: cursor build approved after fixes', m.cursor?.builder.approvedAfterFixes === 1 && m.cursor.builder.approvedFirst === 0 && m.cursor.builder.changesRequested === 0, JSON.stringify(m.cursor?.builder));
  check('stats: codex reviewed (1 changes, 1 approve) + took over the limited build', m.codex?.reviewer.changes === 1 && m.codex.reviewer.approve === 1 && m.codex.byRole.builder?.done === 1 && m.codex.runs === 3, `${sum(m.codex)} ${JSON.stringify(m.codex?.reviewer)}`);
  check('stats: durations and tokens add up', m.claude.durationMs > 0 && m.codex.durationMs > 0 && Object.values(m).some((x: any) => x.inputTokens > 0 && x.outputTokens > 0));
  check('stats: no gemini/local entries', !m.gemini && !m.local);
  check('stats: council_stats broadcast as runs progress', statEvents >= 7, `${statEvents} events`);

  resetStats();
  check('stats: reset clears every member', Object.keys(readStats().members).length === 0);
}
// 19. risk-aware routing
const { assessRisk } = await import(`${SRC}/council/router.ts`);
const riskTable: [string, string, string[]?][] = [
  ['fix the password reset check in auth.ts', 'high', ['auth']],
  ['add a database migration for the orders table', 'high', ['migration']],
  ['wire Stripe checkout into the billing page', 'high', ['payments']],
  ['rotate the API keys and encrypt secrets at rest', 'high', ['secrets']],
  ['delete all user records older than a year', 'high', ['data deletion']],
  ['run DROP TABLE sessions', 'high'],
  ['update the GitHub Actions deploy workflow for production', 'high', ['deploy/infra']],
  ['fix the XSS vulnerability in comments', 'high', ['security fix']],
  ['upgrade react to v19', 'high', ['major upgrade']],
  ['force push the rebased branch', 'high', ['history rewrite']],
  ['fix the typo in README', 'low', ['docs', 'typo']],
  ['rename the helpers in tests', 'low', ['test rename']],
  ['reformat src/math.ts with prettier', 'low', ['formatting']],
  ['add a button to the toolbar', 'normal', []],
  ['add rate limiting to the API with tests', 'normal', []],
  ['explain how the author list renders', 'normal', []],
];
const riskMiss = riskTable.filter(([t, want, reasons]) => {
  const a = assessRisk(t);
  return a.risk !== want || (reasons && !reasons.every((x) => a.reasons.includes(x)));
});
check(`risk: assessRisk table (${riskTable.length} cases)`, riskMiss.length === 0, riskMiss.map(([t]) => `${t} → ${JSON.stringify(assessRisk(t))}`).join(' | '));
const hi = classify('fix the password reset check in auth.ts');
check('risk: small high-risk change upgraded to pbr', hi.pattern === 'plan_build_review' && hi.role === 'builder' && hi.risk === 'high' && /high risk/.test(hi.note), hi.note);
const lo = classify('fix the typo in README');
check('risk: low/normal keep their route', lo.pattern === 'single' && lo.risk === 'low' && classify('add a button to the toolbar').pattern === 'single' && classify('add a button to the toolbar').risk === 'normal');
const askHi = parseCommand('/ask codex fix the password reset check in auth.ts')!;
check('risk: slash command keeps its pattern', askHi.pattern === 'single' && askHi.member === 'codex');
updateSettings({ council: { ...getSettings().council, riskRouting: false } });
check('risk: switch off → no upgrade, still rated', classify('fix the password reset check in auth.ts').pattern === 'single' && classify('fix the password reset check in auth.ts').risk === 'high');
updateSettings({ council: { ...getSettings().council, riskRouting: true } });

// High-risk small request end to end, with confirmWrites off and fix rounds at 0.
reset(); approvals = 0;
const prevCouncil = getSettings().council;
updateSettings({ council: { ...prevCouncil, confirmWrites: false, maxFixRounds: 0, members: { ...prevCouncil.members, cursor: { ...prevCouncil.members.cursor, heavyModel: 'composer-heavy' } } } });
flag('review_changes', true);
run = await runCouncil(ctx(), classify('fix the password reset check in auth.ts'));
console.log(runSummary(run));
check('risk run: plan → build → review → fix → review', run.steps.map((s: any) => s.role).join(',') === 'planner,builder,reviewer,builder,reviewer', run.steps.map((s: any) => `${s.role}:${s.member}`).join(' '));
const builds = run.steps.filter((s: any) => s.role === 'builder');
const cursorLog = fs.readFileSync(path.join(CTL, 'cursor.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('risk run: builder on the heavy model', builds.every((s: any) => s.model === 'composer-heavy') && cursorLog.every((x: any) => (x.opts?.model?.id ?? x.opts?.model) === 'composer-heavy'), `${builds.map((s: any) => s.model).join(',')} sdk=${JSON.stringify(cursorLog.map((x: any) => x.opts?.model))}`);
check('risk run: approval asked for each edit even with confirmWrites off', approvals === 2 && builds[0].transcript.some((t: any) => t.kind === 'note' && /High-risk/.test(t.text ?? '')));
check('risk run: risk persisted on the run', run.risk === 'high' && run.riskReasons?.includes('auth') && /risk: high/.test(runSummary(run)));
check('risk run: planner/reviewer still heavy, planner unchanged', run.steps[0].model === 'opus');

// Normal-risk run with confirmWrites off: no prompt, default builder model.
reset(); approvals = 0;
run = await runCouncil(ctx(), classify('add a button to the toolbar'));
// (With domain roles this UI task goes to the frontend builder.)
check('normal run: unchanged (single builder, no prompt, default model)', run.pattern === 'single' && run.risk === 'normal' && approvals === 0 && run.steps[0].role === 'frontend' && !/heavy model/.test(run.steps[0].note ?? ''), `${run.pattern} ${approvals} ${run.steps[0]?.role} ${run.steps[0]?.model}`);
updateSettings({ council: prevCouncil });
// 20. health check: deep refresh adds a checklist and each member's models
reset();
const t15 = Date.now();
st = await memberStatuses(true, true);
const ck = (id: string, name: string) => by(id).checks?.find((c: any) => c.name === name);
check('health: checklist for all four members', st.length === 4 && st.every((s: any) => ['Signed in', 'Subscription billing', 'Models listed', 'Not cooling down'].every((n) => s.checks?.some((c: any) => c.name === n && c.ok))), st.map((s: any) => `${s.id}:${(s.checks ?? []).filter((c: any) => !c.ok).map((c: any) => c.name).join('/') || 'ok'}`).join(' '));
check('health: run time recorded', st.every((s: any) => (s.healthCheckedAt ?? 0) >= t15));
check('health: cursor models come from the SDK for your account', by('cursor').modelsSource === 'account' && JSON.stringify(by('cursor').models) === '["composer-fake-2","gpt-fake-6"]', JSON.stringify(by('cursor').models));
const codexModelsArgv = JSON.parse(fs.readFileSync(path.join(CTL, 'codex-models.last.json'), 'utf8')).argv;
check('health: codex models from `codex debug models`, hidden ones dropped', by('codex').modelsSource === 'account' && by('codex').models?.includes('gpt-fake-6-sol') && !by('codex').models?.includes('codex-internal') && !codexModelsArgv.includes('--bundled'), JSON.stringify(by('codex').models));
check('health: claude falls back to suggested aliases', by('claude').modelsSource === 'suggested' && ['opus', 'sonnet', 'haiku'].every((m) => by('claude').models?.includes(m)), JSON.stringify(by('claude').models));
check('health: gemini suggests its aliases', by('gemini').modelsSource === 'suggested' && by('gemini').models?.includes('flash'));
reset(); flag('claude_signed_out', true); flag('cursor_signed_out', true); flag('codex_signed_out', true);
st = await memberStatuses(true, true);
check('health: signed-out claude fails "Signed in" with the login command', ck('claude', 'Signed in')?.ok === false && /claude auth login/.test(ck('claude', 'Signed in')?.detail ?? '') && ck('claude', 'Subscription billing')?.ok === false);
check('health: signed-out cursor only gets suggestions', ck('cursor', 'Signed in')?.ok === false && by('cursor').modelsSource === 'suggested');
check('health: signed-out codex reads the bundled catalog (no account call)', by('codex').modelsSource === 'suggested' && by('codex').models?.includes('gpt-bundled-1'));
reset(); markLimited('gemini', 'Quota exceeded. Try again in 30 minutes.');
st = await memberStatuses();
check('health: cooling-down member fails "Not cooling down"', ck('gemini', 'Not cooling down')?.ok === false && ck('claude', 'Not cooling down')?.ok === true);
reset(); await memberStatuses(true);
// 21. domain roles: frontend / backend builders and vision
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check('roles: old config (5 roles) loads with new role defaults', same(getSettings().council.roles.frontend, ['gemini', 'cursor', 'claude']) && same(getSettings().council.roles.backend, ['codex', 'claude', 'cursor']) && same(getSettings().council.roles.vision, ['gemini', 'claude']));
const merged = mergeCouncil(DEFAULT_COUNCIL, { roles: { planner: ['gemini'] } } as any);
check('roles: mergeCouncil keeps custom roles and fills new ones', same(merged.roles.planner, ['gemini']) && same(merged.roles.vision, ['gemini', 'claude']) && same(merged.roles.builder, DEFAULT_COUNCIL.roles.builder));
check('router: CSS/button → frontend', r('make the submit button blue in the CSS') === 'single/frontend');
check('router: Tailwind layout → frontend', r('fix the responsive layout of the settings page with Tailwind') === 'single/frontend');
check('router: endpoint → backend', r('add a /health endpoint') === 'single/backend');
check('router: SQL → backend', r('fix the SQL in the orders query') === 'single/backend');
check('router: mixed UI + API → builder', r('add a button that calls the new API endpoint') === 'single/builder');
check('router: screenshot path → vision', r('what is wrong in screenshots/login.png?') === 'single/vision');
check('router: screenshot word → vision', r('the screenshot I saved shows a broken header, why?') === 'single/vision');
const refs = findImageRefs('compare docs/mockup.png with ~/Desktop/x.webp and "shots/b.JPG", not notes.md');
check('router: image refs found', same(refs, ['docs/mockup.png', '~/Desktop/x.webp', 'shots/b.JPG']), JSON.stringify(refs));
check('router: /frontend /backend /vision', r('/frontend tidy the header') === 'single/frontend' && r('/backend tidy the server') === 'single/backend' && r('/vision look at a.png') === 'single/vision');
check('router: /build on backend work → backend builder', r('/build add pagination to the users endpoint') === 'plan_build_review/backend');

reset(); approvals = 0;
run = await runCouncil(ctx(), parseCommand('/frontend make the submit button blue')!);
let gem = JSON.parse(fs.readFileSync(path.join(CTL, 'gemini.last.json'), 'utf8'));
check('/frontend: runs on gemini with write access, approval asked', run.steps.length === 1 && run.steps[0].role === 'frontend' && run.steps[0].member === 'gemini' && run.steps[0].access === 'write' && approvals === 1 && gem.argv.includes('auto_edit') && /BUILDER for frontend/.test(gem.prompt), runSummary(run));

reset(); approvals = 0;
run = await runCouncil(ctx(), classify('add rate limiting middleware to the API server with tests'));
console.log(runSummary(run));
check('pbr backend: planner=claude, backend=codex(write), reviewer≠codex', run.pattern === 'plan_build_review' && run.steps.map((s: any) => `${s.role}:${s.member}:${s.access}`).join(',') === 'planner:claude:read,backend:codex:write,reviewer:gemini:read' && approvals === 1);
check('pbr backend: codex made the change', fs.existsSync(`${DEMO}/src/rateLimit.ts`) && /BUILDER for backend/.test(JSON.parse(fs.readFileSync(path.join(CTL, 'codex.last.json'), 'utf8')).prompt));

reset(); approvals = 0;
run = await runCouncil(ctx(), classify('what is wrong in screenshots/login.png?'));
gem = JSON.parse(fs.readFileSync(path.join(CTL, 'gemini.last.json'), 'utf8'));
check('vision: gemini, read-only, no approval, image path in prompt', run.steps[0]?.role === 'vision' && run.steps[0].member === 'gemini' && run.steps[0].access === 'read' && approvals === 0 && gem.argv.includes('plan') && /- screenshots\/login\.png/.test(gem.prompt) && /Open each image with your own tools/.test(gem.prompt) && /submit button/.test(run.result ?? ''));

updateSettings({ council: { ...getSettings().council, allowWrite: false } }); approvals = 0; reset();
run = await runCouncil(ctx(), { pattern: 'single', role: 'backend', member: 'codex', task: 'fix the typo', note: 'test' });
check('edits off: backend builder is read-only too', run.steps[0].access === 'read' && approvals === 0);
updateSettings({ council: { ...getSettings().council, allowWrite: true } });

// 22. blind peer review in votes (llm-council stage 2)
{
  const { parseRanking, aggregateRanking, anonymize } = await import(`${SRC}/council/peer.ts`);
  const pr = (t: string, n = 3) => JSON.stringify(parseRanking(t, n));
  const parseCases: [string, string, number?][] = [
    ['Looks good.\nRANKING: B > A > C', '["B","A","C"]'],
    ['ranking: c>a>b', '["C","A","B"]'],
    ['**RANKING:** Response B > Response C > Response A', '["B","C","A"]'],
    ['Final ranking - b , a ,c', '["B","A","C"]'],
    ['RANKING:\nC, B, A', '["C","B","A"]'],
    ['RANKING: B > A', '["B","A"]'],
    ['RANKING: B > B > Z > A > C', '["B","A","C"]'],
    ['RANKING: D > A > B > C', '["D","A","B","C"]', 4],
    ['RANKING: D > A > B', '["A","B"]'],
    ['RANKING: A > B > C\nchanged my mind\nRANKING: C > B > A', '["C","B","A"]'],
    ['RANKING: I think A wins', '["A"]'],
    ['RANKING: none of them', 'null'],
    ['I like B best, then A.', 'null'],
    ['', 'null'],
  ];
  const parseMiss = parseCases.filter(([t, want, n]) => pr(t, n) !== want);
  check(`peer: ranking parser on messy input (${parseCases.length} cases)`, parseMiss.length === 0, parseMiss.map(([t, w, n]) => `${JSON.stringify(t)} → ${pr(t, n)} (want ${w})`).join(' | '));

  const agg = aggregateRanking(['claude', 'codex', 'gemini'], [
    { reviewer: 'claude', order: ['codex', 'claude', 'gemini'] },
    { reviewer: 'codex', order: ['codex', 'gemini', 'claude'] },
    { reviewer: 'gemini', order: ['gemini', 'codex'] },
  ]);
  check('peer: Borda aggregate with partial ballot and self ranks', JSON.stringify(agg) === JSON.stringify([
    { member: 'codex', avgRank: 1.33, votes: 3, selfRank: 1 },
    { member: 'gemini', avgRank: 2, votes: 3, selfRank: 1 },
    { member: 'claude', avgRank: 2.5, votes: 2, selfRank: 2 },
  ]), JSON.stringify(agg));
  const anon = anonymize('Use zod. (claude)\n\nBottom line: zod.\n— Codex\nAs Gemini, I prefer it. [Cursor] The Claude API is fine.');
  check('peer: anonymize strips signatures, keeps vendor mentions', !/\(claude\)|Codex|As Gemini|\[Cursor\]/.test(anon) && /The Claude API is fine/.test(anon) && /I prefer it/.test(anon), JSON.stringify(anon));

  const statsPath = path.join(process.env.LOCALDEX_HOME!, 'council-stats.json');
  const readLog = (m: string) => fs.readFileSync(path.join(CTL, `${m}.log.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  resetStats(); reset();
  run = await runCouncil(ctx(), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
  console.log(runSummary(run));
  const peers = run.steps.filter((s: any) => s.role === 'peer');
  check('peer: voters → 3 peer reviews → judge', run.steps.map((s: any) => s.role).join(',') === 'voter,voter,voter,peer,peer,peer,judge' && peers.every((s: any) => s.status === 'done' && s.access === 'read' && /peer review/.test(s.note ?? '')), run.steps.map((s: any) => `${s.role}:${s.member}:${s.status}`).join(' '));
  check('peer: reviews ran concurrently', peers.every((a: any) => peers.every((b: any) => a === b || (a.startedAt < b.endedAt && b.startedAt < a.endedAt))));
  const gemPeer = readLog('gemini').find((x: any) => /PEER REVIEWER/.test(x.prompt))?.prompt ?? '';
  check('peer: prompt is anonymized (letters, no names or signatures)', /--- Response A ---/.test(gemPeer) && /--- Response C ---/.test(gemPeer) && !/\((claude|codex|gemini)\)|— (claude|codex)|Adviser \d/i.test(gemPeer) && /RANKING:/.test(gemPeer), gemPeer.slice(0, 200));
  const pk = run.peerRanking ?? [];
  check('peer: rankings parsed (codex messy format too) and aggregated', pk.length === 3 && pk.every((r: any) => r.votes === 3) && pk[2].member === 'gemini' && pk[2].avgRank === 3 && pk[2].selfRank === 3 && Math.abs(pk[0].avgRank + pk[1].avgRank - 3) < 0.02, JSON.stringify(pk));
  const judgeGot = readLog('claude').find((x: any) => /Compare the answers/.test(x.prompt))?.prompt ?? '';
  check('peer: judge prompt includes the ranking with names', /Advisers ranked the answers blind/.test(judgeGot) && /3rd Gemini, avg rank 3\.0 \(3 votes\)/.test(judgeGot), judgeGot.split('\n').find((l: string) => /ranked/.test(l)) ?? '');
  check('peer: result shows a peer ranking line under the verdict', /### Council verdict[\s\S]*Peer ranking \(blind\): 1\. (Claude|Codex) \(avg 1\.\d\) · 2\. (Claude|Codex) \(avg 1\.\d\) · 3\. Gemini \(avg 3\.0\)/.test(run.result ?? ''), (run.result ?? '').split('\n').find((l: string) => /Peer ranking/.test(l)) ?? '');
  const sm = JSON.parse(fs.readFileSync(statsPath, 'utf8')).members;
  check('peer: scorecard recordPeerRanking updated', sm.gemini?.peerRanking.count === 1 && sm.gemini.peerRanking.rankSum === 3 && sm.gemini.peerRanking.ofSum === 3 && sm.claude?.peerRanking.count === 1 && sm.codex?.peerRanking.count === 1 && sm.claude.peerRanking.rankSum + sm.codex.peerRanking.rankSum === 3 && sm.codex.byRole.peer?.done === 1, JSON.stringify({ c: sm.claude?.peerRanking, x: sm.codex?.peerRanking, g: sm.gemini?.peerRanking }));

  reset(); flag('peer_garbage', true);
  run = await runCouncil(ctx(), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
  check('peer: no usable rankings → no aggregate, judge still runs', !run.peerRanking && run.steps.filter((s: any) => s.role === 'peer').length === 3 && run.steps.at(-1).role === 'judge' && !/Peer ranking/.test(run.result ?? '') && run.steps.some((s: any) => s.role === 'peer' && s.transcript.some((t: any) => /No usable RANKING/.test(t.text ?? ''))));

  reset(); updateSettings({ council: { ...getSettings().council, peerReview: false } });
  run = await runCouncil(ctx(), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
  const judgeOff = readLog('claude').find((x: any) => /Compare the answers/.test(x.prompt))?.prompt ?? '';
  check('peer: setting off → no peer steps, no ranking', !run.steps.some((s: any) => s.role === 'peer') && !run.peerRanking && run.steps.at(-1).role === 'judge' && !/ranked/.test(judgeOff));
  updateSettings({ council: { ...getSettings().council, peerReview: true } });
  check('peer: setting defaults to on', DEFAULT_COUNCIL.peerReview === true);
  resetStats();
}

console.log(`\n${pass} passed, ${fail} failed. events: ${JSON.stringify(events)}`);
reset();
process.exit(fail ? 1 : 0);
