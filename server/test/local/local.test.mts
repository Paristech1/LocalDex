// Local-model recovery: the real agent loop and runner against a mock LM Studio that replays failures seen with
// Gemma 4 12B (uncensored fine-tune) on LM Studio 0.4. No network, no real model.
// Run with: npm run test:local -w server
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const SRC = new URL('../../src', import.meta.url).pathname;
const DEMO = process.env.DEMO_DIR!;
const PORT = Number(process.env.MOCK_PORT);

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};

// ---------------- mock LM Studio ----------------
type Reply =
  | { kind: 'stream'; deltas: Array<Record<string, unknown>>; finish?: string }
  | { kind: 'midStreamError'; message: string };
type Step = (body: any) => Reply;
let script: Step[] = [];
const requests: any[] = [];

const say = (text: string): Step => () => ({ kind: 'stream', deltas: [{ content: text }], finish: 'stop' });
const textCalls = (...calls: Array<{ name: string; arguments: unknown }>): Step => () => ({
  kind: 'stream',
  deltas: calls.map((c) => ({ content: `<tool_call>${JSON.stringify(c)}</tool_call>\n` })),
  finish: 'stop',
});
/** A raw text reply, for malformed calls a JSON.stringify could never produce. */
const raw = (text: string): Step => () => ({ kind: 'stream', deltas: [{ content: text }], finish: 'stop' });
const native = (...calls: Array<{ name: string; arguments: unknown }>): Step => () => ({
  kind: 'stream',
  deltas: calls.map((c, i) => ({ tool_calls: [{ index: i, id: `call_${i}_${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }] })),
  finish: 'tool_calls',
});
const think = (chars: number): Step => () => ({
  kind: 'stream',
  deltas: Array.from({ length: Math.ceil(chars / 500) }, () => ({ reasoning_content: 'hmm, let me reconsider the approach once more. '.repeat(11).slice(0, 500) })),
  finish: 'stop',
});
const midErr = (message: string): Step => () => ({ kind: 'midStreamError', message });

const models = {
  v0: { data: [
    { id: 'gemma-mock', type: 'llm', state: 'loaded', max_context_length: 262144, loaded_context_length: 32768 },
    { id: 'plain-mock', type: 'llm', state: 'loaded', max_context_length: 8192, loaded_context_length: 8192 },
  ] },
  v1: { models: [
    { key: 'gemma-mock', type: 'llm', max_context_length: 262144, loaded_instances: [{ id: 'gemma-mock', config: { context_length: 32768 } }], capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } } },
    { key: 'plain-mock', type: 'llm', max_context_length: 8192, loaded_instances: [{ id: 'plain-mock', config: { context_length: 8192 } }], capabilities: {} },
  ] },
};
const loads: any[] = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = req.url ?? '';
    const json = (o: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (url.startsWith('/api/v0/models')) return json(models.v0);
    if (url.startsWith('/api/v1/models/unload')) return json({ instance_id: JSON.parse(body).instance_id });
    if (url.startsWith('/api/v1/models/load')) {
      const b = JSON.parse(body);
      loads.push(b);
      models.v1.models[0].loaded_instances = [{ id: b.model, config: { context_length: b.context_length } }];
      return json({ type: 'llm', instance_id: b.model, status: 'loaded', load_config: { context_length: b.context_length } });
    }
    if (url.startsWith('/api/v1/models')) return json(models.v1);
    if (url.startsWith('/v1/models')) return json({ data: models.v0.data.map((m) => ({ id: m.id, object: 'model' })) });
    if (!url.startsWith('/v1/chat/completions')) return json({ error: 'not found' }, 404);
    const b = JSON.parse(body);
    requests.push(b);
    // Tool-mode probe (non-streaming): the model "passes" it with a native call.
    if (!b.stream) {
      return json({ id: 'p', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"value":"ok"}' } }] }, finish_reason: 'tool_calls' }] });
    }
    const step = script.shift() ?? say('(mock: script finished)');
    const reply = step(b);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: b.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (reply.kind === 'midStreamError') {
      chunk({ role: 'assistant', content: '' });
      res.write(`data: ${JSON.stringify({ error: { message: reply.message, type: 'server_error' } })}\n\n`);
      return res.end();
    }
    for (const d of reply.deltas) chunk(d);
    chunk({}, reply.finish ?? 'stop');
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: b.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));

// ---------------- LocalDex under test ----------------
const { bus } = await import(`${SRC}/agent/bus.ts`);
const { runLoop } = await import(`${SRC}/agent/loop.ts`);
const { enabledTools } = await import(`${SRC}/tools/index.ts`);
const lm = await import(`${SRC}/lmstudio.ts`);
const { updateSettings } = await import(`${SRC}/config.ts`);
const { parseLenientJson, fixDoubleEscapedText, describeTextLine } = await import(`${SRC}/jsonRepair.ts`);
const { normalizePlan } = await import(`${SRC}/tools/agentTools.ts`);
const { verifiedFileFacts } = await import(`${SRC}/agent/compact.ts`);

const logs: string[] = [];
let approvals = 0;
let approve = false;
bus.subscribe((ev: any) => {
  if (ev.type === 'log') logs.push(ev.message);
  if (ev.type === 'approval_request') {
    approvals++;
    setTimeout(() => bus.resolvePrompt(ev.id, approve), 10);
  }
});

let plan: any[] = [];
async function runWith(steps: Step[], prompt: string, model = 'gemma-mock') {
  script = [...steps];
  const messages: any[] = [{ role: 'system', content: 'You are a test agent.' }, { role: 'user', content: prompt }];
  const ac = new AbortController();
  const res = await runLoop({ sessionId: 't', agent: 'main', model, messages, tools: enabledTools('main'), signal: ac.signal, maxSteps: 20, updatePlan: (s: any[]) => (plan = s) });
  return { res, messages, leftover: script.length };
}
const toolResults = (messages: any[]) => messages.filter((m) => m.role === 'tool');
const userNotes = (messages: any[]) => messages.filter((m) => m.role === 'user' && m.content.startsWith('[system]')).map((m) => m.content);
const read = (f: string) => fs.readFileSync(path.join(DEMO, f), 'utf8');

await lm.listModels();

// ---------- unit: JSON repair ----------
console.log('\n# JSON repair');
check('raw newline inside a string parses', (parseLenientJson('{"path":"a.txt","content":"one\ntwo\n"}') as any)?.content === 'one\ntwo\n');
check('Gemma <|"|> string tokens parse', (parseLenientJson('{<|"|>path<|"|>:<|"|>a.txt<|"|>}') as any)?.path === 'a.txt');
check('trailing comma parses', (parseLenientJson('{"a":1,}') as any)?.a === 1);
check('extra closing brace (}}}) parses', (parseLenientJson('{"name":"update_plan","arguments":{"steps":[{"status":"done","title":"x"}]}}}') as any)?.name === 'update_plan');
check('missing closing brace parses', (parseLenientJson('{"name":"a","arguments":{"p":"}"') as any)?.arguments?.p === '}');
const tools = enabledTools('main');
const extra = lm.parseTextToolCalls('<tool_call>{"name":"update_plan","arguments":{"steps":[{"status":"done","title":"A"}]}}}</tool_call>', tools);
check('text call ending in }}} is recovered', extra.calls.length === 1 && extra.calls[0].function.name === 'update_plan');
const rec = lm.parseTextToolCalls('<tool_call>{"name": "write_file", "arguments": {"path": "x.md", "content": "# T\nbody\n"}}</tool_call>', tools);
check('text call with raw newline in content is recovered', rec.calls.length === 1 && JSON.parse(rec.calls[0].function.arguments).content === '# T\nbody\n');

// ---------- unit: double escapes and line facts ----------
console.log('\n# Double-escaped content and line counts');
check('literal \\n in plain text becomes real newlines', fixDoubleEscapedText('one\\ntwo\\nthree', 'g/summary.txt').text === 'one\ntwo\nthree');
check('\\n inside a code string is left alone', fixDoubleEscapedText('print("a\\nb")', 'x.py').fixed === 0);
check('JSON files are left alone', fixDoubleEscapedText('{"a":"x\\ny"}', 'x.json').fixed === 0);
check('text with real newlines is left alone', fixDoubleEscapedText('a\nb\\nc', 'x.txt').fixed === 0);
check('missing final newline is spelled out in wc terms', describeTextLine('one\ntwo\nthree') === '3 lines, 13 bytes; no newline at end, so `wc -l` reports 2', describeTextLine('one\ntwo\nthree'));
check('normal file reads plainly', describeTextLine('one\ntwo\nthree\n') === '3 lines, 14 bytes');

// ---------- unit: optional node-pty (H3) ----------
console.log('\n# node-pty optional');
const { ptyAvailable } = await import(`${SRC}/tools/terminal.ts`);
const { unavailableTools } = await import(`${SRC}/tools/index.ts`);
const ptyOk = ptyAvailable().ok;
const mainNames = enabledTools('main').map((t) => t.function.name);
check(`terminal tools ${ptyOk ? 'shown' : 'hidden'} to match node-pty (${ptyOk ? 'present' : 'missing'})`, mainNames.includes('terminal_open') === ptyOk, mainNames.filter((n) => n.startsWith('terminal_')).join(','));
check('shell_run stays available either way', mainNames.includes('shell_run'));
check('unavailable tools are reported with a reason', ptyOk ? Object.keys(unavailableTools()).length === 0 : /node-pty/.test(unavailableTools().terminal_open ?? ''), JSON.stringify(unavailableTools()).slice(0, 120));

// ---------- unit: plan shapes ----------
console.log('\n# update_plan shapes');
const p1 = normalizePlan({ steps: ['Create notes folder', 'Write notes/a.md', 'Remove notes directory'] })!;
check('plain strings keep their titles (was "Step 1/2/3")', p1.map((s) => s.title).join('|') === 'Create notes folder|Write notes/a.md|Remove notes directory');
const p2 = normalizePlan({ steps: ['[x] Make dir', '[ ] Write file', '- [>] Test'] })!;
check('checkbox markers set status', p2.map((s) => s.status).join(',') === 'done,pending,in_progress', p2.map((s) => s.status).join(','));
const p3 = normalizePlan({ plan: [{ step: 'A', status: 'completed' }, { task: 'B', status: 'in progress' }, { text: 'C', done: true }, { name: 'D' }] })!;
check('object synonyms and statuses', p3.map((s) => `${s.title}:${s.status}`).join(',') === 'A:done,B:in_progress,C:done,D:pending', p3.map((s) => `${s.title}:${s.status}`).join(','));

// ---------- A: native tool calls crash LM Studio's parser → switch to text and retry ----------
console.log('\n# A. Native tool-call parse error → text protocol');
requests.length = 0;
let r = await runWith(
  [
    midErr('Engine protocol predict stream returned an error: {"code":500,"message":"Invalid diff: now finding less tool calls!"}'),
    textCalls({ name: 'write_file', arguments: { path: 'hello.txt', content: 'LocalDex test\n' } }),
    say('Created hello.txt.'),
  ],
  'Create hello.txt containing "LocalDex test".',
);
check('run finished instead of erroring', r.res.reason === 'done', `${r.res.reason} ${r.res.error ?? ''}`);
check('file written after the fallback', fs.existsSync(path.join(DEMO, 'hello.txt')) && read('hello.txt') === 'LocalDex test\n');
check('model is now in text mode', lm.toolModeCache()['gemma-mock'] === 'text', JSON.stringify(lm.toolModeCache()));
check('the switch is logged', logs.some((l) => /Switched this model to the text tool protocol/.test(l)));
const streamed = requests.filter((b) => b.stream);
check('reasoning is switched off on tool steps (reasoning_effort: none)', streamed.length > 0 && streamed.every((b) => b.reasoning_effort === 'none'), streamed.map((b) => b.reasoning_effort).join(','));
check('the text retry did not send native tools', !streamed[streamed.length - 1].tools);

// ---------- B: write_file reports wc-style facts and repairs double escapes ----------
console.log('\n# B. write_file');
r = await runWith(
  [
    textCalls({ name: 'write_file', arguments: { path: 'goal/summary.txt', content: 'one\\ntwo\\nthree\\n' } }),
    say('Done.'),
  ],
  'Create goal/summary.txt with three lines.',
);
check('double-escaped content written as real lines', read('goal/summary.txt') === 'one\ntwo\nthree\n', JSON.stringify(read('goal/summary.txt')));
check('result tells the model what happened', /turned 3 literal/.test(toolResults(r.messages)[0]?.content ?? ''), toolResults(r.messages)[0]?.content);
r = await runWith([textCalls({ name: 'write_file', arguments: { path: 'no-eol.txt', content: 'one\ntwo\nthree' } }), say('ok')], 'w');
check('missing final newline is reported', /no newline at end, so `wc -l` reports 2/.test(toolResults(r.messages)[0]?.content ?? ''), toolResults(r.messages)[0]?.content);

// ---------- C: denied command is not asked again ----------
console.log('\n# C. Deny memory');
fs.mkdirSync(path.join(DEMO, 'notes'), { recursive: true });
approvals = 0;
approve = false;
r = await runWith(
  [
    textCalls({ name: 'shell_run', arguments: { command: 'rm -rf notes' } }),
    textCalls({ name: 'shell_run', arguments: { command: 'rm  -rf notes' } }),
    say('The user declined; notes/ was kept.'),
  ],
  'Delete notes.',
);
check('user was asked once', approvals === 1, `asked ${approvals}×`);
check('the repeat was refused without a prompt', toolResults(r.messages).length === 2 && toolResults(r.messages).every((m: any) => /Do not run it again/.test(m.content)));
check('notes/ still exists', fs.existsSync(path.join(DEMO, 'notes')));

// ---------- D: same call, same result → warn, then stop as stuck ----------
console.log('\n# D. Repeat breaker');
const same = textCalls({ name: 'read_file', arguments: { path: 'hello.txt' } });
r = await runWith([same, same, same, same, same, same, same], 'Read hello.txt until it changes.');
check('stops as stuck', r.res.reason === 'stuck', `${r.res.reason}: ${r.res.error}`);
check('warned before stopping', userNotes(r.messages).some((n) => /exactly the same arguments 3 times/.test(n)));
check('stopped at the 5th identical call', toolResults(r.messages).length === 5, `${toolResults(r.messages).length} calls`);

// ---------- E: runaway thinking → cut off and nudged; repeated → stuck ----------
console.log('\n# E. Runaway thinking');
r = await runWith([think(7000), textCalls({ name: 'list_dir', arguments: {} }), say('Listed.')], 'List the folder.');
check('cut off, nudged, then finished', r.res.reason === 'done' && userNotes(r.messages).some((n) => /thought for a long time without acting/.test(n)), r.res.reason);
r = await runWith([think(7000), think(7000), think(7000), think(7000)], 'Think forever.');
check('three cut-offs in a row = stuck', r.res.reason === 'stuck' && /thinking without acting/.test(r.res.error ?? ''), `${r.res.reason}: ${r.res.error}`);

// ---------- F: plan strings from a text call ----------
console.log('\n# F. update_plan through the loop');
plan = [];
r = await runWith([textCalls({ name: 'update_plan', arguments: { steps: ['Create notes folder', 'Write notes/a.md'] } }), say('Planned.')], 'Plan it.');
check('plan keeps the model\'s titles', plan.map((s) => s.title).join('|') === 'Create notes folder|Write notes/a.md', JSON.stringify(plan));
check('plan result reminds the model to tick steps', /call update_plan again/.test(toolResults(r.messages)[0]?.content ?? ''));

// ---------- G: reasoning switch only for models that have one ----------
console.log('\n# G. Reasoning switch');
requests.length = 0;
await lm.streamChat({ model: 'plain-mock', messages: [{ role: 'user', content: 'hi' }], tools: tools.slice(0, 2) });
check('no reasoning_effort for a model without a switch', requests.at(-1)?.reasoning_effort === undefined);
updateSettings({ reasoning: 'on' });
script = [say('hi')];
await lm.streamChat({ model: 'gemma-mock', messages: [{ role: 'user', content: 'hi' }], tools: tools.slice(0, 2) });
check('Reasoning "on" leaves it to the model', requests.at(-1)?.reasoning_effort === undefined);
updateSettings({ reasoning: 'auto' });
script = [say('summary')];
await lm.streamChat({ model: 'gemma-mock', messages: [{ role: 'user', content: 'sum' }], tools: [], reasoning: 'off' });
check('summaries/checkpoints ask for reasoning off in auto', requests.at(-1)?.reasoning_effort === 'none');

// ---------- H: verified file facts for compaction / goal checks ----------
console.log('\n# H. Verified file facts');
const facts = await verifiedFileFacts([
  { role: 'assistant', content: null, tool_calls: [
    { id: '1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'no-eol.txt', content: 'x' }) } },
    { id: '2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'gone.txt', content: 'x' }) } },
  ] },
] as any);
check('facts state real line counts', /no-eol\.txt: 3 lines, 13 bytes; no newline at end/.test(facts), facts);
check('facts flag missing files', /gone\.txt: does not exist/.test(facts));

// ---------- I: reload with a bigger context ----------
console.log('\n# I. Reload model');
const ctx = await lm.reloadModel('gemma-mock', 65536);
check('LM Studio load called with the context', loads.at(-1)?.context_length === 65536 && ctx === 65536);
const after = (await lm.listModels()).find((m: any) => m.id === 'gemma-mock');
check('model list shows the new context', after?.contextLength === 65536, String(after?.contextLength));

// ---------- K: corrupted native call (Gemma format breaks mid-run) → never executed, switch to text ----------
console.log('\n# K. Corrupted native call');
lm.toolModeCache(); // gemma-mock is in text mode after A; use a fresh model id for native
models.v0.data.push({ id: 'gemma-mock-2', type: 'llm', state: 'loaded', max_context_length: 262144, loaded_context_length: 32768 });
models.v1.models.push({ key: 'gemma-mock-2', type: 'llm', max_context_length: 262144, loaded_instances: [{ id: 'gemma-mock-2', config: { context_length: 32768 } }], capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } } } as any);
await lm.listModels();
r = await runWith(
  [
    () => ({ kind: 'stream', deltas: [{ tool_calls: [{ index: 0, id: 'bad1', type: 'function', function: { name: 'read_file', arguments: '{"path":"live/hello.txt**\n\nThe plan was updated after each step.\n<channel|><|tool_cal' } }] }], finish: 'tool_calls' }),
    textCalls({ name: 'read_file', arguments: { path: 'hello.txt' } }),
    say('Read it.'),
  ],
  'Read hello.txt.',
  'gemma-mock-2',
);
check('corrupted native call is not executed; retried in text mode', r.res.reason === 'done' && toolResults(r.messages).length === 1 && toolResults(r.messages)[0].ok === true, JSON.stringify(toolResults(r.messages).map((m: any) => m.content.slice(0, 60))));
check('model switched to text after the corrupt call', lm.toolModeCache()['gemma-mock-2'] === 'text');
r = await runWith([raw('<tool_call>{"name": "read_file", "arguments": {"path": "a<|\\"|>b"}}</tool_call>'), say('ok')], 'read', 'gemma-mock-2');
check('corrupt call in text mode is refused, not run', toolResults(r.messages)[0]?.ok === false && /malformed/.test(toolResults(r.messages)[0]?.content ?? ''));

// ---------- K2: structure leaked into short fields (valid JSON, still broken) ----------
console.log('\n# K2. Structure leaks');
const call = (name: string, args: unknown) => ({ id: 'x', type: 'function' as const, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
check('leaked "**},{status:" in a plan title is corrupt', lm.isCorruptCall(call('update_plan', { steps: [{ status: 'done', title: 'Create notes2 folder**},{status:' }] })));
check('numeric plan status is corrupt', lm.isCorruptCall(call('update_plan', { steps: [{ status: 1395674847 }] })));
check('newline in a path is corrupt', lm.isCorruptCall(call('read_file', { path: 'a.txt\n\nThe plan was updated' })));
check('JSON inside file content is fine', !lm.isCorruptCall(call('write_file', { path: 'a.json', content: '[{"a":1}, {"name": "x"}]' })));
check('normal plan is fine', !lm.isCorruptCall(call('update_plan', { steps: [{ title: 'Write file', status: 'done' }, { title: 'Test', status: 'pending' }] })));
check('switch to text is remembered on disk', JSON.parse(fs.readFileSync(path.join(process.env.LOCALDEX_HOME!, 'text-tool-models.json'), 'utf8')).includes('gemma-mock-2'));

// ---------- L2: finishing with plan steps open gets pushed back once ----------
console.log('\n# L2. Unfinished plan gate');
r = await runWith(
  [
    textCalls({ name: 'update_plan', arguments: { steps: [{ title: 'Write a.txt', status: 'pending' }, { title: 'Run cat', status: 'pending' }] } }),
    say('All done: wrote a.txt and ran cat.'),
    textCalls({ name: 'write_file', arguments: { path: 'gate.txt', content: 'x\n' } }),
    say('Wrote gate.txt; did not run cat.'),
  ],
  'Plan then do.',
);
check('premature "done" with open plan steps is challenged', userNotes(r.messages).some((n) => /plan still has unfinished steps/.test(n)) && fs.existsSync(path.join(DEMO, 'gate.txt')), r.res.text);

// ---------- L: finishing right after a failure gets pushed back once ----------
console.log('\n# L. Finish gate');
r = await runWith(
  [textCalls({ name: 'read_file', arguments: { path: 'does-not-exist.txt' } }), say('All steps done!'), say('The read failed: does-not-exist.txt is missing.')],
  'Read does-not-exist.txt.',
);
check('false "done" after a failed call is challenged', userNotes(r.messages).some((n) => /last tool call failed/.test(n)) && /failed/.test(r.res.text), r.res.text);

// ---------- J: runner notes a stuck run and offers / performs the hand-over ----------
console.log('\n# J. Runner: stuck → council');
const { runnerFor } = await import(`${SRC}/agent/runner.ts`);
const { createSession } = await import(`${SRC}/store.ts`);
updateSettings({ council: { enabled: true, autoEscalate: 'suggest' } as any });
const s1 = createSession('gemma-mock');
script = [same, same, same, same, same, same];
await runnerFor(s1).handleUserMessage('Read hello.txt until it changes.');
const last1 = s1.messages.at(-1);
check('stuck run leaves a visible note', last1?.role === 'user' && /^\[system\] Run stopped: the local model got stuck/.test(last1.content), last1?.content?.slice(0, 80));
check('note points at Hand to council', /Hand to council/.test(last1?.content ?? ''));

updateSettings({ council: { enabled: true, autoEscalate: 'auto' } as any });
const s2 = createSession('gemma-mock');
script = [same, same, same, same, same, same];
const runner2 = runnerFor(s2);
await runner2.handleUserMessage('Read hello.txt until it changes.');
for (let i = 0; i < 200 && !s2.messages.some((m: any) => m.role === 'user' && m.content.startsWith('[Handed to council')); i++) await new Promise((r) => setTimeout(r, 50));
check('auto: request handed to the council by itself', s2.messages.some((m: any) => m.role === 'user' && m.content.startsWith('[Handed to council')));
for (let i = 0; i < 400 && runner2.running; i++) await new Promise((r) => setTimeout(r, 50));
updateSettings({ council: { enabled: false } as any });

// ---------- M: oversized tool output is saved to a file, head + tail + path stay inline (C1) ----------
console.log('\n# M. Spill');
{
  const { inlineBudgetChars, spillDir, SPILL_DIR } = await import(`${SRC}/spill.ts`);
  const { resolvePath } = await import(`${SRC}/tools/permissions.ts`);
  const { getSettings } = await import(`${SRC}/config.ts`);
  const prevCtxLen = getSettings().contextLength;
  updateSettings({ contextLength: 32768 });
  const budget = inlineBudgetChars('gemma-mock');
  check('budget: 32k window → 30% of it × 4 chars', budget === Math.floor(32768 * 0.3) * 4, String(budget));
  check('budget: unknown model falls back to a 32k window', inlineBudgetChars('nope') === budget);
  approve = true;
  // 500 KB of numbered lines from a shell command.
  r = await runWith([textCalls({ name: 'shell_run', arguments: { command: "node -e \"for(let i=1;i<=20000;i++)console.log('line '+i+' '+'x'.repeat(16))\"" } }), say('done')], 'Print a lot.');
  const out = toolResults(r.messages)[0]?.content ?? '';
  const saved = /Full output: (\S+)\./.exec(out)?.[1] ?? '';
  check('spill: inline result stays under the budget', out.length <= budget + 400 && out.length > budget / 2, `len=${out.length} budget=${budget}`);
  check('spill: shows head and tail with a marker between', /line 1 x/.test(out) && /line 20000 x/.test(out) && /\[\.\.\.\]/.test(out) && /showing start and end/.test(out));
  check('spill: full output saved under the session spill folder', saved.startsWith(spillDir('t')) && fs.existsSync(saved) && fs.readFileSync(saved, 'utf8').split('\n').length > 20000, saved);
  check('spill: file is private to LocalDex (not in the approved folder)', !saved.startsWith(DEMO) && saved.startsWith(SPILL_DIR));
  // The model can read the saved file back with read_file (paginated to the window) and grep it, but never write there.
  r = await runWith([textCalls({ name: 'read_file', arguments: { path: saved, start_line: 19990 } }), say('ok')], 'Read the rest.');
  const tail = toolResults(r.messages)[0]?.content ?? '';
  check('spill: read_file may read the saved file', /\| line 19990 x/.test(tail) && /\| line 20000 x/.test(tail) && !/outside the approved folders/.test(tail), tail.slice(0, 200));
  r = await runWith([textCalls({ name: 'grep', arguments: { pattern: 'line 12345 ', path: saved } }), say('ok')], 'Find it.');
  check('spill: grep may search the saved file', /line 12345 x/.test(toolResults(r.messages)[0]?.content ?? ''), toolResults(r.messages)[0]?.content.slice(0, 200));
  let threw = '';
  try { resolvePath(saved); } catch (e) { threw = (e as Error).message; }
  check('spill: writes to the spill folder are refused', /outside the approved folders|protected pattern/.test(threw), threw);
  try { resolvePath(path.join(SPILL_DIR, '..', 'config.json'), { read: true }); threw = ''; } catch (e) { threw = (e as Error).message; }
  check('spill: read exception does not open the rest of ~/.localdex', /outside the approved folders|protected pattern/.test(threw), threw);
  // read_file on a big project file: cut at a line boundary with a "continue at" hint, no file of a file.
  fs.writeFileSync(path.join(DEMO, 'big.log'), Array.from({ length: 5000 }, (_, i) => `entry ${i + 1} ${'y'.repeat(40)}`).join('\n') + '\n');
  r = await runWith([textCalls({ name: 'read_file', arguments: { path: 'big.log' } }), say('ok')], 'Read big.log.');
  const big = toolResults(r.messages)[0]?.content ?? '';
  const next = Number(/start_line=(\d+)/.exec(big)?.[1] ?? 0);
  check('read_file: stops at the budget with a continue hint', big.length <= budget + 400 && next > 1 && next < 5000 && /entry 1 y/.test(big) && !/Full output:/.test(big), `len=${big.length} next=${next}`);
  check('read_file: hint names the first unread line', next > 0 && !new RegExp(`\\n\\s*${next}\\| entry ${next} `).test(big) && new RegExp(`\\n\\s*${next - 1}\\| entry ${next - 1} `).test(big));
  // Deleting the session removes its saved outputs.
  const { deleteSpill } = await import(`${SRC}/spill.ts`);
  deleteSpill('t');
  check('spill: deleted with the session', !fs.existsSync(spillDir('t')));
  approve = false;
  updateSettings({ contextLength: prevCtxLen });
}

// ---------- N: read before edit + stale check (S1) ----------
console.log('\n# N. Read before edit');
{
  const { resetReads } = await import(`${SRC}/tools/readTracker.ts`);
  const { getSettings } = await import(`${SRC}/config.ts`);
  check('setting defaults to on', getSettings().requireReadBeforeEdit === true);
  fs.writeFileSync(path.join(DEMO, 'guarded.txt'), 'alpha\nbeta\n');
  resetReads('t');
  const first = (x: any) => toolResults(x.messages)[0]?.content ?? '';
  // Edit without a read: refused with the exact wording.
  r = await runWith([textCalls({ name: 'edit_file', arguments: { path: 'guarded.txt', old_string: 'beta', new_string: 'gamma' } }), say('ok')], 'edit');
  check('edit without a read is refused', first(r) === `cannot modify "${path.join(DEMO, 'guarded.txt')}": file has not been read — read the file, then retry` && read('guarded.txt') === 'alpha\nbeta\n', first(r));
  r = await runWith([textCalls({ name: 'write_file', arguments: { path: 'guarded.txt', content: 'zzz\n' } }), say('ok')], 'write');
  check('overwrite without a read is refused', /has not been read/.test(first(r)) && read('guarded.txt') === 'alpha\nbeta\n', first(r));
  // Read → edit → edit works (the first edit refreshes the record).
  r = await runWith([
    textCalls({ name: 'read_file', arguments: { path: 'guarded.txt' } }),
    textCalls({ name: 'edit_file', arguments: { path: 'guarded.txt', old_string: 'beta', new_string: 'gamma' } }),
    textCalls({ name: 'edit_file', arguments: { path: 'guarded.txt', old_string: 'alpha', new_string: 'omega' } }),
    say('ok'),
  ], 'edit twice');
  check('read → edit → edit succeeds', toolResults(r.messages).every((m: any) => m.ok) && read('guarded.txt') === 'omega\ngamma\n', toolResults(r.messages).map((m: any) => m.content.slice(0, 60)).join(' | '));
  // Changed outside LocalDex after the read: refused until re-read.
  r = await runWith([
    textCalls({ name: 'read_file', arguments: { path: 'guarded.txt' } }),
    (() => { fs.writeFileSync(path.join(DEMO, 'guarded.txt'), 'omega\ngamma\nouter edit\n'); return textCalls({ name: 'edit_file', arguments: { path: 'guarded.txt', old_string: 'gamma', new_string: 'delta' } })(); }) as Step,
    textCalls({ name: 'read_file', arguments: { path: 'guarded.txt' } }),
    textCalls({ name: 'edit_file', arguments: { path: 'guarded.txt', old_string: 'gamma', new_string: 'delta' } }),
    say('ok'),
  ], 'edit after outside change');
  const tr = toolResults(r.messages);
  check('file changed externally is refused with the exact wording', tr[1]?.content === `cannot modify "${path.join(DEMO, 'guarded.txt')}": file changed since it was read — re-read the file, then retry`, tr[1]?.content);
  check('re-read, then the edit goes through', tr[3]?.ok === true && read('guarded.txt') === 'omega\ndelta\nouter edit\n');
  // New files need no read; reading a missing path also allows creating it; same-size edits are caught (sha1, not size).
  r = await runWith([textCalls({ name: 'write_file', arguments: { path: 'fresh.txt', content: 'new\n' } }), say('ok')], 'create');
  check('creating a new file needs no read', first(r).startsWith('Created') && read('fresh.txt') === 'new\n', first(r));
  r = await runWith([
    textCalls({ name: 'read_file', arguments: { path: 'fresh.txt' } }),
    (() => { fs.writeFileSync(path.join(DEMO, 'fresh.txt'), 'old\n'); return textCalls({ name: 'write_file', arguments: { path: 'fresh.txt', content: 'mine\n' } })(); }) as Step,
    say('ok'),
  ], 'same size');
  check('a same-size outside change is still caught', /changed since it was read/.test(toolResults(r.messages)[1]?.content ?? '') && read('fresh.txt') === 'old\n');
  // Compact & Resume forgets the reads.
  r = await runWith([textCalls({ name: 'read_file', arguments: { path: 'fresh.txt' } }), say('ok')], 'read');
  resetReads('t', 'main');
  r = await runWith([textCalls({ name: 'edit_file', arguments: { path: 'fresh.txt', old_string: 'old', new_string: 'x' } }), say('ok')], 'edit after compact');
  check('records reset (compact) → read again first', /has not been read/.test(first(r)));
  // Off switch.
  updateSettings({ requireReadBeforeEdit: false });
  r = await runWith([textCalls({ name: 'edit_file', arguments: { path: 'fresh.txt', old_string: 'old', new_string: 'x' } }), say('ok')], 'edit with the check off');
  check('setting off: blind edits allowed', first(r).startsWith('Edited') && read('fresh.txt') === 'x\n', first(r));
  updateSettings({ requireReadBeforeEdit: true });
}

// ---------- O: per-turn checkpoints + Undo this turn (S2) ----------
console.log('\n# O. Checkpoints and undo');
{
  const { execSync } = await import('node:child_process');
  const { beginTurn, endTurn, undoTurn, turnDiff, deleteCheckpoints, CHECKPOINT_DIR } = await import(`${SRC}/checkpoints.ts`);
  const { resetReads } = await import(`${SRC}/tools/readTracker.ts`);
  const sh = (cmd: string, cwd = DEMO) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sess = (id: string): any => ({ id, turns: [] });
  approve = true;
  updateSettings({ requireReadBeforeEdit: false });

  // --- git folder: a file-tool edit, a file-tool create and a shell edit, with the user's own staged change left alone.
  sh('git init -q && git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm init');
  fs.writeFileSync(path.join(DEMO, 'staged.txt'), 'mine\n');
  sh('git add staged.txt');
  const stagedBefore = sh('git diff --cached --name-only');
  fs.writeFileSync(path.join(DEMO, 'keep.txt'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(DEMO, 'shelled.txt'), 'a\n');
  let s = sess('t');
  let cp = beginTurn('t');
  check('git: turn opened', !!cp && cp.folder === fs.realpathSync(DEMO), cp?.folder);
  r = await runWith([
    textCalls({ name: 'edit_file', arguments: { path: 'keep.txt', old_string: 'line2', new_string: 'LINE TWO\nline2b' } }),
    textCalls({ name: 'write_file', arguments: { path: 'made.txt', content: 'brand new\n' } }),
    textCalls({ name: 'shell_run', arguments: { command: "printf 'b\\n' >> shelled.txt" } }),
    say('done'),
  ], 'change things');
  let done = endTurn(s);
  const rels = (x: any) => x.files.map((f: any) => `${f.rel}:${f.kind}:+${f.added}-${f.removed}`).sort().join(' ');
  check('git: changed files listed with +/- (tool edits and the shell edit)', !!done && rels(done) === 'keep.txt:modified:+2-1 made.txt:added:+1-0 shelled.txt:modified:+1-0', done ? rels(done) : 'null');
  check('git: staged.txt (untouched) is not listed; user index untouched', !done!.files.some((f: any) => f.rel === 'staged.txt') && sh('git diff --cached --name-only') === stagedBefore && sh('git status --porcelain staged.txt').startsWith('A '));
  check('git: checkpoint stored on disk and on the session', s.turns.length === 1 && fs.existsSync(path.join(CHECKPOINT_DIR, 't', done!.id, 'meta.json')));
  const d = turnDiff('t', done!.id);
  check('git: diff viewer shows project-relative headers and the change', /^diff --git a\/keep\.txt b\/keep\.txt$/m.test(d) && /^\+LINE TWO$/m.test(d) && /^-line2$/m.test(d) && /^\+\+\+ b\/made\.txt$/m.test(d) && !/\/tmp\//.test(d.split('\n').filter((l) => l.startsWith('diff') || l.startsWith('---') || l.startsWith('+++')).join('\n')), d.slice(0, 300));
  let u = undoTurn(s, done!.id);
  check('git: undo restores the edit, removes the created file, reverts the shell edit', u.ok && read('keep.txt') === 'line1\nline2\nline3\n' && !fs.existsSync(path.join(DEMO, 'made.txt')) && read('shelled.txt') === 'a\n' && s.turns[0].undone === true, u.error);
  check('git: undo twice is refused', !undoTurn(s, done!.id).ok);

  // --- undo refused when a file changed after the turn (nothing restored).
  s = sess('t'); beginTurn('t');
  r = await runWith([textCalls({ name: 'write_file', arguments: { path: 'keep.txt', content: 'turn wrote this\n' } }), textCalls({ name: 'write_file', arguments: { path: 'other.txt', content: 'also\n' } }), say('ok')], 'w');
  done = endTurn(s);
  fs.writeFileSync(path.join(DEMO, 'keep.txt'), 'turn wrote this\nand the user added a line\n');
  u = undoTurn(s, done!.id);
  check('refused: a file changed after the turn → refused with the file named, nothing touched', !u.ok && /keep\.txt changed after this turn ended/.test(u.error ?? '') && read('other.txt') === 'also\n' && !s.turns[0].undone, u.error);
  fs.writeFileSync(path.join(DEMO, 'keep.txt'), 'turn wrote this\n');
  check('refused: once the file is back as the turn left it, undo works', undoTurn(s, done!.id).ok && read('keep.txt') === 'line1\nline2\nline3\n' && !fs.existsSync(path.join(DEMO, 'other.txt')));

  // --- a turn that changes nothing leaves no checkpoint.
  s = sess('t'); beginTurn('t');
  r = await runWith([textCalls({ name: 'read_file', arguments: { path: 'keep.txt' } }), say('ok')], 'read');
  check('no changes → no checkpoint', endTurn(s) === null && s.turns.length === 0);

  // --- non-git folder: file-tool edits are tracked through the before-copies.
  const plain = fs.mkdtempSync(path.join(path.dirname(DEMO), 'plain-'));
  fs.writeFileSync(path.join(plain, 'notes.md'), '# notes\n');
  const prevFolders = (await import(`${SRC}/config.ts`)).getSettings().approvedFolders;
  updateSettings({ approvedFolders: [plain] });
  s = sess('t'); cp = beginTurn('t');
  r = await runWith([
    textCalls({ name: 'edit_file', arguments: { path: 'notes.md', old_string: '# notes', new_string: '# Notes\n\nmore' } }),
    textCalls({ name: 'write_file', arguments: { path: 'sub/new.txt', content: 'x\ny\n' } }),
    say('ok'),
  ], 'edit in a plain folder');
  done = endTurn(s);
  check('non-git: changed files listed', !!done && rels(done) === 'notes.md:modified:+3-1 sub/new.txt:added:+2-0', done ? rels(done) : 'null');
  u = undoTurn(s, done!.id);
  check('non-git: undo after an edit and after a write', u.ok && fs.readFileSync(path.join(plain, 'notes.md'), 'utf8') === '# notes\n' && !fs.existsSync(path.join(plain, 'sub/new.txt')), u.error);
  deleteCheckpoints('t');
  check('deleted with the session', !fs.existsSync(path.join(CHECKPOINT_DIR, 't')));
  updateSettings({ approvedFolders: prevFolders, requireReadBeforeEdit: true });
  resetReads('t');
  approve = false;
}

// ---------- P: prune old tool results before summarizing (C2) ----------
console.log('\n# P. Prune before summarize');
{
  const { maybeCompactMain, pruneToolResults, PRUNE_MARK } = await import(`${SRC}/agent/compact.ts`);
  const { getSettings } = await import(`${SRC}/config.ts`);
  const prevCtxLen = getSettings().contextLength;
  const prevThreshold = getSettings().autoCompactThreshold;
  const sess = createSession('gemma-mock');
  sess.messages.push({ role: 'system', content: 'sys' }, { role: 'user', content: 'start', ts: 1 });
  const big = (n: number) => `${'result line\n'.repeat(1_200)}END-${n}`; // ~14.4k chars each
  for (let i = 0; i < 6; i++) {
    sess.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'shell_run', arguments: '{}' } }], ts: 2 });
    sess.messages.push({ role: 'tool', tool_call_id: `c${i}`, name: 'shell_run', content: big(i), ts: 3 });
  }
  sess.messages.push({ role: 'user', content: 'latest request', ts: 4 });
  sess.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'shell_run', arguments: '{}' } }], ts: 5 });
  sess.messages.push({ role: 'tool', tool_call_id: 'c9', name: 'shell_run', content: big(9), ts: 6 });
  // ~100k chars ≈ 29k tokens estimated; a 32k window at 0.8 → threshold ~26k tokens → over. After pruning ≈ 10k tokens → under.
  updateSettings({ contextLength: 32768, autoCompactThreshold: 0.8 });
  const before = requests.length;
  script = [say('SUMMARY (should not be asked)')];
  await maybeCompactMain(sess, new AbortController().signal);
  const tools = sess.messages.filter((m: any) => m.role === 'tool') as any[];
  check('prune: old results shortened to head + marker + tail', tools.slice(0, 6).every((m) => m.content.includes(PRUNE_MARK) && m.content.startsWith('result line') && m.content.endsWith(`END-${tools.indexOf(m)}`) && m.content.length < 5_300), String(tools[0].content.length));
  check('prune: the latest turn is left alone', !tools[6].content.includes(PRUNE_MARK) && tools[6].content.length > 14_000);
  check('prune: originals kept in the session log', tools.slice(0, 6).every((m) => typeof m.original === 'string' && m.original.length > 14_000));
  check('prune: no summary call was made and no compaction', requests.length === before && sess.compactions === 0 && sess.messages.some((m: any) => m.role === 'user' && m.content === 'start'));
  check('prune: logged the saving', logs.some((l) => /pruned 6 old tool results, saved ~\d+ tokens; no summary needed/.test(l)));
  // Second pass: nothing new to prune, and already-pruned results are not pruned again.
  check('prune: idempotent', pruneToolResults(sess.messages).pruned === 0);
  script = [];
  updateSettings({ contextLength: prevCtxLen, autoCompactThreshold: prevThreshold });
}

// ---------- Q: stable system prompt + appended clock (C3) ----------
console.log('\n# Q. Stable prompt prefix');
{
  const { createHash } = await import('node:crypto');
  const { mainSystemPrompt, CLOCK_PREFIX } = await import(`${SRC}/agent/prompts.ts`);
  const h = (t: string) => createHash('sha1').update(t).digest('hex');
  check('system prompt has no date', !/\bDate:/.test(mainSystemPrompt()));
  check('system prompt is byte-identical across builds', h(mainSystemPrompt()) === h(mainSystemPrompt()));
  const sess = createSession('gemma-mock');
  const rn = runnerFor(sess);
  script = [say('one')];
  await rn.handleUserMessage('first');
  const sysHash = h((sess.messages[0] as any).content);
  const clocks = () => sess.messages.filter((m: any) => m.role === 'user' && m.content.startsWith(CLOCK_PREFIX));
  check('clock appended once as a context line', clocks().length === 1 && /\d{4}/.test(clocks()[0].content), clocks()[0]?.content);
  script = [textCalls({ name: 'read_file', arguments: { path: 'hello.txt' } }), say('two')];
  await rn.handleUserMessage('second');
  check('system prompt unchanged across steps and turns (hash)', h((sess.messages[0] as any).content) === sysHash && !logs.some((l) => /system prompt changed/.test(l)));
  check('no second clock line within 10 minutes', clocks().length === 1);
  (clocks()[0] as any).ts = Date.now() - 11 * 60_000;
  script = [say('three')];
  await rn.handleUserMessage('third');
  check('a new clock line after 10 minutes', clocks().length === 2);
  // Toggling a tool changes the prompt once, and says so.
  const prevCaps = (await import(`${SRC}/config.ts`)).getSettings().capabilities;
  updateSettings({ capabilities: { ...prevCaps, glob: false } });
  script = [say('four')];
  await rn.handleUserMessage('fourth');
  check('tool set change rebuilds the prompt and logs the cache reset', h((sess.messages[0] as any).content) !== sysHash && logs.some((l) => /system prompt changed/.test(l)));
  updateSettings({ capabilities: prevCaps });
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
