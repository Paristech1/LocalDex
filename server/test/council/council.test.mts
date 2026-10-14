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
// The QA step (section 22) changes plan → build → review step sequences; older sections check the flow without it.
// (The demo project has no package.json, so the checks gate finds nothing to run there.)
updateSettings({ council: { ...getSettings().council, qaStep: false } });
// Builder worktrees (section 26) move edits into a separate copy; older sections check edits land in DEMO directly.
updateSettings({ council: { ...getSettings().council, builderWorktree: false } });

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

// 22. written handoff when a member hits its usage limit mid-run
{
  const codexPrompt = () => JSON.parse(fs.readFileSync(path.join(CTL, 'codex.last.json'), 'utf8')).prompt as string;
  reset(); approvals = 0; flag('cursor_limit_midway', true);
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  const [c1, c2] = run.steps;
  let p = codexPrompt();
  check('handoff: cursor limited mid-edit → codex continues', c1?.status === 'limited' && c2?.member === 'codex' && c2.status === 'done', run.steps.map((s: any) => `${s.member}:${s.status}`).join(' '));
  check('handoff: codex prompt has the delimited handoff + continue instruction before the task', /===== Handoff from Cursor \(begin\) =====/.test(p) && /===== Handoff from Cursor \(end\) =====/.test(p) && /Continue from where they stopped/.test(p) && p.indexOf('Handoff from Cursor') < p.lastIndexOf('Add rate limiting to the API'));
  check('handoff: includes changed file (git status), tool calls and limit message', /\?\? src\/rateLimit\.ts/.test(p) && /- read src\/math\.ts → ok/.test(p) && /- edit src\/rateLimit\.ts → ok/.test(p) && /Rate limit exceeded/.test(p) && /Next: wire it into src\/server\.ts/.test(p), `${p.length} chars`);
  check('handoff: recorded on the step with a note', c2?.handoff?.from === 'cursor' && /Handoff|src\/rateLimit\.ts/.test(c2.handoff.text) && /continued from Cursor after its usage limit/.test(c2.note ?? ''), c2?.note);
  check('handoff: codex still asked before editing', approvals === 2 && c2?.access === 'write', `${approvals} approvals`);

  // Read-only next member: gets the handoff, stays read-only.
  updateSettings({ council: { ...getSettings().council, allowWrite: false } });
  reset(); approvals = 0; flag('cursor_limit_midway', true);
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  p = codexPrompt();
  check('handoff: read-only member gets the handoff but stays read-only', run.steps[1]?.member === 'codex' && run.steps[1].access === 'read' && approvals === 0 && /Handoff from Cursor/.test(p) && /You are read-only/.test(p) && !!run.steps[1].handoff, runSummary(run));
  updateSettings({ council: { ...getSettings().council, allowWrite: true } });

  // Limit before any work: plain retry, no handoff block.
  reset(); approvals = 0; flag('cursor_limit', true);
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  p = codexPrompt();
  check('handoff: no partial work → no handoff block', run.steps[0]?.status === 'limited' && run.steps[0].transcript.every((t: any) => t.kind !== 'tool') && run.steps[1]?.member === 'codex' && !/Handoff from/.test(p) && !run.steps[1].handoff && /retry after Cursor failed/.test(run.steps[1].note ?? ''), run.steps[1]?.note);
}

