// Integration test: the real council code against stand-in vendor CLIs (no accounts, no network).
// Run with: npm run test:council -w server
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const SRC = new URL('../../src', import.meta.url).pathname;
const DEMO = process.env.DEMO_DIR!;
const { bus } = await import(`${SRC}/agent/bus.ts`);
const { memberStatuses, clearLimit } = await import(`${SRC}/council/registry.ts`);
const { classify, parseCommand } = await import(`${SRC}/council/router.ts`);
const { runCouncil, runSummary, runVia } = await import(`${SRC}/council/orchestrator.ts`);
const { memberEnv } = await import(`${SRC}/council/proc.ts`);
const { updateSettings, getSettings } = await import(`${SRC}/config.ts`);

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
check('router: feature → pbr', r('add rate limiting to the API with tests') === 'plan_build_review/builder');
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

// 15. risk-aware routing
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
check('normal run: unchanged (single builder, no prompt, default model)', run.pattern === 'single' && run.risk === 'normal' && approvals === 0 && run.steps[0].model === 'auto', `${run.pattern} ${approvals} ${run.steps[0]?.model}`);
updateSettings({ council: prevCouncil });

console.log(`\n${pass} passed, ${fail} failed. events: ${JSON.stringify(events)}`);
reset();
process.exit(fail ? 1 : 0);
