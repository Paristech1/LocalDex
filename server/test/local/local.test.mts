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
const tools = enabledTools('main');
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

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