// ---------- vote quorum + grace timer ----------
{
  const prev = getSettings().council;
  updateSettings({ council: { ...prev, voteMembers: ['claude', 'codex', 'gemini'], judge: 'claude', voteQuorum: 2, voteGraceSeconds: 1 } });

  // One slow adviser: dropped after the grace period, the others' answers are judged.
  reset(); flag('gemini_slow', true);
  const t0 = Date.now();
  run = await runCouncil(ctx(), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
  const took = Date.now() - t0;
  const voters = run.steps.filter((s: any) => s.role === 'voter');
  const g = voters.find((s: any) => s.member === 'gemini');
  const answered = voters.filter((s: any) => s.status === 'done').map((s: any) => s.member).sort().join(',');
  const judgeStep = run.steps.find((s: any) => s.role === 'judge');
  const judgeIn = JSON.parse(fs.readFileSync(path.join(CTL, 'claude.last.json'), 'utf8')).prompt as string;
  console.log(runSummary(run));
  check('quorum: claude + codex answers used', answered === 'claude,codex', answered);
  check('quorum: gemini cancelled with the grace note', g?.status === 'cancelled' && g?.error === 'Dropped after the grace period (quorum reached)', `${g?.status} ${g?.error}`);
  check('quorum: run finished well under 15s', took < 10_000 && run.status === 'done', `${took}ms`);
  check('quorum: judge ran with 2 answers', judgeStep?.status === 'done' && /Adviser 2/.test(judgeIn) && !/Adviser 3/.test(judgeIn) && !/tree-shakeable/.test(judgeIn));
  const pid = Number(fs.readFileSync(path.join(CTL, 'gemini.pid'), 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  check('quorum: dropped gemini process was killed', pid > 0 && !alive, `pid ${pid}`);
  check('quorum: run records 1 dropped, summary shows it', run.quorum?.needed === 2 && run.quorum?.of === 3 && run.quorum?.dropped === 1 && /Quorum 2\/3 · 1 dropped after 1s/.test(runSummary(run)));

  // All fast: nothing dropped, all three answers judged.
  reset();
  run = await runCouncil(ctx(), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
  const fastJudge = JSON.parse(fs.readFileSync(path.join(CTL, 'claude.last.json'), 'utf8')).prompt as string;
  check('quorum: no drop when all advisers are fast', run.steps.filter((s: any) => s.role === 'voter' && s.status === 'done').length === 3 && run.quorum?.dropped === 0 && /Adviser 3/.test(fastJudge) && /Quorum 2\/3$/m.test(runSummary(run).split('\n')[0]));

  // Fewer than quorum succeed (gemini limited, quorum 3): everyone is awaited, nothing dropped.
  reset(); flag('gemini_limit', true);
  updateSettings({ council: { ...getSettings().council, voteQuorum: 3 } });
  run = await runCouncil(ctx(), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
  check('quorum: not reached → no drops, others still answer', run.quorum?.dropped === 0 && run.steps.filter((s: any) => s.role === 'voter' && s.status === 'done').length === 2);

  // User Stop still cancels every voter.
  reset(); flag('gemini_slow', true);
  updateSettings({ council: { ...getSettings().council, voteQuorum: 2, voteGraceSeconds: 600 } });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 800);
  run = await runCouncil(ctx(stop.signal), { pattern: 'vote', role: 'researcher', task: 'zod or valibot?', note: 'test' });
  check('quorum: Stop cancels the whole vote', run.status === 'cancelled' && run.steps.every((s: any) => s.status === 'cancelled' || s.status === 'done') && !run.steps.some((s: any) => s.role === 'judge'), run.steps.map((s: any) => `${s.member}:${s.status}`).join(' '));

  updateSettings({ council: prev });
}

// 23. blind peer review in votes (llm-council stage 2)
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

// 24. checks gate + QA step + strict verdicts in plan → build → review
{
  const { detectCheckCommand } = await import(`${SRC}/council/checks.ts`);
  const tmp = fs.mkdtempSync(path.join(path.dirname(DEMO), 'detect-'));
  const dir = (name: string, files: Record<string, string>) => { const d = path.join(tmp, name); fs.mkdirSync(d); for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body); return d; };
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });
  check('checks detect: typecheck, lint, test in that order', detectCheckCommand(dir('a', { 'package.json': pkg({ test: 'vitest', build: 'vite build', lint: 'eslint .', typecheck: 'tsc' }) })) === 'npm run typecheck && npm run lint && npm run test');
  check('checks detect: npm default test script skipped', detectCheckCommand(dir('b', { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) })) === '');
  check('checks detect: pnpm lockfile → pnpm', detectCheckCommand(dir('c', { 'package.json': pkg({ test: 'vitest' }), 'pnpm-lock.yaml': '' })) === 'pnpm run test');
  check('checks detect: pytest, cargo, go', detectCheckCommand(dir('d', { 'pyproject.toml': '' })) === 'pytest -q' && detectCheckCommand(dir('e', { 'Cargo.toml': '' })) === 'cargo test' && detectCheckCommand(dir('f', { 'go.mod': '' })) === 'go test ./...');
  check('checks detect: nothing found → empty', detectCheckCommand(dir('g', { 'README.md': '' })) === '');
  fs.rmSync(tmp, { recursive: true, force: true });

  const base = getSettings().council;
  updateSettings({ council: { ...base, qaStep: true, checksGate: true, checkCommand: '', maxFixRounds: 1 } });
  // Untracked, so reset() removes them again. The test passes only once the builder has created src/rateLimit.ts;
  // a `.fail_once` marker makes it fail exactly once.
  const setupProject = () => {
    fs.writeFileSync(`${DEMO}/package.json`, JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node check.cjs' } }));
    fs.writeFileSync(`${DEMO}/check.cjs`, "const fs = require('fs');\nif (fs.existsSync('.fail_once')) { fs.rmSync('.fail_once'); console.error('FAIL rateLimit: expected 429 after 60 requests, got 200'); process.exit(1); }\nif (!fs.existsSync('src/rateLimit.ts')) { console.error('missing src/rateLimit.ts'); process.exit(1); }\nconsole.log('ok 3 tests passed');\n");
  };
  const roles = (x: any) => x.steps.map((s: any) => s.role).join(',');
  const prompts = (m: string) => { try { return fs.readFileSync(path.join(CTL, `${m}.log.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l).prompt as string); } catch { return [] as string[]; } };
  let approvalCmds: string[] = [];
  const offA = bus.subscribe((ev: any) => { if (ev.type === 'approval_request') approvalCmds.push(ev.command); });

  // Happy path: checks pass → reviewer approves → QA passes.
  reset(); setupProject(); approvals = 0; approvalCmds = [];
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  console.log(runSummary(run));
  const chk = run.steps.find((s: any) => s.role === 'checks');
  check('gates: plan → build → checks → review → QA', roles(run) === 'planner,builder,checks,reviewer,qa', roles(run));
  check('gates: checks step is local, read, done with output', chk?.member === 'local' && chk.access === 'read' && chk.status === 'done' && /ok 3 tests passed/.test(chk.output ?? '') && /npm run test/.test(chk.note ?? ''), JSON.stringify({ s: chk?.status, n: chk?.note, o: chk?.output?.slice(-60) }));
  check('gates: checks asked for approval with the exact command and folder', approvals === 2 && approvalCmds.some((c) => /\$ npm run test$/.test(c)));
  check('gates: reviewer told the checks passed', /Checks passed: npm run test/.test(prompts('codex').at(-1) ?? ''));
  const qa = run.steps.find((s: any) => s.role === 'qa');
  check('gates: QA on gemini (not the builder or reviewer), read-only', qa?.member === 'gemini' && qa.access === 'read' && /try to break this change/i.test(prompts('gemini').at(-1) ?? ''), `${qa?.member}`);
  check('gates: header lists every gate', (run.result ?? '').startsWith('**✅ Checks passed · Approved by Codex · QA passed by Gemini**'), (run.result ?? '').split('\n')[0]);

  // A failing check goes straight to a fix round; the reviewer only sees the fixed work.
  reset(); setupProject(); fs.writeFileSync(`${DEMO}/.fail_once`, '1'); approvals = 0;
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  const fix = run.steps.filter((s: any) => s.role === 'builder')[1];
  check('checks fail: fix round without reviewer, then checks → review → QA', roles(run) === 'planner,builder,checks,builder,checks,reviewer,qa' && run.steps[2].status === 'error', roles(run));
  check('checks fail: builder gets the check output', /checks failed/.test(fix?.note ?? '') && /expected 429 after 60 requests/.test(prompts('cursor').at(-1) ?? ''), fix?.note);
  check('checks fail: ends approved', /^\*\*✅ Checks passed · Approved by Codex/.test(run.result ?? ''));

  // Out of fix rounds with checks still failing: no reviewer at all.
  reset(); setupProject(); updateSettings({ council: { ...getSettings().council, maxFixRounds: 0 } }); fs.writeFileSync(`${DEMO}/.fail_once`, '1');
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  check('checks fail, no rounds left: not reviewed', roles(run) === 'planner,builder,checks' && /^\*\*⚠️ Checks failed · Not reviewed \(checks failed\)/.test(run.result ?? ''), (run.result ?? '').split('\n')[0]);
  updateSettings({ council: { ...getSettings().council, maxFixRounds: 1 } });

  // QA FAIL → fix round → checks → review → QA again.
  reset(); setupProject(); flag('qa_fail_once', true);
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  check('QA fail: fix round, then the full gate again', roles(run) === 'planner,builder,checks,reviewer,qa,builder,checks,reviewer,qa', roles(run));
  check('QA fail: builder gets the repro', /\(QA\)/.test(run.steps[5]?.note ?? '') && /rateLimit\(0\)/.test(prompts('cursor').at(-1) ?? ''));
  check('QA fail: final header passes', /^\*\*✅ Checks passed · Approved by Codex · QA passed by Gemini/.test(run.result ?? ''), (run.result ?? '').split('\n')[0]);

  // No fix rounds left after a QA fail → header says so.
  reset(); setupProject(); flag('qa_fail_once', true); updateSettings({ council: { ...getSettings().council, maxFixRounds: 0 } });
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  check('QA fail, no rounds left: header shows QA failed', /^\*\*⚠️ Checks passed · Approved by Codex · QA failed by Gemini\*\*/.test(run.result ?? ''), (run.result ?? '').split('\n')[0]);

  // Reviewer without a verdict: asked once to restate, then counts as changes requested.
  reset(); setupProject(); flag('review_no_verdict', true);
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  const restates = prompts('codex').filter((p) => /had no verdict line/.test(p));
  check('no verdict: one restate request, then a rejection (no QA)', roles(run) === 'planner,builder,checks,reviewer,reviewer' && restates.length === 1 && /no verdict given/.test(run.steps[4].note ?? ''), roles(run));
  check('no verdict: header says why', /^\*\*⚠️ Checks passed · Changes still requested by Codex \(no verdict given\)/.test(run.result ?? ''), (run.result ?? '').split('\n')[0]);
  updateSettings({ council: { ...getSettings().council, maxFixRounds: 1 } });
  reset(); setupProject(); flag('review_no_verdict', true);
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  check('no verdict: counts as changes → fix round', roles(run) === 'planner,builder,checks,reviewer,reviewer,builder,checks,reviewer,reviewer' && /no verdict/.test(run.steps[5]?.note ?? ''), roles(run));

  // Declining the checks skips the gate for the rest of the run (edit prompts off so only the checks ask).
  reset(); setupProject(); updateSettings({ council: { ...getSettings().council, confirmWrites: false } }); denyNext = true; approvals = 0;
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  denyNext = false;
  check('declined checks: step skipped, review and QA still run', roles(run) === 'planner,builder,checks,reviewer,qa' && run.steps[2].status === 'skipped' && approvals === 1, roles(run));
  check('declined checks: header notes it', /^\*\*✅ Checks skipped \(you declined\) · Approved by Codex · QA passed by Gemini/.test(run.result ?? ''), (run.result ?? '').split('\n')[0]);

  // shellApproval 'never' → no prompt; custom command from settings wins.
  reset(); setupProject(); approvals = 0;
  const prevShell = getSettings().shellApproval;
  updateSettings({ shellApproval: 'never', council: { ...getSettings().council, checkCommand: 'node check.cjs' } });
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  check('custom command, shell approval off: runs without asking', approvals === 0 && /your check command: node check\.cjs/.test(run.steps.find((s: any) => s.role === 'checks')?.note ?? '') && /^\*\*✅ Checks passed/.test(run.result ?? ''));
  updateSettings({ shellApproval: prevShell, council: { ...getSettings().council, checkCommand: '', confirmWrites: true } });

  // Both gates off → the old plan → build → review flow.
  reset(); setupProject(); updateSettings({ council: { ...getSettings().council, checksGate: false, qaStep: false } });
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  check('gates off: plan → build → review only', roles(run) === 'planner,builder,reviewer' && /^\*\*✅ Approved by Codex\*\*/.test(run.result ?? ''), (run.result ?? '').split('\n')[0]);

  offA();
  updateSettings({ council: base });
}

// 25. continue a member's own session on Council-mode follow-ups (through the real runner)
{
  const { SessionRunner } = await import(`${SRC}/agent/runner.ts`);
  const HIST = 'Earlier in this conversation';
  const logOf = (m: string): any[] => { try { return fs.readFileSync(path.join(CTL, `${m}.log.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const argAfter = (argv: string[], f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const newSession = (): any => ({ id: `s-cont-${Math.random().toString(36).slice(2, 8)}`, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), model: null, messages: [], archive: [], workers: {}, plan: [], goal: null, usage: { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0 }, compactions: 0, compactSummary: null, mode: 'council', councilRuns: [] });
  const lastStep = (s: any) => s.councilRuns.at(-1).steps.at(-1);
  check('continue: setting defaults to on', getSettings().council.continueSessions === true);

  // Claude: two follow-ups resume the first run's session with just the new message.
  reset(); approvals = 0;
  let s = newSession(); let rn = new SessionRunner(s);
  await rn.handleUserMessage('/plan how should we structure a parser for math expressions?');
  let cl = logOf('claude');
  const c1 = s.memberSessions?.claude?.id;
  check('continue: first turn starts fresh and saves the session id', cl.length === 1 && !cl[0].argv.includes('--resume') && /^claude-[0-9a-f]{8}$/.test(c1 ?? '') && s.memberSessions.claude.role === 'planner' && s.memberSessions.claude.cwd === DEMO, c1);
  await rn.handleUserMessage('/plan and where do the tests go?');
  cl = logOf('claude');
  check('continue: second turn resumes the first run\'s session', cl.length === 2 && argAfter(cl[1].argv, '--resume') === c1 && lastStep(s).continued === true, cl[1]?.argv.join(' '));
  check('continue: resumed turn sends only the new message, no pasted history', cl[1].prompt === 'and where do the tests go?' && !cl[1].prompt.includes(HIST), JSON.stringify(cl[1].prompt).slice(0, 120));
  await rn.handleUserMessage('/plan ok, and the error messages?');
  cl = logOf('claude');
  check('continue: third turn keeps continuing', argAfter(cl[2].argv, '--resume') === c1 && !cl[2].prompt.includes(HIST));

  // A different member starts fresh (with history); switching back also starts fresh.
  await rn.handleUserMessage('/review check src/math.ts for bugs');
  const cx = logOf('codex');
  check('continue: a different member starts fresh with the chat history', cx.length === 1 && !cx[0].argv.includes('resume') && cx[0].prompt.includes(HIST) && !lastStep(s).continued, cx[0]?.argv.join(' '));
  await rn.handleUserMessage('/plan back to the parser: what about precedence?');
  cl = logOf('claude');
  check('continue: back to claude after codex answered → fresh run', cl.length === 4 && !cl[3].argv.includes('--resume') && cl[3].prompt.includes(HIST) && s.memberSessions.claude.id !== c1);

  // Multi-step patterns never resume (even right after a single claude turn).
  const before = logOf('claude').length;
  await rn.handleUserMessage('/build add rate limiting to the API');
  cl = logOf('claude').slice(before);
  check('continue: pbr run starts every member fresh', s.councilRuns.at(-1).pattern === 'plan_build_review' && cl.length >= 1 && cl.every((x: any) => !x.argv.includes('--resume')) && s.councilRuns.at(-1).steps.every((st: any) => !st.continued), `${cl.length} claude runs`);

  // Gemini: init session_id captured, resumed with --resume <uuid>; same role → instructions not repeated.
  reset();
  s = newSession(); rn = new SessionRunner(s);
  await rn.handleUserMessage('/research what does src/math.ts do?');
  await rn.handleUserMessage('/research who calls add?');
  const gm = logOf('gemini');
  check('continue: gemini resumes by session id with just the message', gm.length === 2 && !gm[0].argv.includes('--resume') && argAfter(gm[1].argv, '--resume') === s.memberSessions.gemini.id && gm[1].prompt === 'who calls add?', gm[1]?.argv.filter((x: string) => x.startsWith('-')).join(' '));

  // Codex: thread_id captured, `exec … resume <id> -` with -C/-s still before `resume`.
  reset();
  s = newSession(); rn = new SessionRunner(s);
  await rn.handleUserMessage('/review check src/math.ts for bugs');
  const t1 = s.memberSessions?.codex?.id;
  await rn.handleUserMessage('/review anything else?');
  const cxl = logOf('codex');
  const ri = cxl[1]?.argv.indexOf('resume') ?? -1;
  check('continue: codex resumes its thread (exec flags before `resume`)', /^codex-/.test(t1 ?? '') && ri > 0 && cxl[1].argv[ri + 1] === t1 && cxl[1].argv.at(-1) === '-' && cxl[1].argv.indexOf('-C') < ri && cxl[1].argv.indexOf('-s') < ri && cxl[1].argv[cxl[1].argv.indexOf('-s') + 1] === 'read-only' && cxl[1].prompt === 'anything else?', cxl[1]?.argv.join(' '));
  check('continue: codex resume repeats the read-only sandbox after `resume`', cxl[1].argv.indexOf('sandbox_mode="read-only"') > ri && cxl[1].argv[cxl[1].argv.indexOf('sandbox_mode="read-only"') - 1] === '-c', cxl[1]?.argv.join(' '));

  // Cursor: Agent.resume with the first agent's id; tool limits and system prompt passed again.
  reset(); approvals = 0;
  s = newSession(); rn = new SessionRunner(s);
  await rn.handleUserMessage('/ask cursor explain what add does');
  await rn.handleUserMessage('/ask cursor and what about negative numbers?');
  const cu = logOf('cursor');
  check('continue: cursor resumes its local agent', cu.length === 2 && !cu[0].resumedFrom && cu[1].resumedFrom === cu[0].agentId && !!cu[1].opts.systemPrompt && JSON.stringify(cu[1].opts.disallowedTools) === JSON.stringify(cu[0].opts.disallowedTools) && cu[1].prompt === 'and what about negative numbers?' && lastStep(s).continued === true, JSON.stringify({ a: cu[0]?.agentId, r: cu[1]?.resumedFrom }));

  // Resume failure → one fresh retry with history, noted on the step, new session saved.
  for (const [m, first, second] of [['claude', '/plan how should we structure the parser?', '/plan and the tests?'], ['gemini', '/research what does src/math.ts do?', '/research who calls add?'], ['codex', '/review check src/math.ts', '/review anything else?'], ['cursor', '/ask cursor explain add', '/ask cursor and negatives?']] as const) {
    reset(); approvals = 0;
    s = newSession(); rn = new SessionRunner(s);
    await rn.handleUserMessage(first);
    const old = s.memberSessions?.[m]?.id;
    flag('resume_fail', true);
    await rn.handleUserMessage(second);
    const lg = logOf(m);
    const st2 = lastStep(s);
    const resumedFirst = m === 'cursor' ? true : m === 'codex' ? lg[1]?.argv.includes('resume') : lg[1]?.argv.includes('--resume');
    const freshPrompt = lg.at(-1)?.prompt ?? '';
    check(`continue: ${m} resume failure falls back to a fresh run`, !!old && resumedFirst && st2.status === 'done' && !st2.continued && freshPrompt.includes(HIST) && st2.transcript.some((t: any) => t.kind === 'note' && /Couldn't continue .* earlier session/.test(t.text ?? '')) && !!s.memberSessions?.[m]?.id && s.memberSessions[m].id !== old, `${st2.status} ${st2.error ?? ''} ${lg.length} runs`);
  }

  // Setting off → fresh with history; "New conversation with members" clears saved sessions.
  reset();
  updateSettings({ council: { ...getSettings().council, continueSessions: false } });
  s = newSession(); rn = new SessionRunner(s);
  await rn.handleUserMessage('/plan how should we structure the parser?');
  await rn.handleUserMessage('/plan and the tests?');
  cl = logOf('claude');
  check('continue: setting off → no resume, history pasted', cl.length === 2 && cl.every((x: any) => !x.argv.includes('--resume')) && cl[1].prompt.includes(HIST) && !s.memberSessions);
  updateSettings({ council: { ...getSettings().council, continueSessions: true } });
  reset();
  s = newSession(); rn = new SessionRunner(s);
  await rn.handleUserMessage('/plan how should we structure the parser?');
  rn.clearMemberSessions();
  check('continue: new conversation clears member sessions', !s.memberSessions);
  await rn.handleUserMessage('/plan and the tests?');
  cl = logOf('claude');
  check('continue: after clearing, the next turn starts fresh', !cl[1].argv.includes('--resume') && cl[1].prompt.includes(HIST));

  // Runs outside Council-mode chat (lead agent tools, direct runCouncil) never save or resume.
  reset();
  const plain: any = newSession();
  await runCouncil({ session: plain, signal: new AbortController().signal, persist: () => {}, delegateLocal: async () => '' }, { pattern: 'single', role: 'planner', member: 'claude', task: 'plan it', note: 'test' });
  check('continue: non-chat runs do not save sessions', !plain.memberSessions);
}

// 26. builder edits land in a separate copy (git worktree); the user applies or discards them
{
  console.log('\n# builder worktrees');
  const { applyRunChanges, discardRunChanges } = await import(`${SRC}/council/orchestrator.ts`);
  const { cleanupStaleWorktrees, listCouncilWorktrees, worktreesDir } = await import(`${SRC}/council/worktrees.ts`);
  const sh = (cmd: string, cwd = DEMO) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
  const real = (p: string) => fs.realpathSync(p);
  const lastOf = (m: string) => JSON.parse(fs.readFileSync(path.join(CTL, `${m}.last.json`), 'utf8'));
  const branchExists = (b: string) => sh(`git branch --list ${b}`) !== '';
  let cmds: string[] = [];
  const off = bus.subscribe((ev: any) => { if (ev.type === 'approval_request') cmds.push(ev.command); });
  const headBefore = sh('git rev-parse HEAD');
  const checksCwdFile = path.join(CTL, 'checks.cwd');
  const base = { ...getSettings().council, builderWorktree: true, qaStep: false, checksGate: true, checkCommand: `pwd > '${checksCwdFile}'`, maxFixRounds: 1 };
  updateSettings({ council: base });

  // plan → build → review: the user's folder is untouched, everything happens in the copy.
  reset(); approvals = 0; cmds = [];
  let run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  const wt = run.worktree;
  console.log(runSummary(run));
  check('worktree: pbr run left a pending copy with the builder\'s file', !!wt && wt.status === 'pending' && wt.files.includes('src/rateLimit.ts') && fs.existsSync(path.join(wt.cwd, 'src/rateLimit.ts')), JSON.stringify(wt && { status: wt.status, files: wt.files }));
  check('worktree: user folder unchanged (no new file, clean status, same HEAD)', !fs.existsSync(`${DEMO}/src/rateLimit.ts`) && sh('git status --porcelain') === '' && sh('git rev-parse HEAD') === headBefore);
  check('worktree: copy lives under the data folder on branch council/<runId>', !!wt && real(path.dirname(wt.path)) === real(worktreesDir()) && wt.branch === `council/${run.id}` && branchExists(wt.branch) && wt.base === headBefore);
  check('worktree: planner ran in the project folder', real(lastOf('claude').cwd) === real(DEMO), lastOf('claude').cwd);
  check('worktree: builder (cursor) worked in the copy', !!wt && real(lastOf('cursor').opts.local.cwd) === real(wt.cwd), lastOf('cursor').opts.local.cwd);
  const cx = lastOf('codex');
  check('worktree: reviewer (codex) ran in the copy (-C and cwd)', !!wt && real(cx.argv[cx.argv.indexOf('-C') + 1]) === real(wt.cwd) && real(cx.cwd) === real(wt.cwd), cx.argv[cx.argv.indexOf('-C') + 1]);
  check('worktree: reviewer got the diff from the copy, new file included', /\+\+\+ b\/src\/rateLimit\.ts/.test(cx.prompt));
  check('worktree: checks ran in the copy', fs.existsSync(checksCwdFile) && !!wt && real(fs.readFileSync(checksCwdFile, 'utf8').trim()) === real(wt.cwd), fs.existsSync(checksCwdFile) ? fs.readFileSync(checksCwdFile, 'utf8').trim() : 'no checks.cwd');
  check('worktree: edit approval names the separate copy', cmds.some((c) => /separate copy of your project/.test(c) && !!wt && c.includes(wt.cwd)), cmds[0]?.slice(0, 120));
  check('worktree: members were told they work in a copy', /separate copy \(git worktree\)/.test(lastOf('cursor').opts.systemPrompt ?? '') || /separate copy \(git worktree\)/.test(JSON.stringify(lastOf('cursor').opts)));
  check('worktree: snapshot commit is on the council branch only, by LocalDex', !!wt && sh(`git log -1 --format=%an ${wt.branch}`) === 'LocalDex' && sh('git log -1 --format=%an HEAD') !== 'LocalDex');
  check('worktree: result says changes are waiting', /Changes are waiting in a separate copy — review and apply them/.test(run.result ?? ''), (run.result ?? '').slice(-160));
  check('worktree: run card data has diff stat and diff', !!wt && /rateLimit\.ts/.test(wt.diffStat) && /\+export/.test(wt.diff ?? ''));

  // Apply: the file arrives as an uncommitted change; HEAD and the index stay as they were.
  let after = applyRunChanges(run);
  check('apply: status applied, file now in the folder', after?.status === 'applied' && !after.error && fs.existsSync(`${DEMO}/src/rateLimit.ts`) && fs.readFileSync(`${DEMO}/src/rateLimit.ts`, 'utf8') === fs.readFileSync(path.join(wt!.cwd, 'src/rateLimit.ts'), 'utf8'), after?.error);
  check('apply: uncommitted (git status shows it, HEAD unchanged, nothing staged)', sh('git status --porcelain') === '?? src/rateLimit.ts' && sh('git rev-parse HEAD') === headBefore && sh('git diff --cached --name-only') === '', sh('git status --porcelain'));
  after = applyRunChanges(run);
  check('apply: a second apply is refused', after?.status === 'applied' && /already/.test(after.error ?? ''));
  const appliedWt = { ...wt! };

  // Discard: copy and branch are removed.
  reset();
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  const wt2 = { ...run.worktree! };
  after = discardRunChanges(run);
  check('discard: copy and branch removed, folder untouched', after?.status === 'discarded' && !fs.existsSync(wt2.path) && !branchExists(wt2.branch) && !sh('git worktree list').includes(wt2.path) && sh('git status --porcelain') === '');

  // Conflict: the user changed the same file meanwhile → refused, their file is left alone.
  reset();
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  fs.mkdirSync(`${DEMO}/src`, { recursive: true });
  fs.writeFileSync(`${DEMO}/src/rateLimit.ts`, '// my own version\n');
  after = applyRunChanges(run);
  check('conflict: apply refused with a clear status', after?.status === 'conflict' && /uncommitted changes to src\/rateLimit\.ts/.test(after.error ?? '') && fs.readFileSync(`${DEMO}/src/rateLimit.ts`, 'utf8') === '// my own version\n', after?.error);
  // Once the user's change is gone and they committed something unrelated meanwhile, apply works.
  fs.rmSync(`${DEMO}/src/rateLimit.ts`);
  fs.writeFileSync(`${DEMO}/README.md`, '# Demo\nmore\n');
  sh('git -c user.name=t -c user.email=t@t commit -qam "user change"');
  after = applyRunChanges(run);
  check('conflict: retry after the user cleaned up applies on top of their new commit', after?.status === 'applied' && fs.existsSync(`${DEMO}/src/rateLimit.ts`) && sh('git status --porcelain') === '?? src/rateLimit.ts' && /more/.test(fs.readFileSync(`${DEMO}/README.md`, 'utf8')), after?.error);
  // A tracked file the user edited and the copy also edited.
  reset(); sh(`git reset -q --hard ${headBefore}`);
  run = await runCouncil(ctx(), { pattern: 'plan_build_review', role: 'builder', task: 'Add rate limiting to the API', note: 'test' });
  fs.appendFileSync(path.join(run.worktree!.path, 'README.md'), 'copy edit\n');
  fs.appendFileSync(`${DEMO}/README.md`, 'user edit\n');
  after = applyRunChanges(run);
  check('conflict: user edits to a file the copy changed are never overwritten', after?.status === 'conflict' && /README\.md/.test(after.error ?? '') && fs.readFileSync(`${DEMO}/README.md`, 'utf8') === '# Demo\nuser edit\n' && !fs.existsSync(`${DEMO}/src/rateLimit.ts`), after?.error);
  discardRunChanges(run);

  // Second opinion and single builder runs use the copy too; the critic reads the copy.
  reset();
  run = await runCouncil(ctx(), { pattern: 'second_opinion', role: 'builder', task: 'Add rate limiting', note: 'test' });
  const so = lastOf('codex');
  check('second opinion: builder in copy, critic reads the copy', run.worktree?.status === 'pending' && real(so.argv[so.argv.indexOf('-C') + 1]) === real(run.worktree.cwd) && !fs.existsSync(`${DEMO}/src/rateLimit.ts`), run.steps.map((s: any) => `${s.role}:${s.member}`).join(' '));
  discardRunChanges(run);
  reset();
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  check('single builder: edits land in the copy', run.worktree?.status === 'pending' && real(lastOf('codex').cwd) === real(run.worktree.cwd) && !fs.existsSync(`${DEMO}/src/rateLimit.ts`) && /Changes are waiting/.test(run.result ?? ''));
  discardRunChanges(run);

  // Nothing changed → the copy is removed again.
  reset();
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'gemini', task: 'add a rate limiter', note: 'test' });
  check('no changes: copy removed, nothing waiting', !run.worktree && !fs.existsSync(path.join(worktreesDir(), run.id)) && !branchExists(`council/${run.id}`) && !/Changes are waiting/.test(run.result ?? ''));

  // Local builder: no copy (it only works in approved folders), with a note.
  reset();
  const prevModel = getSettings().model;
  updateSettings({ model: 'test-local-model' });
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'local', task: 'add a rate limiter', note: 'test' });
  updateSettings({ model: prevModel });
  check('local builder: no copy, edits the folder directly with a note', !run.worktree && run.steps[0]?.transcript.some((t: any) => /local model edits your folder directly/.test(t.text ?? '')));

  // Declined edit: copy created for the prompt, then removed because nothing changed.
  reset(); denyNext = true;
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  denyNext = false;
  check('declined edit: no copy left behind', run.steps[0].status === 'skipped' && !run.worktree && !branchExists(`council/${run.id}`));

  // Not a git repo → edits go to the folder, with a note.
  reset();
  const plainDir = fs.mkdtempSync(path.join(path.dirname(DEMO), 'plain-'));
  const folders = getSettings().approvedFolders;
  updateSettings({ approvedFolders: [plainDir] });
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  updateSettings({ approvedFolders: folders });
  check('non-git folder: falls back to editing the folder, with a note', !run.worktree && fs.existsSync(path.join(plainDir, 'src/rateLimit.ts')) && run.steps[0].transcript.some((t: any) => /Not a git repository/.test(t.text ?? '')));

  // Setting off: old behaviour, edits land in the folder.
  reset(); updateSettings({ council: { ...base, builderWorktree: false } });
  const branchesBefore = sh('git branch --list "council/*"');
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  check('setting off: edits go straight to the folder, no copy', !run.worktree && fs.existsSync(`${DEMO}/src/rateLimit.ts`) && sh('git branch --list "council/*"') === branchesBefore && real(lastOf('codex').cwd) === real(DEMO));
  updateSettings({ council: base });

  // Startup cleanup: applied/discarded copies older than 7 days go, with their branches.
  const nowList = listCouncilWorktrees();
  check('cleanup: records list applied and discarded copies', nowList.some((r: any) => r.runId && r.status === 'applied') && nowList.some((r: any) => r.status === 'discarded'));
  check('cleanup: nothing removed while recent', cleanupStaleWorktrees() === 0 && fs.existsSync(appliedWt.path));
  const removed = cleanupStaleWorktrees(Date.now() + 8 * 24 * 3600_000);
  check('cleanup: stale applied copy and its branch removed', removed >= 2 && !fs.existsSync(appliedWt.path) && !branchExists(appliedWt.branch) && !listCouncilWorktrees().some((r: any) => r.status === 'applied' || r.status === 'discarded'), `removed ${removed}`);

  off();
  sh(`git reset -q --hard ${headBefore}`);
  updateSettings({ council: { ...base, builderWorktree: false, checkCommand: '' } });
}

// 27. Hand a Solo chat to the council, and per-message access in Council mode (through the real runner)
{
  const { SessionRunner, lastUserRequest, localWorkSummary } = await import(`${SRC}/agent/runner.ts`);
  const newSession = (mode: 'solo' | 'council'): any => ({ id: `s-esc-${Math.random().toString(36).slice(2, 8)}`, title: 't', createdAt: Date.now(), updatedAt: Date.now(), model: null, messages: [], archive: [], workers: {}, plan: [], goal: null, usage: { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0 }, compactions: 0, compactSummary: null, mode, councilRuns: [] });
  const secret = 'sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc';
  const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const errors: string[] = [];
  const unsub = bus.subscribe((ev: any) => { if (ev.type === 'error' && ev.sessionId?.startsWith('s-esc-')) errors.push(ev.message); });

  // A finished Solo turn: the local agent wrote/edited files, ran tests (one failed) and answered.
  reset(); approvals = 0;
  const s = newSession('solo');
  s.messages.push(
    { role: 'system', content: 'You are LocalDex.' },
    { role: 'user', content: 'Add a multiply function to src/math.ts with a test' },
    { role: 'assistant', content: null, tool_calls: [call('t1', 'write_file', { path: 'src/multiply.ts', content: 'export const mul = (a, b) => a * b;' }), call('t2', 'edit_file', { path: 'src/math.ts', old_string: 'x', new_string: 'y' })] },
    { role: 'tool', tool_call_id: 't1', name: 'write_file', content: 'Wrote src/multiply.ts', ok: true },
    { role: 'tool', tool_call_id: 't2', name: 'edit_file', content: 'Edited src/math.ts', ok: true },
    { role: 'assistant', content: null, tool_calls: [call('t3', 'shell_run', { command: 'npm test' })] },
    { role: 'tool', tool_call_id: 't3', name: 'shell_run', content: 'FAIL tests/multiply.test.ts\nexpected 6, got NaN', ok: false },
    { role: 'assistant', content: `I added mul() but the test still fails. I used STRIPE_KEY=${secret} from your .env while testing.` },
    { role: 'user', content: '[system] Step limit (40) reached; run paused.' },
  );
  check('escalate: latest request skips [system] notes', lastUserRequest(s.messages) === 'Add a multiply function to src/math.ts with a test');
  const rn = new SessionRunner(s);
  await rn.escalate({ pattern: 'single', member: 'claude', note: 'please fix the failing test' });
  const sent = JSON.parse(fs.readFileSync(path.join(CTL, 'claude.last.json'), 'utf8')).prompt as string;
  const er = s.councilRuns.at(-1);
  check('escalate: member prompt has the original request and the note', sent.includes('Add a multiply function to src/math.ts with a test') && sent.includes('please fix the failing test'), sent.slice(0, 120));
  check('escalate: member prompt summarizes touched files, commands and failures', /Files the local agent touched:[\s\S]*src\/multiply\.ts \(wrote\)[\s\S]*src\/math\.ts \(edited\)/.test(sent) && sent.includes('✗ $ npm test') && /Failures:[\s\S]*expected 6, got NaN/.test(sent) && sent.includes('I added mul()'));
  check('escalate: history is redacted', !sent.includes(secret) && sent.includes('[REDACTED'));
  check('escalate: session stays in Solo mode', s.mode === 'solo');
  const tail = s.messages.slice(-4);
  check('escalate: a council turn is appended with via', tail[0].role === 'user' && /^\[Handed to council: ask claude\]/.test(tail[0].content) && tail[1].tool_calls?.[0]?.function.name === 'council' && tail[2].role === 'tool' && tail[3].role === 'assistant' && tail[3].via === 'Claude' && !!tail[3].content, tail.map((m: any) => m.role).join(','));
  check('escalate: run is marked as handed over, member asked directly', er.escalated === true && er.pattern === 'single' && er.steps[0].member === 'claude' && er.status === 'done');
  check('escalate: risk rated on the request, not the history', er.risk !== 'high', er.risk);

  // A second hand-over uses the same request (the bracketed note is skipped) and a picked pattern.
  reset();
  await rn.escalate({ pattern: 'vote' });
  check('escalate: vote pattern on the same request', s.councilRuns.at(-1).pattern === 'vote' && s.councilRuns.at(-1).escalated && s.mode === 'solo');

  // Summary is capped (longer than the 6k chat context, at most ~20k).
  const big: any[] = [{ role: 'user', content: 'do a big thing' }];
  for (let i = 0; i < 40; i++) big.push({ role: 'assistant', content: `answer ${i} ${'x'.repeat(2500)}` });
  big.push({ role: 'assistant', content: 'the very last answer' });
  const sum = localWorkSummary(big);
  check('escalate: summary keeps the newest answers within ~20k', sum.length <= 20_000 && sum.length > 6_000 && sum.includes('the very last answer') && !sum.includes('answer 0 '), String(sum.length));

  // Refuses politely while a run is in progress.
  reset();
  const busy = newSession('council'); const rb = new SessionRunner(busy);
  const pending = rb.handleUserMessage('/plan how should we structure the parser?');
  const before = errors.length;
  await rb.escalate({ pattern: 'auto' });
  await pending;
  check('escalate: refused while a run is in progress', errors.length === before + 1 && /run is in progress/.test(errors.at(-1) ?? '') && busy.councilRuns.length === 1 && !busy.messages.some((m: any) => /Handed to council/.test(m.content ?? '')));
  unsub();

  // Per-message access (Council mode). Settings: allowWrite on, confirmWrites on.
  const base = getSettings().council;
  reset(); approvals = 0;
  const cs = newSession('council'); const rc = new SessionRunner(cs);
  await rc.handleUserMessage('/build add rate limiting to the API', 'read');
  let ar = cs.councilRuns.at(-1);
  check('access read: every member read-only, nobody asked', ar.access === 'read' && ar.steps.length > 0 && ar.steps.every((x: any) => x.access === 'read') && approvals === 0, ar.steps.map((x: any) => `${x.role}:${x.access}`).join(','));

  reset(); approvals = 0;
  updateSettings({ council: { ...getSettings().council, confirmWrites: false } });
  await rc.handleUserMessage('/frontend fix the typo in the navbar component', 'confirm');
  ar = cs.councilRuns.at(-1);
  check('access confirm: builder may edit, the edit step asks (even with confirm off in Settings)', ar.access === 'confirm' && ar.steps[0].access === 'write' && approvals === 1 && getSettings().council.confirmWrites === false);
  updateSettings({ council: base });

  reset(); approvals = 0;
  await rc.handleUserMessage('/frontend fix the typo in the navbar component', 'auto');
  ar = cs.councilRuns.at(-1);
  check('access auto: builder edits without asking (normal risk)', ar.access === 'auto' && ar.steps[0].access === 'write' && ar.steps[0].status === 'done' && approvals === 0 && getSettings().council.confirmWrites === true, ar.risk);

  reset(); approvals = 0;
  await rc.handleUserMessage('/backend add a database migration for the users table', 'auto');
  ar = cs.councilRuns.at(-1);
  check('access auto: high-risk run still asks', ar.access === 'auto' && ar.risk === 'high' && ar.steps[0].access === 'write' && approvals === 1 && ar.steps[0].transcript.some((t: any) => /"Edits allowed" was picked/.test(t.text ?? '')));

  // Routing follows the picked access: a change request with "Read only" goes to the planner, not a builder.
  reset(); approvals = 0;
  await rc.handleUserMessage('fix the typo in README', 'read');
  ar = cs.councilRuns.at(-1);
  check('access read: router does not send a change to a builder', ar.steps[0].role === 'planner' && ar.steps.every((x: any) => x.access === 'read') && approvals === 0, ar.routeNote);
  check('access: never saved into settings', JSON.stringify(getSettings().council) === JSON.stringify(base));

  // No access given → Settings decide, nothing shown on the run.
  reset(); approvals = 0;
  await rc.handleUserMessage('/frontend fix the typo in the navbar component');
  ar = cs.councilRuns.at(-1);
  check('access: none given → Settings (confirm on) ask, no chip', ar.access === undefined && approvals === 1);
}

// 28. Arena: two builders race on the same task, each in its own copy; the user keeps one
{
  console.log('\n# arena');
  const { applyArenaEntry, discardArena } = await import(`${SRC}/council/orchestrator.ts`);
  const { worktreesDir } = await import(`${SRC}/council/worktrees.ts`);
  const sh = (cmd: string, cwd = DEMO) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
  const real = (p: string) => fs.realpathSync(p);
  const lastOf = (m: string) => JSON.parse(fs.readFileSync(path.join(CTL, `${m}.last.json`), 'utf8'));
  const branchExists = (b: string) => sh(`git branch --list ${b}`) !== '';
  const headBefore = sh('git rev-parse HEAD');
  const prev = getSettings().council;
  const checksFile = path.join(CTL, 'arena-checks.cwd');
  updateSettings({ council: { ...prev, builderWorktree: false, qaStep: false, checksGate: true, checkCommand: `pwd >> '${checksFile}'` } });
  let cmds: string[] = [];
  const off = bus.subscribe((ev: any) => { if (ev.type === 'approval_request') cmds.push(ev.command); });

  // Parsing: opt-in through the command only.
  const p1 = parseCommand('/arena add a rate limiter')!;
  const p2 = parseCommand('/arena claude codex add a rate limiter')!;
  const p3 = parseCommand('/arena gpt fix the README typo')!;
  check('arena: /arena <task> parses, contestants left to the router', p1.pattern === 'arena' && p1.role === 'builder' && p1.task === 'add a rate limiter' && !p1.members, JSON.stringify(p1));
  check('arena: /arena claude codex <task> names both contestants', p2.pattern === 'arena' && same(p2.members, ['claude', 'codex']) && p2.task === 'add a rate limiter', JSON.stringify(p2));
  check('arena: one name picks one contestant (aliases work)', same(p3.members, ['codex']) && p3.task === 'fix the README typo');
  check('arena: keyword routing never picks arena', ['race two builders on the rate limiter', 'add a rate limiter', 'compare two implementations of the parser'].every((t) => classify(t).pattern !== 'arena'));

  // Full race: cursor vs codex (builder order), gemini judges.
  reset(); approvals = 0; cmds = [];
  let run = await runCouncil(ctx(), parseCommand('/arena add a rate limiter')!);
  console.log(runSummary(run));
  const [ea, eb] = run.arena?.entries ?? [];
  check('arena: two contestants from the builder order', run.status === 'done' && ea?.member === 'cursor' && eb?.member === 'codex', JSON.stringify(run.arena?.entries.map((x: any) => `${x.member}:${x.status}`)));
  check('arena: two copies on branches council/<runId>-<member>', !!ea && !!eb && ea.worktree.branch === `council/${run.id}-cursor` && eb.worktree.branch === `council/${run.id}-codex` && branchExists(ea.worktree.branch) && branchExists(eb.worktree.branch) && real(path.dirname(ea.worktree.path)) === real(worktreesDir()) && ea.worktree.base === headBefore);
  check('arena: user folder untouched', !fs.existsSync(`${DEMO}/src/rateLimit.ts`) && sh('git status --porcelain') === '' && sh('git rev-parse HEAD') === headBefore);
  check('arena: each contestant worked in its own copy', real(lastOf('cursor').opts.local.cwd) === real(ea.worktree.cwd) && real(lastOf('codex').cwd) === real(eb.worktree.cwd) && ea.worktree.cwd !== eb.worktree.cwd);
  check('arena: each copy holds only its own builder\'s version', /\(cursor\)/.test(fs.readFileSync(path.join(ea.worktree.cwd, 'src/rateLimit.ts'), 'utf8')) && /new Map/.test(fs.readFileSync(path.join(eb.worktree.cwd, 'src/rateLimit.ts'), 'utf8')));
  const builds = run.steps.filter((s: any) => s.role === 'builder');
  check('arena: builders ran in parallel, both with write access', builds.length === 2 && builds.every((s: any) => s.access === 'write' && s.status === 'done') && builds[0].startedAt < builds[1].endedAt && builds[1].startedAt < builds[0].endedAt);
  const editAsks = cmds.filter((c) => /edit files/.test(c));
  check('arena: one edit approval names both copies (checks asked separately)', editAsks.length === 1 && editAsks[0].includes(ea.worktree.cwd) && editAsks[0].includes(eb.worktree.cwd) && /Council arena/.test(editAsks[0]) && cmds.filter((c) => /run the project's checks on/.test(c)).length === 2, cmds.map((c) => c.split('\n')[0]).join(' | '));
  const checkedIn = fs.existsSync(checksFile) ? fs.readFileSync(checksFile, 'utf8').trim().split('\n').map(real) : [];
  check('arena: checks ran in each copy', checkedIn.length === 2 && checkedIn.includes(real(ea.worktree.cwd)) && checkedIn.includes(real(eb.worktree.cwd)) && ea.checks?.ok === true && eb.checks?.ok === true, checkedIn.join(' | '));
  const jp = lastOf('gemini').prompt as string;
  check('arena: judge (third member) saw both diffs', run.arena.judge === 'gemini' && run.steps.at(-1).role === 'judge' && /\(cursor\)/.test(jp) && /new Map/.test(jp) && /Version A/.test(jp) && /Version B/.test(jp) && !/\bCursor\b|\bCodex\b/.test(jp.split('Task from the user')[1] ?? ''));
  check('arena: judge picks one with a reason', run.arena.pick === 'codex' && /limits requests per IP/.test(run.arena.reason ?? '') && /Gemini recommends Codex/.test(run.result ?? ''), `${run.arena.pick} ${run.arena.reason}`);
  check('arena: entries carry diff, files and summary; result says two versions wait', ea.worktree.status === 'pending' && ea.worktree.files.includes('src/rateLimit.ts') && /\+export/.test(eb.worktree.diff ?? '') && /Implemented the plan/.test(eb.summary ?? '') && /Two versions are waiting/.test(run.result ?? '') && !run.worktree);

  // Keep one: codex's file lands, cursor's copy and branch go.
  let kept = applyArenaEntry(run, 'codex');
  check('arena keep: chosen version applied to the folder', kept?.status === 'applied' && !kept.error && fs.readFileSync(`${DEMO}/src/rateLimit.ts`, 'utf8') === fs.readFileSync(path.join(eb.worktree.cwd, 'src/rateLimit.ts'), 'utf8') && sh('git status --porcelain') === '?? src/rateLimit.ts' && run.arena.kept === 'codex', kept?.error);
  check('arena keep: the other copy and branch removed', ea.worktree.status === 'discarded' && !fs.existsSync(ea.worktree.path) && !branchExists(ea.worktree.branch) && !sh('git worktree list').includes(ea.worktree.path));
  kept = applyArenaEntry(run, 'cursor');
  check('arena keep: the other version can no longer be applied', !!kept?.error && /already kept Codex/.test(kept.error) && /new Map/.test(fs.readFileSync(`${DEMO}/src/rateLimit.ts`, 'utf8')));
  discardArena(run);

  // Discard both.
  reset(); sh(`git reset -q --hard ${headBefore}`);
  run = await runCouncil(ctx(), parseCommand('/arena add a rate limiter')!);
  const both = run.arena.entries.map((x: any) => ({ ...x.worktree }));
  const gone = discardArena(run);
  check('arena discard both: copies and branches removed, folder untouched', gone.length === 2 && run.arena.entries.every((x: any) => x.worktree.status === 'discarded') && both.every((w: any) => !fs.existsSync(w.path) && !branchExists(w.branch)) && sh('git status --porcelain') === '' && !run.arena.kept);

  // Read-only access: refused before anything runs.
  reset(); approvals = 0;
  const branchesBefore = sh('git branch --list "council/*"');
  run = await runCouncil(ctx(), { ...parseCommand('/arena add a rate limiter')!, access: 'read' });
  check('arena: refused under read access', run.status === 'error' && /needs file edits/.test(run.result ?? '') && /Read only/.test(run.result ?? '') && run.steps.length === 0 && !run.arena && approvals === 0 && sh('git branch --list "council/*"') === branchesBefore, run.result);

  // Fewer than two members that can build.
  reset();
  for (const m of ['cursor', 'codex', 'claude'] as const) markLimited(m, 'Usage limit. Try again in 2 hours.');
  run = await runCouncil(ctx(), parseCommand('/arena add a rate limiter')!);
  check('arena: fewer than two members → clear error', run.status === 'error' && /needs two cloud members that can build/.test(run.result ?? '') && /only Gemini is available/.test(run.result ?? '') && !run.arena && run.steps.length === 0, run.result?.split('\n')[0]);
  reset();
  run = await runCouncil(ctx(), parseCommand('/arena local codex add a rate limiter')!);
  check('arena: the local model is refused as a contestant', run.status === 'error' && /local model can't race/.test(run.result ?? '') && !run.arena);

  // Stop cancels both contestants.
  reset(); flag('codex_slow', true); flag('gemini_slow', true);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 1500);
  const t0 = Date.now();
  run = await runCouncil(ctx(stop.signal), parseCommand('/arena codex gemini add a rate limiter')!);
  const took = Date.now() - t0;
  const pids = ['codex', 'gemini'].map((m) => Number(fs.readFileSync(path.join(CTL, `${m}.pid`), 'utf8')));
  const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  check('arena: Stop cancels both builders', run.status === 'cancelled' && took < 6000 && run.arena.entries.every((x: any) => x.status === 'cancelled') && run.steps.filter((s: any) => s.role === 'builder').length === 2 && run.steps.every((s: any) => s.status === 'cancelled') && !run.steps.some((s: any) => s.role === 'judge') && alive.length === 0, `${took}ms ${run.steps.map((s: any) => `${s.member}:${s.status}`).join(' ')} alive=${alive.length}`);
  check('arena: copies without changes are removed after Stop', run.arena.entries.every((x: any) => x.worktree.status === 'discarded' && !fs.existsSync(x.worktree.path) && !branchExists(x.worktree.branch)));

  off();
  reset(); sh(`git reset -q --hard ${headBefore}`);
  updateSettings({ council: prev });
}

// 29. Review fixes: safe apply (ignored files, user's uncommitted changes), queued access, copies outside the folder,
// failed copies, interrupted runs, orphaned copies, prototype keys, abort before spawn
{
  console.log('\n# review fixes');
  const { applyRunChanges, discardRunChanges, discardSessionCopies } = await import(`${SRC}/council/orchestrator.ts`);
  const { createWorktree, applyWorktree, discardWorktree, snapshotWorktree, worktreesDir, cleanupStaleWorktrees } = await import(`${SRC}/council/worktrees.ts`);
  const { waitingCopyPaths } = await import(`${SRC}/council/recover.ts`);
  const { SessionRunner, strictestAccess } = await import(`${SRC}/agent/runner.ts`);
  const { getSession } = await import(`${SRC}/store.ts`);
  const { SESSIONS_DIR } = await import(`${SRC}/config.ts`);
  const sh = (cmd: string, cwd = DEMO) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
  const real = (p: string) => fs.realpathSync(p);
  const read = (f: string) => fs.readFileSync(path.join(DEMO, f), 'utf8');
  const commit = (msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`);
  const headBefore = sh('git rev-parse HEAD');
  const prev = getSettings().council;
  const folders = getSettings().approvedFolders;
  const base = { ...prev, builderWorktree: true, qaStep: false, checksGate: false, maxFixRounds: 0 };
  const cleanDemo = () => { reset(); sh(`git reset -q --hard ${headBefore}`); sh('git clean -qfdx'); };
  let cmds: string[] = [];
  const off = bus.subscribe((ev: any) => { if (ev.type === 'approval_request') cmds.push(ev.command); });
  updateSettings({ council: base });

  // --- 1. An ignored file the copy would create is never overwritten or deleted.
  cleanDemo();
  fs.writeFileSync(`${DEMO}/.gitignore`, '.env\n');
  commit('ignore .env');
  fs.writeFileSync(`${DEMO}/.env`, 'USER_SETTING=mine\n');
  let wt = createWorktree(DEMO, 'ignored-env');
  fs.writeFileSync(path.join(wt.path, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(wt.path, '.env'), 'BUILDER_SETTING=theirs\n');
  let res = applyWorktree(DEMO, wt);
  check('apply: refused when the copy would create a file the user has (ignored .env)', !res.ok && res.status === 'conflict' && /\.env \(ignored by git\)/.test(res.error ?? '') && /Nothing was changed/.test(res.error ?? ''), res.error);
  check('apply: the user\'s ignored .env and .gitignore are untouched', read('.env') === 'USER_SETTING=mine\n' && read('.gitignore') === '.env\n' && sh('git status --porcelain') === '', sh('git status --porcelain'));
  discardWorktree(DEMO, wt);

  // A failed three-way apply puts existing files back and only removes files that did not exist before.
  cleanDemo();
  wt = createWorktree(DEMO, 'restore');
  fs.appendFileSync(path.join(wt.path, 'README.md'), 'copy line\n');
  fs.mkdirSync(path.join(wt.path, 'lib/deep'), { recursive: true });
  fs.writeFileSync(path.join(wt.path, 'lib/deep/new.ts'), 'export const x = 1;\n');
  fs.writeFileSync(`${DEMO}/README.md`, 'totally different\n');
  commit('user rewrote README');
  fs.writeFileSync(`${DEMO}/.env`, 'KEEP=1\n');
  res = applyWorktree(DEMO, wt);
  check('apply: failed merge restores the folder exactly (old content back, new files and folders gone)', !res.ok && res.status === 'conflict' && read('README.md') === 'totally different\n' && !fs.existsSync(`${DEMO}/lib`) && read('.env') === 'KEEP=1\n' && sh('git status --porcelain') === '?? .env' && sh('git diff --cached --name-only') === '', `${res.error} | ${sh('git status --porcelain')}`);
  discardWorktree(DEMO, wt);

  // --- 3. The user's uncommitted changes go into the copy; apply carries only the builder's changes on top.
  cleanDemo(); approvals = 0; cmds = [];
  fs.writeFileSync(`${DEMO}/README.md`, '# Demo\nuser edit\n');
  fs.writeFileSync(`${DEMO}/notes.txt`, 'my notes\n');
  let run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  wt = run.worktree;
  check('copy: includes the user\'s uncommitted edit and new file, without a warning', !!wt && fs.readFileSync(path.join(wt.path, 'README.md'), 'utf8') === '# Demo\nuser edit\n' && fs.existsSync(path.join(wt.path, 'notes.txt')) && wt.imported === 2 && !wt.note && run.steps[0].transcript.some((t: any) => /Brought your uncommitted changes \(2 files\)/.test(t.text ?? '')), JSON.stringify(wt && { imported: wt.imported, note: wt.note }));
  check('copy: the base snapshot is on the council branch; the diff holds only the builder\'s file', !!wt && wt.base !== headBefore && sh(`git log -1 --format=%s ${wt.base}`) === 'LocalDex: your uncommitted changes' && same(wt.files, ['src/rateLimit.ts']) && !/user edit/.test(wt.diff ?? ''), JSON.stringify(wt?.files));
  let after = applyRunChanges(run);
  check('apply: succeeds with the user\'s uncommitted changes still there, and keeps them', after?.status === 'applied' && !after.error && read('README.md') === '# Demo\nuser edit\n' && read('notes.txt') === 'my notes\n' && fs.existsSync(`${DEMO}/src/rateLimit.ts`) && sh('git rev-parse HEAD') === headBefore, after?.error);

  // The builder edits the same file on top of the user's (staged) edit: both end up in the folder, staging kept.
  cleanDemo();
  fs.writeFileSync(`${DEMO}/README.md`, '# Demo\nuser edit\n');
  sh('git add README.md');
  wt = createWorktree(DEMO, 'same-file');
  fs.appendFileSync(path.join(wt.path, 'README.md'), 'builder edit\n');
  res = applyWorktree(DEMO, wt);
  check('apply: builder\'s edit on top of the user\'s edit to the same file keeps both', res.ok && read('README.md') === '# Demo\nuser edit\nbuilder edit\n' && sh('git diff --cached --name-only') === 'README.md' && sh('git show :README.md') === '# Demo\nuser edit', `${res.error} | ${read('README.md')}`);
  discardWorktree(DEMO, wt);

  // The user changes that file again after the copy was made: conflict, nothing touched.
  cleanDemo();
  fs.writeFileSync(`${DEMO}/README.md`, '# Demo\nuser edit\n');
  wt = createWorktree(DEMO, 'changed-since');
  fs.appendFileSync(path.join(wt.path, 'README.md'), 'builder edit\n');
  fs.writeFileSync(path.join(wt.path, 'added.ts'), 'export {};\n');
  fs.writeFileSync(`${DEMO}/README.md`, '# Demo\nuser edit, changed again\n');
  res = applyWorktree(DEMO, wt);
  check('apply: user changed the file after the copy was made → conflict, nothing touched', !res.ok && res.status === 'conflict' && /uncommitted changes to README\.md/.test(res.error ?? '') && read('README.md') === '# Demo\nuser edit, changed again\n' && !fs.existsSync(`${DEMO}/added.ts`), res.error);
  discardWorktree(DEMO, wt);

  // --- 4. No extra folders for members working in a copy; a copy of a subfolder project only applies inside it.
  cleanDemo();
  const other = fs.mkdtempSync(path.join(path.dirname(DEMO), 'other-'));
  updateSettings({ approvedFolders: [DEMO, other] });
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  const inCopy = JSON.parse(fs.readFileSync(path.join(CTL, 'codex.last.json'), 'utf8'));
  check('copy: builder gets no other approved folders (no --add-dir)', run.worktree?.status === 'pending' && real(inCopy.cwd) === real(run.worktree.cwd) && !inCopy.argv.includes('--add-dir'), inCopy.argv.join(' '));
  discardRunChanges(run);
  updateSettings({ council: { ...base, builderWorktree: false } });
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  const direct = JSON.parse(fs.readFileSync(path.join(CTL, 'codex.last.json'), 'utf8'));
  check('no copy: other approved folders still passed (--add-dir)', !run.worktree && direct.argv.includes('--add-dir') && direct.argv.includes(other));
  updateSettings({ council: base, approvedFolders: folders });

  cleanDemo();
  fs.mkdirSync(`${DEMO}/pkg`);
  fs.writeFileSync(`${DEMO}/pkg/index.ts`, 'export {};\n');
  commit('add pkg');
  wt = createWorktree(`${DEMO}/pkg`, 'subfolder');
  fs.writeFileSync(path.join(wt.cwd, 'inside.ts'), 'export const inside = 1;\n');
  fs.appendFileSync(path.join(wt.path, 'README.md'), 'outside edit\n');
  res = applyWorktree(`${DEMO}/pkg`, wt);
  check('apply: refused when the copy changed files outside the project subfolder, listing them', real(wt.cwd) === real(path.join(wt.path, 'pkg')) && !res.ok && /outside your project folder/.test(res.error ?? '') && /README\.md/.test(res.error ?? '') && !/inside\.ts/.test(res.error ?? '') && !fs.existsSync(`${DEMO}/pkg/inside.ts`) && read('README.md') === '# Demo\n', res.error);
  fs.writeFileSync(path.join(wt.path, 'README.md'), '# Demo\n');
  res = applyWorktree(`${DEMO}/pkg`, wt);
  check('apply: inside the subfolder only → applies', res.ok && fs.existsSync(`${DEMO}/pkg/inside.ts`), res.error);
  discardWorktree(`${DEMO}/pkg`, wt);

  // --- 5. A copy that can't be made always asks first, even with "Edits allowed".
  cleanDemo(); approvals = 0; cmds = [];
  const wtDir = worktreesDir();
  const aside = `${wtDir}.aside`;
  fs.renameSync(wtDir, aside);
  fs.writeFileSync(wtDir, 'not a folder');
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test', access: 'auto' });
  check('copy failed: asks even with "Edits allowed", says edits go straight into the folder', approvals === 1 && /couldn't be made/.test(cmds[0] ?? '') && /straight into your folder/.test(cmds[0] ?? '') && !run.worktree && run.steps[0].status === 'done' && fs.existsSync(`${DEMO}/src/rateLimit.ts`), cmds[0]?.slice(0, 160));
  reset(); approvals = 0; denyNext = true;
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test', access: 'auto' });
  denyNext = false;
  check('copy failed: declining fails the step, nothing changes', approvals === 1 && run.steps[0].status === 'error' && /declined edits straight into your folder/.test(run.steps[0].error ?? '') && !fs.existsSync(`${DEMO}/src/rateLimit.ts`), run.steps[0].error);
  fs.rmSync(wtDir);
  fs.renameSync(aside, wtDir);
  reset(); approvals = 0; cmds = [];
  const plainDir = fs.mkdtempSync(path.join(path.dirname(DEMO), 'plain2-'));
  updateSettings({ approvedFolders: [plainDir], council: { ...base, confirmWrites: false } });
  run = await runCouncil(ctx(), { pattern: 'single', role: 'builder', member: 'codex', task: 'add a rate limiter', note: 'test' });
  updateSettings({ approvedFolders: folders, council: base });
  check('non-git folder: asks even with "ask before edits" off', approvals === 1 && /not a git repository/.test(cmds[0] ?? '') && fs.existsSync(path.join(plainDir, 'src/rateLimit.ts')), cmds[0]?.slice(0, 120));

  // --- 6. Runs left "running" by a stopped server are cancelled on load; orphaned copies are cleaned up.
  cleanDemo();
  const iwt = createWorktree(DEMO, 'interrupted');
  fs.writeFileSync(path.join(iwt.cwd, 'half.ts'), 'export const half = true;\n');
  const sid = `s-intr-${Math.random().toString(36).slice(2, 8)}`;
  const stale = { id: sid, title: 't', createdAt: Date.now(), updatedAt: Date.now(), model: null, messages: [], archive: [], workers: {}, plan: [], goal: null, usage: { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0 }, compactions: 0, compactSummary: null,
    councilRuns: [{ id: 'intr1', pattern: 'single', task: 'x', status: 'running', startedAt: Date.now(), steps: [{ id: 'intr1-1', role: 'builder', member: 'codex', access: 'write', status: 'running', startedAt: Date.now(), transcript: [] }], worktree: iwt }] };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${sid}.json`), JSON.stringify(stale));
  const loaded: any = getSession(sid);
  const ir = loaded.councilRuns[0];
  const onDisk = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${sid}.json`), 'utf8'));
  check('startup: a run left running is cancelled with a note (and saved)', ir.status === 'cancelled' && ir.steps[0].status === 'cancelled' && /stopped while this council run/.test(ir.result ?? '') && onDisk.councilRuns[0].status === 'cancelled');
  after = applyRunChanges(ir);
  check('startup: its waiting changes can then be applied', after?.status === 'applied' && fs.existsSync(`${DEMO}/half.ts`), after?.error);

  cleanDemo();
  const orphan = createWorktree(DEMO, 'orphan');
  const keptWt = createWorktree(DEMO, 'kept');
  const owner: any = { id: 's-owner', councilRuns: [{ id: 'kept', status: 'done', steps: [], worktree: keptWt }] };
  const waiting = waitingCopyPaths([owner]);
  const removedN = cleanupStaleWorktrees(Date.now(), undefined, (rec: any) => !waiting.has(path.resolve(rec.path)));
  check('startup: a waiting copy no session refers to is removed; referenced ones stay', removedN >= 1 && !fs.existsSync(orphan.path) && !sh(`git branch --list ${orphan.branch}`) && fs.existsSync(keptWt.path), `removed ${removedN}`);
  const n = discardSessionCopies(owner);
  check('session delete: its waiting copies are discarded', n === 1 && keptWt.status === 'discarded' && !fs.existsSync(keptWt.path) && !sh(`git branch --list ${keptWt.branch}`));

  // --- 2. Messages queued during a run keep their access; several at once get the strictest.
  check('access: strictest of queued messages', strictestAccess([undefined, 'auto']) === 'auto' && strictestAccess(['auto', 'confirm']) === 'confirm' && strictestAccess(['auto', undefined, 'read']) === 'read' && strictestAccess([undefined, undefined]) === undefined && strictestAccess(['constructor' as any]) === undefined);
  cleanDemo(); approvals = 0;
  updateSettings({ council: { ...base, builderWorktree: false } });
  const qs: any = { id: 's-queue', title: 't', createdAt: Date.now(), updatedAt: Date.now(), model: null, messages: [], archive: [], workers: {}, plan: [], goal: null, usage: { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0 }, compactions: 0, compactSummary: null, mode: 'council', councilRuns: [] };
  const rq = new SessionRunner(qs);
  const first = rq.handleUserMessage('/plan how should we structure the parser?', 'auto');
  await rq.handleUserMessage('/frontend fix the typo in the navbar component', 'read');
  await first;
  for (let i = 0; i < 100 && !(qs.councilRuns.length === 2 && qs.councilRuns[1].status !== 'running'); i++) await new Promise((r) => setTimeout(r, 100));
  let qr = qs.councilRuns[1];
  check('queued follow-up keeps its own access ("Read only")', qs.councilRuns.length === 2 && qr.access === 'read' && qr.steps.length > 0 && qr.steps.every((x: any) => x.access === 'read') && approvals === 0, JSON.stringify(qr && { access: qr.access, steps: qr.steps.map((x: any) => x.access) }));
  reset();
  const second = rq.handleUserMessage('/plan how should we structure the parser?');
  await rq.handleUserMessage('fix the typo in README', 'auto');
  await rq.handleUserMessage('and keep it short');
  await second;
  for (let i = 0; i < 100 && !(qs.councilRuns.length === 4 && qs.councilRuns[3].status !== 'running'); i++) await new Promise((r) => setTimeout(r, 100));
  qr = qs.councilRuns[3];
  check('queued follow-ups joined: an explicit pick wins over "Settings"', qs.councilRuns.length === 4 && qr?.access === 'auto' && /fix the typo in README\n\nand keep it short/.test(qs.messages.filter((m: any) => m.role === 'user').at(-1)?.content ?? ''), qr?.access);
  updateSettings({ council: base });

  // --- 7. Prototype keys are not members or patterns.
  const pc = parseCommand('/ask constructor fix the README typo')!;
  const pa = parseCommand('/arena constructor toString add a rate limiter')!;
  check('parse: "constructor" is not a member name', pc.member === undefined && pc.task === 'constructor fix the README typo' && pa.members === undefined && pa.task === 'constructor toString add a rate limiter', JSON.stringify([pc.member, pa.members]));
  reset();
  const es: any = { id: 's-proto', title: 't', createdAt: Date.now(), updatedAt: Date.now(), model: null, messages: [{ role: 'user', content: 'what does add() do?' }], archive: [], workers: {}, plan: [], goal: null, usage: { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0 }, compactions: 0, compactSummary: null, mode: 'solo', councilRuns: [] };
  updateSettings({ council: { ...base, roles: { ...base.roles, quick: ['gemini'] } } });
  await new SessionRunner(es).escalate({ pattern: 'constructor' as any });
  updateSettings({ council: base });
  check('escalate: an unknown pattern like "constructor" falls back to auto', es.councilRuns.length === 1 && es.councilRuns[0].pattern !== ('constructor' as any) && es.messages.some((m: any) => m.content === '[Handed to council: auto]'), es.councilRuns[0]?.pattern);

  // --- 9. A Stop that came before the member started: it is never spawned.
  reset();
  fs.rmSync(path.join(CTL, 'gemini.last.json'), { force: true });
  const stopped = new AbortController(); stopped.abort();
  run = await runCouncil(ctx(stopped.signal), { pattern: 'single', role: 'researcher', member: 'gemini', task: 'What does src/math.ts do?', note: 'test' });
  check('stop before start: step cancelled, member never spawned', run.status === 'cancelled' && run.steps[0]?.status === 'cancelled' && !fs.existsSync(path.join(CTL, 'gemini.last.json')), run.steps.map((s: any) => `${s.member}:${s.status}`).join(' '));

  off();
  cleanDemo();
  updateSettings({ council: prev, approvedFolders: folders });
}

console.log(`\n${pass} passed, ${fail} failed. events: ${JSON.stringify(events)}`);
reset();
process.exit(fail ? 1 : 0);
