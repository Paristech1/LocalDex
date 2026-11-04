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
  | { kind: 'midStreamError'; message: string; partial?: string };
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
const midErr = (message: string, partial?: string): Step => () => ({ kind: 'midStreamError', message, partial });

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
let failNext = 0; // answer this many chat requests with HTTP 503 before any token

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
    if (failNext > 0) {
      failNext--;
      return json({ error: { message: 'Model is loading', type: 'server_error' } }, 503);
    }
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
      chunk({ role: 'assistant', content: reply.partial ?? '' });
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
  const res = await runLoop({ sessionId: 't', agent: 'main', model, messages, tools: enabledTools('main', { model }), signal: ac.signal, maxSteps: 20, updatePlan: (s: any[]) => (plan = s) });
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

// ---------- R: project instruction files (C4) ----------
console.log('\n# R. Project instructions');
{
  const { mainSystemPrompt, workerSystemPrompt } = await import(`${SRC}/agent/prompts.ts`);
  const { GLOBAL_INSTRUCTIONS, PROJECT_BUDGET, forgetInstructions } = await import(`${SRC}/agent/instructions.ts`);
  const { getSettings } = await import(`${SRC}/config.ts`);
  check('setting defaults to on', getSettings().projectInstructions === true);
  check('no files → no section', !/Project instructions \(/.test(mainSystemPrompt()));
  fs.writeFileSync(path.join(DEMO, 'AGENTS.md'), '# Demo conventions\nUse tabs. Run `npm test` before reporting done.\n');
  fs.writeFileSync(path.join(DEMO, 'CLAUDE.md'), 'CLAUDE ONLY\n');
  fs.writeFileSync(GLOBAL_INSTRUCTIONS, 'Always answer in British English.\n');
  const sp = mainSystemPrompt();
  check('project AGENTS.md text is in the system prompt (AGENTS.md wins over CLAUDE.md)', /Project instructions \(.*AGENTS\.md\):\n# Demo conventions\nUse tabs\./.test(sp) && !/CLAUDE ONLY/.test(sp));
  check('global ~/.localdex/AGENTS.md is in the system prompt too, before the project one', sp.indexOf('Always answer in British English.') > 0 && sp.indexOf('Always answer in British English.') < sp.indexOf('# Demo conventions'));
  check('workers get the instructions as well', /Use tabs\./.test(workerSystemPrompt('w1')));
  // 50 KB file: truncated to the budget with a notice.
  fs.writeFileSync(path.join(DEMO, 'AGENTS.md'), `# Big\n${'rule line that goes on and on\n'.repeat(1_700)}`);
  const big = mainSystemPrompt();
  const section = big.slice(big.indexOf('Project instructions ('));
  check('50 KB file is truncated with a notice', /only the first 8192 are loaded/.test(section) && section.length < PROJECT_BUDGET + 600, String(section.length));
  // Nested file: appended as context when the agent works in that subfolder, once.
  fs.writeFileSync(path.join(DEMO, 'AGENTS.md'), '# Demo conventions\nUse tabs.\n');
  fs.mkdirSync(path.join(DEMO, 'pkg/api'), { recursive: true });
  fs.writeFileSync(path.join(DEMO, 'pkg/api/AGENTS.md'), 'API rules: every route needs a test.\n');
  fs.writeFileSync(path.join(DEMO, 'pkg/api/routes.ts'), 'export const r = 1;\n');
  const sess = createSession('gemma-mock');
  const rn = runnerFor(sess);
  script = [textCalls({ name: 'read_file', arguments: { path: 'pkg/api/routes.ts' } }), textCalls({ name: 'read_file', arguments: { path: 'pkg/api/routes.ts' } }), say('ok')];
  await rn.handleUserMessage('look at the api');
  const nested = sess.messages.filter((m: any) => m.role === 'user' && /^\[context\] Instructions for pkg\/api\//.test(m.content));
  check('nested AGENTS.md appended once as context after the agent touched the folder', nested.length === 1 && /every route needs a test/.test(nested[0].content), String(nested.length));
  check('nested file is not in the system prompt (prefix stays stable)', !/every route needs a test/.test((sess.messages[0] as any).content));
  const idx = sess.messages.indexOf(nested[0]);
  check('context line arrives after the tool result that touched the folder', sess.messages.slice(0, idx).some((m: any) => m.role === 'tool'));
  // Off switch.
  updateSettings({ projectInstructions: false });
  check('setting off: nothing loaded', !/Use tabs\./.test(mainSystemPrompt()));
  updateSettings({ projectInstructions: true });
  fs.rmSync(path.join(DEMO, 'AGENTS.md')); fs.rmSync(path.join(DEMO, 'CLAUDE.md')); fs.rmSync(GLOBAL_INSTRUCTIONS); fs.rmSync(path.join(DEMO, 'pkg'), { recursive: true });
  forgetInstructions(sess.id);
}

// ---------- S: LM Studio retry (U6) ----------
console.log('\n# S. Retry requests that fail before any token; never after a partial stream');
{
  const { RETRY_DELAYS_MS, isTransientError } = lm;
  check('backoff is 1s / 3s / 8s', JSON.stringify(RETRY_DELAYS_MS) === '[1000,3000,8000]', JSON.stringify(RETRY_DELAYS_MS));
  check('5xx, dropped connections and "model is loading" are transient', isTransientError({ status: 503 }) && isTransientError({ code: 'ECONNRESET' }) && isTransientError(new Error('fetch failed')) && isTransientError(new Error('Model is loading')));
  check('4xx and ordinary errors are not', !isTransientError({ status: 400, message: 'bad request' }) && !isTransientError(new Error('Invalid diff: now finding less tool calls!')));
  // One HTTP 503 before any token: retried once after 1 s, the run completes as if nothing happened.
  logs.length = 0; requests.length = 0; failNext = 1;
  const t0 = Date.now();
  r = await runWith([say('after the hiccup')], 'hi');
  const took = Date.now() - t0;
  check('run completed after a 503 before any token', r.res.reason === 'done' && /after the hiccup/.test(r.messages[r.messages.length - 1].content), `${r.res.reason} ${r.res.error ?? ''}`);
  check('the request was sent twice (one failure, one success)', requests.filter((b) => b.stream).length === 2, String(requests.filter((b) => b.stream).length));
  check('waited about 1 s before the retry', took >= 950 && took < 2_800, `${took}ms`);
  check('the retry is logged with its attempt number', logs.some((l) => /failed before any token arrived .*retry 1\/3 in 1s/.test(l)), logs.filter((l) => /retry/.test(l)).join(' | '));
  check('no second retry was needed', !logs.some((l) => /retry 2\/3/.test(l)));
  // A transient-looking error after tokens were streamed: not retried (a retry would replay the shown tokens).
  logs.length = 0; requests.length = 0;
  r = await runWith([midErr('Service unavailable', 'Here is the start of an answer'), say('(should not be reached by a retry)')], 'hi');
  check('a stream that already produced tokens is not retried', !logs.some((l) => /retry \d\/3/.test(l)), logs.filter((l) => /retry/.test(l)).join(' | '));
  check('that error surfaces instead', r.res.reason !== 'done' || r.leftover >= 1, `${r.res.reason} leftover=${r.leftover}`);
  failNext = 0;
}

// ---------- T: Plan mode (A4) ----------
console.log('\n# T. Plan mode: /plan is read-only until approved, survives a reload');
{
  const { isReadOnlyCommand, PLAN_TOOLS } = await import(`${SRC}/agent/planMode.ts`);
  const { SESSIONS_DIR } = await import(`${SRC}/config.ts`);
  const ro = ['ls -la src', 'cat a.txt | head -20', 'rg -n "foo" src && wc -l src/*.ts', 'git status', 'git log --oneline -5', 'git diff HEAD~1 -- src/a.ts', 'find . -name "*.ts"', 'npm ls --depth=0', 'node --version', 'sed -n 1,20p a.ts', 'echo hi 2>/dev/null', 'git branch -a'];
  const rw = ['rm -rf dist', 'echo x > a.txt', 'cat a | tee b', 'sed -i "s/a/b/" a.ts', 'find . -name "*.log" -delete', 'git checkout -- .', 'git branch -D old', 'git stash pop', 'npm install', 'npm test', 'node script.js', 'ls $(rm -rf x)', 'mkdir -p a', 'touch a', 'cp a b', 'python3 -c "print(1)"', 'ls; rm a'];
  check('read-only commands pass', ro.every(isReadOnlyCommand), ro.filter((c) => !isReadOnlyCommand(c)).join(' | '));
  check('commands that could write are refused', rw.every((c) => !isReadOnlyCommand(c)), rw.filter(isReadOnlyCommand).join(' | '));
  const planNames = enabledTools('main', { planMode: true }).map((t) => t.function.name);
  check('plan mode offers only the read-only tool set', planNames.every((n) => PLAN_TOOLS.has(n)) && ['read_file', 'grep', 'shell_run', 'update_plan'].every((n) => planNames.includes(n)) && !planNames.includes('write_file') && !planNames.includes('edit_file') && !planNames.includes('delegate_to_worker'), planNames.join(','));

  fs.writeFileSync(path.join(DEMO, 'greet.ts'), 'export const greet = () => "hi";\n');
  const sess = createSession('gemma-mock');
  const rn = runnerFor(sess);
  logs.length = 0;
  script = [
    textCalls({ name: 'read_file', arguments: { path: 'greet.ts' } }),
    // The model tries to edit anyway, and to run a build: both refused.
    textCalls({ name: 'edit_file', arguments: { path: 'greet.ts', old_string: '"hi"', new_string: '"hello"' } }, { name: 'shell_run', arguments: { command: 'npm run build' } }),
    textCalls({ name: 'shell_run', arguments: { command: 'git status --short' } }),
    say('Plan: change the greeting. Risks: none.'), // ended without update_plan → nudged once
    textCalls({ name: 'update_plan', arguments: { steps: [{ title: 'Edit greet.ts: return "hello"', status: 'pending' }, { title: 'Run the tests', status: 'pending' }] } }),
    say('Summary: change greet.ts to return "hello", then run the tests.'),
  ];
  await rn.handleUserMessage('/plan make greet say hello');
  const toolLine = (m: any) => (m.content as string).split('\n').find((l: string) => l.startsWith('Tools available to you')) ?? '';
  check('system prompt lists only the plan tools', !/write_file/.test(toolLine(sess.messages[0])) && /read_file/.test(toolLine(sess.messages[0])), toolLine(sess.messages[0]));
  const tr = sess.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);
  check('edit_file refused in plan mode, file untouched', tr.some((t) => /^Plan mode: this tool is not available/.test(t)) && read('greet.ts').includes('"hi"'));
  check('mutating shell command refused, read-only one ran', tr.some((t) => /^Plan mode: shell_run only runs read-only/.test(t)) && tr.some((t) => /\$ git status --short/.test(t)), tr.map((t) => t.slice(0, 40)).join(' | '));
  check('ending without update_plan is nudged once', logs.some((l) => /plan mode: the run ended without update_plan/.test(l)) && sess.messages.some((m: any) => m.role === 'user' && /^\[system\] Plan mode: you have not called update_plan/.test(m.content)));
  check('plan awaits review with its steps and summary', sess.planMode?.status === 'review' && sess.plan.length === 2 && /return "hello"/.test(sess.planMode?.summary ?? ''), JSON.stringify(sess.planMode));
  check('"plan steps still open" gate did not fire in plan mode', !sess.messages.some((m: any) => m.role === 'user' && /plan still has unfinished steps/.test(m.content)));
  // Survives a reload: the state is in the session file.
  await new Promise((r) => setTimeout(r, 400));
  const onDisk = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${sess.id}.json`), 'utf8'));
  check('plan mode is persisted with the session', onDisk.planMode?.status === 'review' && onDisk.planMode?.task === 'make greet say hello');
  // A plain message while the plan awaits approval is feedback: still read-only.
  script = [
    textCalls({ name: 'write_file', arguments: { path: 'x.txt', content: 'nope' } }),
    textCalls({ name: 'update_plan', arguments: { steps: [{ title: 'Edit greet.ts: return "hello"', status: 'pending' }, { title: 'Add a test for greet', status: 'pending' }, { title: 'Run the tests', status: 'pending' }] } }),
    say('Updated: added a test step.'),
  ];
  await rn.handleUserMessage('also add a test');
  check('feedback keeps plan mode, counts a revision, write still refused', sess.planMode?.status === 'review' && sess.planMode?.revisions === 1 && !fs.existsSync(path.join(DEMO, 'x.txt')) && sess.plan.length === 3, JSON.stringify(sess.planMode));
  check('feedback message is marked as such', sess.messages.some((m: any) => m.role === 'user' && /^\[Plan feedback\] also add a test/.test(m.content)));
  // Approve: tools are back and the plan is the brief.
  script = [
    textCalls({ name: 'edit_file', arguments: { path: 'greet.ts', old_string: '"hi"', new_string: '"hello"' } }),
    textCalls({ name: 'update_plan', arguments: { steps: [{ title: 'Edit greet.ts: return "hello"', status: 'done' }, { title: 'Add a test for greet', status: 'done' }, { title: 'Run the tests', status: 'done' }] } }),
    say('Done.'),
  ];
  await rn.approvePlan();
  check('approval ends plan mode and restores write tools', sess.planMode === undefined && read('greet.ts').includes('"hello"') && /write_file/.test(toolLine(sess.messages[0])));
  check('the approved plan is sent as the brief', sess.messages.some((m: any) => m.role === 'user' && /^\[Plan approved\][\s\S]*1\. Edit greet\.ts/.test(m.content)));
  // Cancel path.
  script = [textCalls({ name: 'update_plan', arguments: { steps: [{ title: 'Delete everything', status: 'pending' }] } }), say('Plan: delete everything.')];
  await rn.handleUserMessage('/plan delete everything');
  check('second plan awaits review', sess.planMode?.status === 'review');
  rn.cancelPlan();
  check('cancel clears plan mode and leaves a note', sess.planMode === undefined && /^\[system\] Plan cancelled/.test((sess.messages.at(-1) as any).content));
  fs.rmSync(path.join(DEMO, 'greet.ts'));
}

// ---------- U: Goal upgrades (A5) ----------
console.log('\n# U. Goal tools: block_goal ×3 stops the goal; fresh-context rounds stay small');
{
  const { MAX_BLOCKED_ROUNDS } = await import(`${SRC}/agent/runner.ts`);
  const idleNames = enabledTools('main').map((t) => t.function.name);
  check('goal tools are hidden while no goal runs', !idleNames.some((n) => /_goal$/.test(n)), idleNames.join(','));
  const goalNames = enabledTools('main', { goal: true }).map((t) => t.function.name);
  check('goal tools appear for a running goal', ['get_goal', 'update_goal', 'complete_goal', 'block_goal'].every((n) => goalNames.includes(n)));

  // Three blocked rounds in a row: the goal stops with the blocker visible, no checkpoint call is made.
  const sess = createSession('gemma-mock');
  const rn = runnerFor(sess);
  rn.setGoal({ mode: 'goal', brief: 'Deploy the service to production', doneCriteria: 'deployed', maxIterations: 10, lead: 'local' });
  logs.length = 0;
  script = [
    textCalls({ name: 'get_goal', arguments: {} }),
    textCalls({ name: 'block_goal', arguments: { revision: 0, reason: 'stale attempt' } }),
    textCalls({ name: 'block_goal', arguments: { revision: 1, reason: 'No production credentials are available on this machine.' } }),
    say('Blocked: I need production credentials.'),
    textCalls({ name: 'block_goal', arguments: { revision: 2, reason: 'Still no credentials; tried env and keychain.' } }),
    say('Still blocked.'),
    textCalls({ name: 'block_goal', arguments: { revision: 3, reason: 'Cannot deploy without credentials.' } }),
    say('Blocked for the third time.'),
  ];
  await rn.startGoalRun();
  const toolOut = sess.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);
  check('get_goal shows the brief and revision id', toolOut.some((t) => /^Revision: 1\n(Goal|Brief)/.test(t) && /Deploy the service/.test(t)), toolOut[0]);
  check('a stale revision is refused', toolOut.some((t) => /^Stale revision 0: the goal is at revision 1/.test(t)));
  check('block_goal counts the round', toolOut.some((t) => /blocked round 1\/3/.test(t)) && toolOut.some((t) => /blocked round 2\/3/.test(t)) && toolOut.some((t) => /third blocked round/.test(t)));
  check(`goal stopped after ${MAX_BLOCKED_ROUNDS} blocked rounds, blocker kept`, sess.goal?.active === false && sess.goal?.endedBy === 'blocked' && sess.goal?.blockedRounds === 3 && /without credentials/.test(sess.goal?.blocker ?? ''), JSON.stringify(sess.goal));
  check('the stop is visible in the chat', sess.messages.some((m: any) => m.role === 'user' && /^\[Goal blocked\][\s\S]*Cannot deploy without credentials/.test(m.content)));
  check('blocked rounds skip the finish checkpoint and carry the blocker forward', script.length === 0 && sess.messages.some((m: any) => m.role === 'user' && /^\[Goal checkpoint\][\s\S]*reported a blocker \(1\/3\): No production credentials/.test(m.content)));
  check('system prompt offered the goal tools during the goal', /block_goal/.test((sess.messages[0] as any).content));

  // Fresh context each round: round 2 starts from brief + last report (capped) + files on disk + plan, not the transcript.
  const s3 = createSession('gemma-mock');
  const r3 = runnerFor(s3);
  r3.setGoal({ mode: 'goal', brief: 'Create a.txt and b.txt', doneCriteria: 'both files exist', maxIterations: 5, lead: 'local', freshContext: true });
  const longReport = `Report: wrote a.txt. ${'Lots of detail about the work that was done. '.repeat(600)}`;
  script = [
    textCalls({ name: 'write_file', arguments: { path: 'a.txt', content: 'A\n' } }, { name: 'update_plan', arguments: { steps: [{ title: 'Write a.txt', status: 'done' }, { title: 'Write b.txt', status: 'pending' }] } }),
    say(longReport),
    say(longReport), // the open-plan-step gate asks once; the model repeats its report
    say('{"done": false, "remaining": ["write b.txt"], "note": "a.txt exists, b.txt missing"}'),
    textCalls({ name: 'write_file', arguments: { path: 'b.txt', content: 'B\n' } }),
    textCalls({ name: 'get_goal', arguments: {} }),
    (b: any) => {
      const rev = Number((b.messages.at(-1).content as string).match(/Revision: (\d+)/)?.[1]);
      return textCalls({ name: 'complete_goal', arguments: { revision: rev, summary: 'a.txt and b.txt exist' } })(b);
    },
    say('Both files exist. Done.'),
  ];
  await r3.startGoalRun();
  const round2 = s3.archive.length ? s3.messages : [];
  const seed = round2.find((m: any) => m.role === 'user' && /^\[Goal round 2\/5, fresh context\]/.test(m.content)) as any;
  check('round 1 transcript archived; round 2 began with a fresh context', s3.archive.length === 1 && !!seed && round2.indexOf(seed) === 1, `archive=${s3.archive.length} idx=${seed ? round2.indexOf(seed) : -1}`);
  const seedTokens = seed ? Math.ceil((s3.messages[0].content.length + seed.content.length) / 4) : Infinity;
  check('round 2 prompt (system + seed) is under 4k tokens', seedTokens < 4000, `${seedTokens} tokens`);
  check('seed carries the brief, remaining items, the capped report, files on disk and the plan', !!seed && /Create a\.txt and b\.txt/.test(seed.content) && /- write b\.txt/.test(seed.content) && /report cut at 8000 characters/.test(seed.content) && /Files on disk right now[\s\S]*a\.txt: 1 line, 2 bytes/.test(seed.content) && /\[x\] Write a\.txt[\s\S]*\[ \] Write b\.txt/.test(seed.content), seed?.content.slice(-700));
  check('complete_goal ended the goal without a checkpoint call', s3.goal?.active === false && s3.goal?.endedBy === 'model' && script.length === 0 && /Marked complete by the model/.test(s3.goal?.lastAssessment ?? ''), JSON.stringify(s3.goal));
  check('files from both rounds exist', read('a.txt') === 'A\n' && read('b.txt') === 'B\n');
  fs.rmSync(path.join(DEMO, 'a.txt')); fs.rmSync(path.join(DEMO, 'b.txt'));

  // Loops have no finish: complete_goal is refused, update_goal trims the remaining list.
  const s4 = createSession('gemma-mock');
  const r4 = runnerFor(s4);
  r4.setGoal({ mode: 'loop', brief: 'Keep tidying', doneCriteria: '', maxIterations: 1, lead: 'local' });
  script = [textCalls({ name: 'complete_goal', arguments: { revision: 1, summary: 'all tidy' } }), textCalls({ name: 'update_goal', arguments: { revision: 1, remaining: ['tidy src/', 'tidy test/'], note: 'started' } }), say('ok')];
  await r4.startGoalRun();
  const t4 = s4.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);
  check('complete_goal is refused in loop mode', t4.some((t) => /^A loop has no finish/.test(t)));
  check('update_goal replaces the remaining list and bumps the revision', t4.some((t) => /^Goal updated \(revision 2\)\. Remaining: tidy src\/; tidy test\//.test(t)) && s4.goal?.remaining.length === 2, t4.join(' | '));
}

// ---------- V: Background jobs (A2) ----------
console.log('\n# V. Background jobs: notice on finish, job_output, job_kill');
{
  const { listJobs } = await import(`${SRC}/jobs.ts`);
  const idle = enabledTools('main').map((t) => t.function.name);
  check('job tools hidden until the session has a job', !idle.some((n) => /^job_/.test(n)));
  check('job tools offered once a job exists', ['job_output', 'job_list', 'job_kill'].every((n) => enabledTools('main', { jobs: true }).some((t) => t.function.name === n)));

  const sess = createSession('gemma-mock');
  const rn = runnerFor(sess);
  logs.length = 0;
  script = [
    textCalls({ name: 'shell_run', arguments: { command: 'sleep 1; echo done', background: true } }),
    say('Started the job; carrying on.'),
    say('Saw that the job finished.'), // the wake-up turn
  ];
  await rn.handleUserMessage('run the slow thing in the background');
  const started = sess.messages.find((m: any) => m.role === 'tool' && /^Started background job job\d+/.test(m.content)) as any;
  check('shell_run background returns a job id at once', !!started, sess.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content.slice(0, 60)).join(' | '));
  const jobId = started?.content.match(/job(\d+)/)?.[0];
  check('the job is listed as running', listJobs(sess.id).some((j) => j.id === jobId && j.status === 'running'));
  check('the run ended while the job kept going', !rn.running && script.length === 1);
  for (let i = 0; i < 60 && script.length > 0; i++) await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 60 && rn.running; i++) await new Promise((r) => setTimeout(r, 50));
  const notice = sess.messages.find((m: any) => m.role === 'user' && /^\[job job\d+ done \(exit 0\) after \ds\] sleep 1; echo done/.test(m.content)) as any;
  check('the idle agent was woken with a finish notice carrying the output', !!notice && /Last output:\n[\s\S]*done$/.test(notice.content), notice?.content);
  check('the wake-up turn ran', script.length === 0 && /Saw that the job finished/.test((sess.messages.at(-1) as any).content));
  check('wake-up is logged with its cap', logs.some((l) => /waking the agent \(1\/3\)/.test(l)));
  check('job tools entered the tool list after the first job', /job_output/.test((sess.messages[0] as any).content.split('\n').find((l: string) => l.startsWith('Tools available')) ?? ''));

  // A long job: job_output with a bounded wait, then job_kill.
  script = [
    textCalls({ name: 'shell_run', arguments: { command: 'echo starting; sleep 30; echo never', background: true } }),
    textCalls({ name: 'job_output', arguments: { id: 'WILL_BE_REPLACED', wait_seconds: 1 } }),
    textCalls({ name: 'job_list', arguments: {} }),
    textCalls({ name: 'job_kill', arguments: { id: 'WILL_BE_REPLACED' } }),
    say('Killed it.'),
  ];
  // The id is only known after the first step: patch the later steps when they run.
  const patch = (b: any) => listJobs(sess.id).find((j) => j.status === 'running')?.id ?? 'job?';
  script[1] = (b: any) => textCalls({ name: 'job_output', arguments: { id: patch(b), wait_seconds: 1 } })(b);
  script[3] = (b: any) => textCalls({ name: 'job_kill', arguments: { id: patch(b) } })(b);
  const t0 = Date.now();
  await rn.handleUserMessage('start the server, check it, then stop it');
  const outs = sess.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);
  check('job_output returned the output so far after a bounded wait', outs.some((o) => /^job\d+: running, \ds, \d+ bytes of output[\s\S]*\nstarting/.test(o)), outs.filter((o) => /^job\d+:/.test(o)).join(' | '));
  check('job_list shows both jobs', outs.some((o) => /job1: done \(exit 0\)[\s\S]*job\d+: running/.test(o)));
  check('job_kill stopped it', outs.some((o) => /^Job job\d+ killed\.$/.test(o)));
  for (let i = 0; i < 40 && listJobs(sess.id).some((j) => j.status === 'running'); i++) await new Promise((r) => setTimeout(r, 50));
  const killed = listJobs(sess.id).find((j) => /sleep 30/.test(j.command));
  check('the killed job is gone well before its 30 s', killed?.status === 'killed' && Date.now() - t0 < 10_000, JSON.stringify(killed));
  await new Promise((r) => setTimeout(r, 300));
  check('a killed job does not wake the agent', !sess.messages.some((m: any) => m.role === 'user' && /^\[job job\d+ killed/.test(m.content)) && !rn.running);
}

// ---------- W: web_fetch / web_search (A1) ----------
console.log('\n# W. web_fetch: text only, same-origin redirects, size cap, untrusted wrapper; web_search via SearXNG JSON');
{
  const { fetchPage, FETCH_MAX_BYTES } = await import(`${SRC}/tools/web.ts`);
  const { htmlToMarkdown } = await import(`${SRC}/tools/htmlToMarkdown.ts`);
  const WEB_PORT = PORT + 1;
  const OTHER_PORT = PORT + 2;
  const base = `http://127.0.0.1:${WEB_PORT}`;
  const web = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', base);
    switch (u.pathname) {
      case '/page':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<html><head><title>Docs &amp; Guides</title><script>evil()</script><style>p{}</style></head><body><nav><a href="/x">skip me</a></nav><main><h1>Install</h1><p>Run <code>npm i</code> &mdash; see <a href="/more">more</a>.</p><ul><li>one</li><li><b>two</b></li></ul><pre><code class="language-sh">npm test\n</code></pre><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></main></body></html>`);
      case '/redir':
        res.writeHead(302, { Location: '/page' });
        return res.end();
      case '/offsite':
        res.writeHead(302, { Location: `http://127.0.0.1:${OTHER_PORT}/page` });
        return res.end();
      case '/loop':
        res.writeHead(302, { Location: '/loop' });
        return res.end();
      case '/bin':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(Buffer.from([0, 1, 2, 3]));
      case '/sneaky':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 0)]));
      case '/big': {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const line = Buffer.from(`${'x'.repeat(99)}\n`);
        let sent = 0;
        const pump = () => {
          while (sent < 3 * 1024 * 1024) {
            sent += line.length;
            if (!res.write(line)) return void res.once('drain', pump);
          }
          res.end();
        };
        return pump();
      }
      case '/json':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"ok":true}');
      case '/search':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ query: u.searchParams.get('q'), results: [{ title: 'Result One', url: 'https://example.com/1', content: 'First   snippet.' }, { title: 'Result Two', url: 'https://example.com/2', content: 'Second.' }] }));
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('nope');
    }
  });
  await new Promise<void>((r) => web.listen(WEB_PORT, '127.0.0.1', () => r()));

  const md = htmlToMarkdown('<p>Hi <a href="/a">there</a> &amp; <em>you</em></p>', 'https://ex.org/base/');
  check('html → markdown: links resolved, entities decoded, emphasis', md === 'Hi [there](https://ex.org/a) & *you*', md);
  const page = await fetchPage(`${base}/page`);
  check('page: title, headings, lists, code block, table; nav/script/style dropped', page.title === 'Docs & Guides' && /^# Install/m.test(page.text) && /- one\n- \*\*two\*\*/.test(page.text) && /```sh\nnpm test\n```/.test(page.text) && /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/.test(page.text) && !/skip me|evil|p\{\}/.test(page.text), page.text);
  check('relative links become absolute', new RegExp(`\\[more\\]\\(${base}/more\\)`).test(page.text));
  const redir = await fetchPage(`${base}/redir`);
  check('same-origin redirect followed, final URL reported', redir.finalUrl === `${base}/page` && redir.status === 200);
  const off = await fetchPage(`${base}/offsite`).catch((e: Error) => e.message);
  check('cross-origin redirect refused', typeof off === 'string' && /Redirect to another origin refused/.test(off), String(off));
  const loop = await fetchPage(`${base}/loop`).catch((e: Error) => e.message);
  check('redirect loop stops', typeof loop === 'string' && /Too many redirects/.test(loop), String(loop));
  const bin = await fetchPage(`${base}/bin`).catch((e: Error) => e.message);
  check('binary content type refused', typeof bin === 'string' && /Not text: the server sent application\/octet-stream/.test(bin), String(bin));
  const sneaky = await fetchPage(`${base}/sneaky`).catch((e: Error) => e.message);
  check('binary bytes behind a text content type refused', typeof sneaky === 'string' && /looks binary/.test(sneaky), String(sneaky));
  const big = await fetchPage(`${base}/big`);
  check(`3 MB body cut at the ${FETCH_MAX_BYTES / 1024 / 1024} MB cap`, big.truncated && big.bytes === FETCH_MAX_BYTES && big.text.length === FETCH_MAX_BYTES, `${big.bytes} truncated=${big.truncated}`);
  const ftp = await fetchPage('ftp://example.com/x').catch((e: Error) => e.message);
  check('non-http scheme refused', typeof ftp === 'string' && /Only http\(s\)/.test(ftp));
  const json = await fetchPage(`${base}/json`);
  check('json comes back as-is', json.text === '{"ok":true}' && json.contentType === 'application/json');

  // Through the agent: off by default; on → wrapped as untrusted; search hidden until a server is set.
  const names0 = enabledTools('main').map((t) => t.function.name);
  check('web tools are off by default', !names0.includes('web_fetch') && !names0.includes('web_search'));
  updateSettings({ capabilities: { web_fetch: true, web_search: true } as any });
  const names1 = enabledTools('main').map((t) => t.function.name);
  check('web_fetch on; web_search still hidden without a search server', names1.includes('web_fetch') && !names1.includes('web_search'), names1.join(','));
  updateSettings({ webSearchUrl: base });
  check('web_search appears once a server is configured', enabledTools('main').some((t) => t.function.name === 'web_search'));
  r = await runWith([
    textCalls({ name: 'web_fetch', arguments: { url: `${base}/page` } }),
    textCalls({ name: 'web_search', arguments: { query: 'localdex docs', limit: 5 } }),
    textCalls({ name: 'web_fetch', arguments: { url: `${base}/missing` } }),
    say('Fetched.'),
  ], 'read the docs page');
  const wr = toolResults(r.messages).map((m) => m.content as string);
  check('fetched page is wrapped as untrusted <web_result>', /^<web_result url="[^"]+\/page" status="200" type="text\/html">\nUntrusted content from the web[\s\S]*# Install[\s\S]*<\/web_result>$/.test(wr[0]), wr[0]?.slice(0, 200));
  check('search results list title, url, snippet (whitespace collapsed)', /<web_result query="localdex docs" results="2">[\s\S]*1\. Result One\n   https:\/\/example\.com\/1\n   First snippet\./.test(wr[1]), wr[1]);
  check('a 404 is a failed tool call with the body', /^web_fetch failed|<web_result[^>]*status="404"/.test(wr[2]) && r.messages.some((m: any) => m.role === 'tool' && /404/.test(m.content)), wr[2]?.slice(0, 120));
  updateSettings({ capabilities: { web_fetch: false, web_search: false } as any, webSearchUrl: '' });
  web.close();
}

// ---------- X: Stats (U2) ----------
console.log('\n# X. Stats: per-step time to first token, model vs tool time, tokens');
{
  const { summarize: summarizeStats } = await import(`${SRC}/agent/stats.ts`);
  const sess = createSession('gemma-mock');
  const rn = runnerFor(sess);
  script = [
    textCalls({ name: 'shell_run', arguments: { command: 'sleep 0.3; echo hi' } }),
    say('Ran it.'),
  ];
  await rn.handleUserMessage('time something');
  const st = sess.stats ?? [];
  check('one stat per model call, main agent', st.length === 2 && st.every((x) => x.agent === 'main'), JSON.stringify(st));
  check('tool step: tool time ≥ 300 ms, 1 tool; final step: no tools', st[0].tools === 1 && st[0].toolMs >= 280 && st[1].tools === 0 && st[1].toolMs === 0, JSON.stringify(st.map((x) => [x.tools, x.toolMs])));
  check('tokens from usage, TTFT and model time measured', st.every((x) => x.promptTokens === 100 && x.completionTokens === 10 && x.ttftMs !== null && x.ttftMs >= 0 && x.modelMs >= x.ttftMs), JSON.stringify(st));
  const sum = summarizeStats(st);
  check('summary: totals, median TTFT, tool time dominated by the sleep', sum.steps === 2 && sum.promptTokens === 200 && sum.completionTokens === 20 && sum.ttftMedianMs !== null && sum.toolMs >= 280 && sum.toolMs > sum.modelMs, JSON.stringify(sum));
  check('a step that streamed nothing has no TTFT', summarizeStats([{ ts: 0, agent: 'main', promptTokens: 1, completionTokens: 0, ttftMs: null, modelMs: 5, toolMs: 0, tools: 0 }]).ttftMedianMs === null);
}

// ---------- Y: Shell sandbox + permission presets (S3) ----------
console.log('\n# Y. Shell sandbox + permission presets');
{
  const os = await import('node:os');
  const sbx = await import(`${SRC}/sandbox.ts`);
  const { shell_run } = await import(`${SRC}/tools/shell.ts`);
  const { write_file } = await import(`${SRC}/tools/fs.ts`);
  const asked: string[] = [];
  let allow = false;
  const ctxFor = () => ({ sessionId: 'sbx', agent: 'main', signal: new AbortController().signal, requestApproval: async (c: string) => (asked.push(c), allow), askUser: async () => '' });

  // Pure profile builders.
  const sb = sbx.seatbeltProfileArgs(['/Users/p/proj', '/private/tmp']);
  check('seatbelt: allow-default, deny writes, allow-list of roots', sb[0] === '-p' && /\(allow default\)/.test(sb[1]) && /\(deny file-write\*\)/.test(sb[1]) && /\(subpath "\/Users\/p\/proj"\)/.test(sb[1]) && /\(literal "\/dev\/null"\)/.test(sb[1]), sb[1]);
  check('seatbelt: quotes in paths are escaped', /\\"/.test(sbx.seatbeltProfileArgs(['/a"b'])[1]));
  const bw = sbx.bwrapProfileArgs('workspace-write', ['/w']).join(' ');
  check('bwrap: read-only root, private /tmp and PID namespace, writable bind', /--ro-bind \/ \//.test(bw) && /--tmpfs \/tmp/.test(bw) && /--unshare-pid/.test(bw) && /--bind \/w \/w/.test(bw), bw);
  const bwro = sbx.bwrapProfileArgs('read-only', [], ['/proj']).join(' ');
  check('bwrap read-only: approved folder mounted read-only, not writable', /--ro-bind \/proj \/proj/.test(bwro) && !/--bind \/proj/.test(bwro), bwro);
  updateSettings({ permissionPreset: 'read-only' });
  const roRoots = sbx.writableRoots('read-only');
  check('read-only roots never include the approved folder', !roRoots.some((r: string) => r === fs.realpathSync(DEMO)), JSON.stringify(roRoots));
  updateSettings({ permissionPreset: 'full' });
  check('full access: command passes through unwrapped', sbx.wrapCommand('/bin/sh', ['-c', 'true']).sandboxed === false);

  // Read only preset hides and refuses the write tools.
  updateSettings({ permissionPreset: 'read-only' });
  const names = enabledTools('main').map((t: any) => t.function.name);
  check('read-only: write_file and edit_file hidden from the model', !names.includes('write_file') && !names.includes('edit_file') && names.includes('read_file'), names.join(','));
  const wr = await write_file.run({ path: 'ro.txt', content: 'x' }, ctxFor() as any);
  check('read-only: write_file refused if called anyway', !wr.ok && /Read only/.test(wr.content) && !fs.existsSync(path.join(DEMO, 'ro.txt')), wr.content);
  updateSettings({ permissionPreset: 'full' });

  // Fail closed when the preset needs a sandbox the machine doesn't have.
  process.env.LOCALDEX_SANDBOX = 'none';
  sbx.resetSandboxCache();
  updateSettings({ permissionPreset: 'workspace' });
  const closed = await shell_run.run({ command: `touch ${path.join(DEMO, 'should-not-exist.txt')}` }, ctxFor() as any);
  check('no sandbox: fails closed, nothing runs', !closed.ok && /needs a sandbox/.test(closed.content) && !fs.existsSync(path.join(DEMO, 'should-not-exist.txt')), closed.content);
  const closedJob = await shell_run.run({ command: 'true', background: true }, { ...ctxFor(), jobs: true } as any);
  check('no sandbox: background job fails closed too', !closedJob.ok && /needs a sandbox/.test(closedJob.content), closedJob.content);
  delete process.env.LOCALDEX_SANDBOX;
  sbx.resetSandboxCache();

  const st = sbx.sandboxStatus();
  console.log(`  (sandbox on this machine: ${st.available ? st.kind : `none — ${st.reason}`})`);
  if (st.available) {
    const outsideDir = fs.mkdtempSync(path.join(os.homedir(), '.localdex-sbx-test-'));
    const outside = path.join(outsideDir, 'outside.txt');
    try {
      updateSettings({ permissionPreset: 'workspace' });
      const inside = await shell_run.run({ command: `echo ok > ${path.join(DEMO, 'sbx-inside.txt')} && cat ${path.join(DEMO, 'sbx-inside.txt')}` }, ctxFor() as any);
      check('workspace: writing inside the approved folder works', inside.ok && /sandboxed/.test(inside.content) && read('sbx-inside.txt').trim() === 'ok', inside.content);
      asked.length = 0;
      allow = false;
      const blocked = await shell_run.run({ command: `touch ${outside}` }, ctxFor() as any);
      check('workspace: write outside is blocked, user asked once, declined', !blocked.ok && asked.length === 1 && /sandbox blocked/.test(asked[0]) && /declined full access/.test(blocked.content) && !fs.existsSync(outside), `${asked.length} ${blocked.content.slice(0, 300)}`);
      asked.length = 0;
      allow = true;
      const escalated = await shell_run.run({ command: `touch ${outside}` }, ctxFor() as any);
      check('workspace: approved escalation re-runs once with full access', escalated.ok && asked.length === 1 && fs.existsSync(outside) && /re-run once with full access/.test(escalated.content), escalated.content);
      fs.rmSync(outside, { force: true });
      allow = false;
      const reading = await shell_run.run({ command: `cat ${path.join(DEMO, 'sbx-inside.txt')}` }, ctxFor() as any);
      check('workspace: reads are unaffected', reading.ok && /ok/.test(reading.content));

      updateSettings({ permissionPreset: 'read-only' });
      asked.length = 0;
      const roWrite = await shell_run.run({ command: `touch ${path.join(DEMO, 'sbx-ro.txt')}` }, ctxFor() as any);
      check('read-only: shell cannot write even inside the approved folder, and no escalation is offered', !roWrite.ok && asked.length === 0 && /Read only/.test(roWrite.content) && !fs.existsSync(path.join(DEMO, 'sbx-ro.txt')), roWrite.content.slice(0, 300));
      const roRead = await shell_run.run({ command: `cat ${path.join(DEMO, 'sbx-inside.txt')}` }, ctxFor() as any);
      check('read-only: shell can still read the approved folder', roRead.ok && /ok/.test(roRead.content), roRead.content.slice(0, 300));

      updateSettings({ permissionPreset: 'workspace' });
      const { startJob, getJob } = await import(`${SRC}/jobs.ts`);
      const job = startJob('sbx', 'main', `touch ${outside}; echo done`, DEMO);
      for (let i = 0; i < 50 && getJob('sbx', job.id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
      check('workspace: background jobs are sandboxed too', !fs.existsSync(outside), getJob('sbx', job.id)?.status);
    } finally {
      updateSettings({ permissionPreset: 'full' });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  }
}

// ---------- Z: Sessions: search, rename, auto-title, export (U1) ----------
console.log('\n# Z. Sessions: search, auto-title, export');
{
  const st = await import(`${SRC}/sessionTools.ts`);
  const { saveNow, getSession } = await import(`${SRC}/store.ts`);
  const a = createSession('gemma-mock');
  a.title = 'Kubernetes ingress notes';
  a.messages.push({ role: 'user', content: 'How do I configure the nginx ingress controller?', ts: 1 }, { role: 'assistant', content: 'Use an Ingress resource with an annotation.', ts: 2 });
  saveNow(a);
  const b = createSession('gemma-mock');
  b.title = 'Pancake recipe';
  b.messages.push({ role: 'user', content: 'Fluffy pancakes with buttermilk', ts: 1 }, { role: 'tool', tool_call_id: 'x', name: 'read_file', content: 'ingress ingress ingress', ts: 2 } as any);
  saveNow(b);
  const hits = st.searchSessions('ingres controler');
  check('search: typo-tolerant match on message text, best first', hits[0]?.id === a.id && /ingress controller/i.test(hits[0].snippet), JSON.stringify(hits.slice(0, 2)));
  check('search: tool output is not indexed', !st.searchSessions('ingress').some((h: any) => h.id === b.id), JSON.stringify(st.searchSessions('ingress').map((h: any) => h.id)));
  check('search: title matches too', st.searchSessions('pancake')[0]?.id === b.id);
  check('search: empty query returns nothing', st.searchSessions('  ').length === 0);

  const c = createSession('gemma-mock');
  c.title = 'Fix: the `build` step';
  c.messages.push(
    { role: 'system', content: 'SYSTEM PROMPT TEXT', ts: 0 },
    { role: 'user', content: 'Fix the build', ts: 1 },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'shell_run', arguments: '{"command":"npm run build"}' } }], ts: 2 },
    { role: 'tool', tool_call_id: 't1', name: 'shell_run', content: 'error ``` in output', ok: false, ts: 3 } as any,
    { role: 'assistant', content: 'Fixed the import.', ts: 4 },
  );
  const md = st.exportMarkdown(c);
  check('export md: title, roles, tool call and result in collapsible blocks, no system prompt', md.startsWith('# Fix: the `build` step') && /### You\n\nFix the build/.test(md) && /Tool call: <code>shell_run<\/code>/.test(md) && /Tool result \(shell_run\) — failed/.test(md) && /### LocalDex\n\nFixed the import\./.test(md) && !md.includes('SYSTEM PROMPT TEXT'), md.slice(0, 400));
  check('export md: fences survive backticks inside tool output', /````\nerror ``` in output\n````/.test(md));
  check('export file name is safe', st.exportFileName(c, 'md') === `localdex-fix-the-build-step-${c.id}.md`, st.exportFileName(c, 'md'));
  check('title cleanup strips quotes, "Title:" and the period', st.cleanTitle('Title: "Fix the login redirect."\n') === 'Fix the login redirect');

  updateSettings({ autoTitle: true });
  const d = createSession('gemma-mock');
  const before = requests.length;
  script = [say('Here is the fix.'), say('"Login redirect loop fix."')];
  await runnerFor(d).handleUserMessage('the login page keeps redirecting to itself after sign in, can you look');
  for (let i = 0; i < 40 && getSession(d.id)?.titleSource !== 'auto'; i++) await new Promise((r) => setTimeout(r, 50));
  const titleReq = requests[requests.length - 1];
  check('auto-title: set after the first run from one short call', d.title === 'Login redirect loop fix' && d.titleSource === 'auto', `${d.title} / ${d.titleSource}`);
  check('auto-title: the title call has no tools and runs after the user run', requests.length - before === 2 && !(titleReq.tools?.length) && /title/i.test(titleReq.messages[0].content), JSON.stringify(titleReq?.tools));
  const e = createSession('gemma-mock');
  e.title = 'My own name';
  e.titleSource = 'user';
  const before2 = requests.length;
  script = [say('ok')];
  await runnerFor(e).handleUserMessage('something else entirely');
  await new Promise((r) => setTimeout(r, 200));
  check('auto-title: never overwrites a title the user set', e.title === 'My own name' && requests.length - before2 === 1, `${e.title} ${requests.length - before2}`);
  updateSettings({ autoTitle: false });
}

// ---------- AA: MCP gallery and tool picking (E1) ----------
console.log('\n# AA. MCP gallery: add with typed confirmation, choose tools, remove');
{
  const gal = await import(`${SRC}/mcp/gallery.ts`);
  const mcp = await import(`${SRC}/mcp/client.ts`);
  const { getSettings } = await import(`${SRC}/config.ts`);
  const entries = gal.mcpGallery();
  check('gallery: playwright, blender, filesystem, github', ['playwright', 'blender', 'filesystem', 'github'].every((id) => entries.some((e: any) => e.id === id)), entries.map((e: any) => e.id).join(','));
  const fsEntry = entries.find((e: any) => e.id === 'filesystem');
  check('gallery: filesystem server is pinned and limited to the approved folders', fsEntry.config.args.includes('@modelcontextprotocol/server-filesystem@2.1.0') && fsEntry.config.args.includes(DEMO), fsEntry.config.args.join(' '));
  const blender = entries.find((e: any) => e.id === 'blender');
  check('gallery: blender asks before every call (execute_blender_code runs code)', blender.config.approval === 'always' && /@\d/.test(blender.config.args[0]), JSON.stringify(blender.config));
  check('gallery: playwright entry matches the hardened default', JSON.stringify(entries.find((e: any) => e.id === 'playwright').config.args).includes('--sandbox'));

  const wrong = gal.addFromGallery('blender', 'blendr');
  check('add: refused unless the server name is typed exactly', !wrong.ok && !getSettings().mcpServers.blender, wrong.message);
  check('add: unknown gallery id refused', !gal.addFromGallery('../../evil', 'x').ok);
  const added = gal.addFromGallery('blender', 'blender');
  check('add: writes the gallery config (from the server, not the browser)', added.ok && getSettings().mcpServers.blender?.command === 'uvx' && getSettings().mcpServers.blender.enabled === true, added.message);
  const custom = { ...getSettings().mcpServers.blender, args: ['my-own-args'], enabled: false };
  updateSettings({ mcpServers: { ...getSettings().mcpServers, blender: custom } });
  gal.addFromGallery('blender', 'blender');
  check('add again: an existing server is switched on, never overwritten', getSettings().mcpServers.blender.args[0] === 'my-own-args' && getSettings().mcpServers.blender.enabled === true);
  check('remove: deletes it from config.json', gal.removeServer('blender').ok && !getSettings().mcpServers.blender && gal.mcpGallery().find((e: any) => e.id === 'blender').installed === false);

  // A real stdio server: connect, list tools, narrow the exposed set.
  const fake = new URL('./fake-mcp.mjs', import.meta.url).pathname;
  updateSettings({ mcpServers: { ...getSettings().mcpServers, fake: { command: process.execPath, args: [fake], enabled: true, approval: 'never' } } });
  await mcp.restartMcp('fake');
  let st = mcp.mcpStatuses().find((x: any) => x.name === 'fake');
  check('test connection: server starts and reports its tools', st?.state === 'ready' && st.availableTools.join(',') === 'alpha,beta,gamma' && st.exposedTools.length === 3, JSON.stringify(st));
  check('choose tools: names the server does not offer are refused', !gal.setAllowTools('fake', ['alpha', 'rm_rf'], st.availableTools).ok);
  check('choose tools: an empty pick is refused', !gal.setAllowTools('fake', [], st.availableTools).ok);
  const narrowed = gal.setAllowTools('fake', ['beta'], st.availableTools);
  await mcp.reloadMcp();
  st = mcp.mcpStatuses().find((x: any) => x.name === 'fake');
  const schemaNames = enabledTools('main').map((t: any) => t.function.name).filter((n: string) => n.startsWith('mcp_fake_'));
  check('choose tools: only the picked tool reaches the model', narrowed.ok && st?.exposedTools.join(',') === 'beta' && schemaNames.join(',') === 'mcp_fake_beta', `${JSON.stringify(st?.exposedTools)} ${schemaNames}`);
  gal.removeServer('fake');
  await mcp.reloadMcp();
  check('remove: a running server is stopped', !mcp.mcpStatuses().some((x: any) => x.name === 'fake') && !enabledTools('main').some((t: any) => t.function.name.startsWith('mcp_fake_')));
}

// ---------- AB: Model doctor (E4) ----------
console.log('\n# AB. Model doctor: probes in both protocols, speed, suggestions');
{
  const doc = await import(`${SRC}/doctor.ts`);
  check('params from id', doc.paramsFromId('gemma-4-12b-it-heretic') === 12 && doc.paramsFromId('qwen3.5-9b') === 9 && doc.paramsFromId('Mixtral-8x7B') === 56 && doc.paramsFromId('ternary-bonsai-2-27b-mlx') === 27 && doc.paramsFromId('gemma-mock') === null);
  check('context: 16 GB + 12B → 32k (the known-safe size)', doc.suggestContext(16, 12).tokens === 32768, JSON.stringify(doc.suggestContext(16, 12)));
  check('context: 64 GB + 12B → more; capped by the model maximum', doc.suggestContext(64, 12).tokens === 131072 && doc.suggestContext(64, 12, 65536).tokens === 65536);
  check('context: a model too big for RAM gets a warning, unknown size gets none', /swapping/.test(doc.suggestContext(16, 70).why) && doc.suggestContext(16, null).tokens === null);

  const ok1 = native({ name: 'read_file', arguments: { path: 'notes.txt' } });
  script = [
    // native
    ok1,
    native({ name: 'shell_run', arguments: { command: 'npm test' } }),
    native({ name: 'write_file', arguments: { path: 'hello.py', content: "print('a') print('b')" } }), // newline lost: fail
    native({ name: 'edit_file', arguments: { path: 'greet.py', old_string: 'return "Hello, " + name', new_string: 'return "Hi, " + name' } }),
    say("I couldn't read config.yaml: it does not exist, so I can't tell you the port."),
    say('todo.txt has two items: buy milk and fix bike.'),
    // text
    textCalls({ name: 'read_file', arguments: { path: 'notes.txt' } }),
    textCalls({ name: 'read_file', arguments: { path: 'package.json' } }), // wrong tool: fail
    textCalls({ name: 'write_file', arguments: { path: 'hello.py', content: "print('a')\nprint('b')" } }),
    textCalls({ name: 'edit_file', arguments: { path: 'greet.py', old_string: '"Hello, "', new_string: '"Hi, "' } }),
    say('The port is 8080.'), // invented: fail
    textCalls({ name: 'read_file', arguments: { path: 'todo.txt' } }), // doesn't stop: fail
    // speed
    say('Rivers carve valleys over long stretches of time as water and sediment wear the rock away.'),
  ];
  const before = requests.length;
  const progress: string[] = [];
  const unsub = bus.subscribe((ev: any) => ev.type === 'doctor_progress' && progress.push(ev.label));
  const rep = await doc.runDoctor('gemma-mock');
  unsub?.();
  const reqs = requests.slice(before);
  check('doctor: 13 requests (6 native, 6 text, 1 speed), script used up', reqs.length === 13 && script.length === 0, `${reqs.length} left=${script.length}`);
  check('doctor: native probes send tools, text probes send none', reqs.slice(0, 6).every((r: any) => r.tools?.length === 4) && reqs.slice(6, 12).every((r: any) => !r.tools?.length) && reqs.slice(6, 12).every((r: any) => /tool_call/.test(r.messages[0].content)), JSON.stringify(reqs.map((r: any) => r.tools?.length ?? 0)));
  const byId = (mode: string, id: string) => rep.probes.find((p: any) => p.mode === mode && p.id === id);
  check('doctor: lost newline, wrong tool, invented port and not stopping are caught', !byId('native', 'json_newlines').pass && !byId('text', 'right_tool').pass && !byId('text', 'honest_failure').pass && !byId('text', 'stops_when_done').pass, JSON.stringify(rep.probes.map((p: any) => `${p.mode}:${p.id}:${p.pass}`)));
  check('doctor: honest failure and a landing edit pass', byId('native', 'honest_failure').pass && byId('native', 'edit_lands').pass && byId('text', 'edit_lands').pass && byId('text', 'json_newlines').pass);
  check('doctor: score 5/6 native, 3/6 text → suggests native', rep.score.native === 5 && rep.score.text === 3 && rep.suggest.toolMode === 'native' && rep.verdict === 'good', JSON.stringify(rep.score));
  check('doctor: speed measured, reasoning switch noticed', rep.speed.completionTokens === 10 && rep.speed.ttftMs !== null && /reasoning switch/.test(rep.suggest.reasoningWhy), JSON.stringify(rep.speed));
  check('doctor: progress reported for every step', progress.length === 13 && progress[12] === 'speed test', progress.join(' | '));
  const saved = doc.doctorReports();
  check('doctor: report saved per model for comparison', saved[0]?.model === 'gemma-mock' && saved[0].ranAt === rep.ranAt);
  check('doctor: the forced protocol is not remembered for the model', lm.toolModeCache()['gemma-mock'] === 'text', JSON.stringify(lm.toolModeCache()));
}

// ---------- AC: Fork / edit and regenerate (U4) ----------
console.log('\n# AC. Fork a session; edit a message and re-run in a fork');
{
  const fk = await import(`${SRC}/fork.ts`);
  const src = createSession('gemma-mock');
  src.title = 'Original';
  src.messages.push(
    { role: 'system', content: 'sys', ts: 0 },
    { role: 'user', content: 'list files', ts: 1 },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_dir', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'glob', arguments: '{}' } }], ts: 2 },
    { role: 'tool', tool_call_id: 'a', name: 'list_dir', content: 'x.txt', ts: 3 } as any,
    { role: 'tool', tool_call_id: 'b', name: 'glob', content: 'x.txt', ts: 4 } as any,
    { role: 'assistant', content: 'There is x.txt.', ts: 5 },
    { role: 'user', content: 'read it', ts: 6 },
    { role: 'assistant', content: 'It says hi.', ts: 7 },
  );
  src.turns = [{ id: 't1', startedAt: 1, folder: DEMO, files: [] }] as any;
  src.memberSessions = { claude: { id: 'v1' } } as any;
  const partial = fk.cleanSlice(src.messages, 4); // assistant with 2 calls, only 1 answered
  check('fork: a tool call without its result is never kept', partial.length === 2 && partial[1].role === 'user', JSON.stringify(partial.map((m: any) => m.role)));
  const f = fk.forkAt(src, 6);
  check('fork: conversation copied up to the point, ending cleanly', f.messages.length === 6 && f.messages[5].content === 'There is x.txt.' && f.id !== src.id, String(f.messages.length));
  check('fork: model/mode carried; undo history and vendor sessions not', f.model === 'gemma-mock' && !f.turns?.length && !f.memberSessions && f.forkedFrom?.sessionId === src.id && f.title === 'Original (fork)' && f.titleSource === 'auto');
  f.messages[1].content = 'changed';
  check('fork: deep copy — editing the fork never touches the original', src.messages[1].content === 'list files' && src.messages.length === 8);
  check('edit: only real user messages are editable', fk.isEditableUserMessage(src, 6) && !fk.isEditableUserMessage(src, 5) && !fk.isEditableUserMessage(src, 0));
  // edit_message: fork just before the user message, then send the new text there.
  const e = fk.forkAt(src, 6, 'Original (edited)');
  script = [say('It says hello world.')];
  await runnerFor(e).handleUserMessage('read it slowly');
  const last = e.messages[e.messages.length - 1];
  check('edit: the edited message runs in the fork', e.messages.some((m: any) => m.role === 'user' && m.content === 'read it slowly') && last.content === 'It says hello world.', JSON.stringify(e.messages.slice(-2)));
  check('edit: the original keeps its message and answer', src.messages[6].content === 'read it' && src.messages[7].content === 'It says hi.');
}

// ---------- AD: Message feedback (U3) ----------
console.log('\n# AD. 👍/👎 on answers: local model and council members');
{
  const fb = await import(`${SRC}/feedback.ts`);
  const { getStats } = await import(`${SRC}/council/stats.ts`);
  const s = createSession('fb-model-12b');
  s.messages.push({ role: 'user', content: 'q', ts: 1 }, { role: 'assistant', content: 'local answer', ts: 2 }, { role: 'user', content: 'q2', ts: 3 }, { role: 'assistant', content: 'council answer', via: 'Claude → Codex', councilRunId: 'r1', ts: 4 } as any);
  s.councilRuns = [{ id: 'r1', steps: [{ member: 'claude', role: 'planner', status: 'done' }, { member: 'codex', role: 'builder', status: 'done' }, { member: 'gemini', role: 'reviewer', status: 'error' }, { member: 'local', role: 'checks', status: 'done' }] }] as any;
  const m = () => fb.feedbackStats().models['fb-model-12b'];
  check('rate: only assistant answers can be rated', !fb.rateMessage(s, 0, 'up'));
  fb.rateMessage(s, 1, 'up');
  check('rate up: stored on the message, counted for the local model', s.messages[1].feedback?.rating === 'up' && m().up === 1 && (s.messages[1] as any).model === 'fb-model-12b');
  fb.rateMessage(s, 1, 'down', 'made-up');
  check('change to down with a reason: counts move, reason counted', m().up === 0 && m().down === 1 && m().categories['made-up'] === 1 && s.messages[1].feedback?.category === 'made-up');
  fb.rateMessage(s, 1, null);
  check('clear: rating removed and taken back', !s.messages[1].feedback && m().down === 0 && m().categories['made-up'] === 0);
  fb.rateMessage(s, 1, 'down', 'not-a-category' as any);
  check('unknown reason is dropped', s.messages[1].feedback?.rating === 'down' && !s.messages[1].feedback?.category);
  const before = { c: getStats().members.claude?.feedback?.up ?? 0, x: getStats().members.codex?.feedback?.up ?? 0, g: getStats().members.gemini?.feedback?.up ?? 0, l: getStats().members.local?.feedback?.up ?? 0 };
  fb.rateMessage(s, 3, 'up');
  const st = getStats().members;
  check('council answer: members with finished steps get the credit (not failed steps or the checks step)', st.claude!.feedback.up === before.c + 1 && st.codex!.feedback.up === before.x + 1 && (st.gemini?.feedback?.up ?? 0) === before.g && (st.local?.feedback?.up ?? 0) === before.l, JSON.stringify({ c: st.claude?.feedback, x: st.codex?.feedback }));
  check('council answer: not counted for the local model', m().up === 0);
}

// ---------- AE: @file mentions (A6) ----------
console.log('\n# AE. @file mentions: completion and read hint');
{
  const fm = await import(`${SRC}/fileMentions.ts`);
  fs.mkdirSync(path.join(DEMO, 'src/components'), { recursive: true });
  fs.writeFileSync(path.join(DEMO, 'src/components/Button.tsx'), 'export {}');
  fs.writeFileSync(path.join(DEMO, 'src/buttonUtils.ts'), 'export {}');
  fs.writeFileSync(path.join(DEMO, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(DEMO, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(DEMO, 'node_modules/pkg/button.js'), '');
  check('fuzzy: file-name hits beat path hits', fm.fuzzyScore('button', 'src/components/Button.tsx') > fm.fuzzyScore('button', 'b/u/t/t/o/n.txt') && fm.fuzzyScore('xyz', 'src/a.ts') < 0);
  const hits = fm.searchFiles('button');
  check('search: finds files in the approved folder, best first; node_modules skipped', hits[0] === 'src/components/Button.tsx' && hits.includes('src/buttonUtils.ts') && !hits.some((h: string) => h.includes('node_modules')), JSON.stringify(hits));
  check('search: protected files (.env) are never offered', !fm.searchFiles('env').includes('.env') && !fm.searchFiles('').includes('.env'));
  const found = fm.mentionedFiles('look at @src/components/Button.tsx, and @src/nope.ts and @/etc/passwd and @.env');
  check('mentions: only existing, allowed files count', found.length === 1 && found[0] === path.join(DEMO, 'src/components/Button.tsx'), JSON.stringify(found));
  const sess = createSession('gemma-mock');
  script = [say('Looked.')];
  await runnerFor(sess).handleUserMessage('what does @src/buttonUtils.ts export?');
  const hint = sess.messages.find((m: any) => m.role === 'user' && /Files the user mentioned/.test(m.content));
  check('runner: a read hint follows the message; the file content is not inlined', !!hint && /src\/buttonUtils\.ts/.test(hint.content) && !/export \{\}/.test(hint.content), hint?.content);
}

// ---------- AF: Open PR from a council copy (E3) ----------
console.log('\n# AF. Open PR: members-only commit on a new branch, gh pr create, status refresh');
{
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const wtm = await import(`${SRC}/council/worktrees.ts`);
  const forge = await import(`${SRC}/council/forge.ts`);
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ldx-pr-'));
  const origin = path.join(base, 'origin.git');
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'line1\nline2\n');
  fs.writeFileSync(path.join(repo, 'mine.txt'), 'original\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '--quiet', '-m', 'init');
  g(repo, 'remote', 'add', 'origin', origin); g(repo, 'push', '--quiet', 'origin', 'main');
  const userHead = g(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'mine.txt'), 'my uncommitted work\n'); // must never reach the PR

  const ghLog = path.join(base, 'gh.log');
  process.env.FAKE_GH_LOG = ghLog;
  process.env.LOCALDEX_GH = '/nonexistent/gh';
  forge.resetForgeCache();
  check('no gh: unavailable with a reason', forge.forgeStatus(true).gh === false && /not installed/.test(forge.forgeStatus().reason));
  process.env.LOCALDEX_GH = new URL('./fake-gh.sh', import.meta.url).pathname;
  forge.resetForgeCache();
  check('gh installed and signed in', forge.forgeStatus(true).gh === true);

  const wt = wtm.createWorktree(repo, 'run12345', 'pr test');
  check('copy carries the user uncommitted change (imported)', wt.imported === 1 && fs.readFileSync(path.join(wt.path, 'mine.txt'), 'utf8') === 'my uncommitted work\n');
  fs.writeFileSync(path.join(wt.path, 'app.txt'), 'line1\nline2 improved\n');
  fs.writeFileSync(path.join(wt.path, 'new.txt'), 'added by a member\n');
  const run: any = { id: 'run12345abc', task: 'Improve line two\nmore detail', pattern: 'single', steps: [{ member: 'claude', status: 'done', role: 'builder' }], worktree: wt };
  const r = forge.openPullRequest(run, wt);
  check('open PR: succeeds and records the PR', r.ok && wt.pr?.number === 42 && wt.pr.url === 'https://github.com/p/r/pull/42' && /^localdex\/improve-line-two-run123$/.test(wt.pr.branch), `${r.message} ${JSON.stringify(wt.pr)}`);
  const pushed = execFileSync('git', ['--git-dir', origin, 'rev-parse', `refs/heads/${wt.pr!.branch}`], { encoding: 'utf8' }).trim();
  const parent = execFileSync('git', ['--git-dir', origin, 'rev-parse', `${pushed}^`], { encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['--git-dir', origin, 'diff', '--name-only', parent, pushed], { encoding: 'utf8' }).trim().split('\n');
  const mineInPr = execFileSync('git', ['--git-dir', origin, 'show', `${pushed}:mine.txt`], { encoding: 'utf8' });
  check('pushed: one commit on top of the user’s last commit', parent === userHead, `${parent} vs ${userHead}`);
  check('pushed: only the members’ changes; the user’s uncommitted work stays out', files.sort().join(',') === 'app.txt,new.txt' && mineInPr === 'original\n', `${files} / ${JSON.stringify(mineInPr)}`);
  const log = fs.readFileSync(ghLog, 'utf8');
  check('gh pr create: head branch, title from the task, base = the user’s branch on the remote', /pr create --head localdex\/improve-line-two-run123 --title Improve line two/.test(log) && /--base main/.test(log), log.split('\n').find((l: string) => l.startsWith('pr create'))?.slice(0, 200));
  check('user folder untouched', fs.readFileSync(path.join(repo, 'mine.txt'), 'utf8') === 'my uncommitted work\n' && g(repo, 'rev-parse', 'HEAD') === userHead && g(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main');
  check('open PR twice: refused', !forge.openPullRequest(run, wt).ok);
  const ref = forge.refreshPullRequest(wt);
  check('refresh: state, review and checks from gh', ref.ok && wt.pr!.state === 'MERGED' && wt.pr!.review === 'APPROVED' && wt.pr!.checks === 'passing', JSON.stringify(wt.pr));

  // Members edited the same lines as the user's uncommitted change: can't be split out → refused.
  const wt2 = wtm.createWorktree(repo, 'run67890', 'overlap');
  fs.writeFileSync(path.join(wt2.path, 'mine.txt'), 'member rewrote my line\n');
  const r2 = forge.openPullRequest({ ...run, id: 'run67890xyz', worktree: wt2 }, wt2);
  check('overlap with the user’s uncommitted lines: refused, nothing pushed', !r2.ok && /can’t be split out/.test(r2.message) && !wt2.pr, r2.message);
  wtm.discardWorktree(repo, wt);
  wtm.discardWorktree(repo, wt2);
  delete process.env.LOCALDEX_GH;
  forge.resetForgeCache();
  fs.rmSync(base, { recursive: true, force: true });
}

// ---------- AG: Auto-review for approval prompts (S4) ----------
console.log('\n# AG. Auto-review: low runs without asking; anything else asks with the reason');
{
  const ar = await import(`${SRC}/autoReview.ts`);
  check('verdict: only exact low/allow is allowed', ar.parseVerdict('{"risk":"low","decision":"allow"}', 'x').decision === 'allow' && ar.parseVerdict('{"risk":"high","decision":"allow"}', 'x').decision === 'ask' && ar.parseVerdict('{"risk":"medium","decision":"allow"}', 'x').decision === 'ask' && ar.parseVerdict('sure, go ahead', 'x').decision === 'ask' && ar.parseVerdict('{"risk":"low"', 'x').decision === 'ask');
  check('verdict: reason kept for the prompt', ar.parseVerdict('{"risk":"medium","decision":"deny","reason":"deletes existing files"}', 'x').reason === 'deletes existing files');
  updateSettings({ autoReview: 'local' });
  const promptsSeen: string[] = [];
  const unsub = bus.subscribe((ev: any) => ev.type === 'approval_request' && promptsSeen.push(ev.command));
  fs.mkdirSync(path.join(DEMO, 'build'), { recursive: true });
  fs.writeFileSync(path.join(DEMO, 'build/out.js'), 'x');
  approve = false;
  const a0 = approvals;
  let r = await runWith([textCalls({ name: 'shell_run', arguments: { command: 'rm -rf ./build' } }), say('{"risk":"low","decision":"allow"}'), say('Cleaned.')], 'clean the build output');
  check('low risk: runs without a prompt', approvals === a0 && !fs.existsSync(path.join(DEMO, 'build')) && logs.some((l) => /\[auto-review\] local .*low risk, ran without asking/.test(l)), `${approvals - a0} prompts`);
  const reviewReq = requests[requests.length - 2];
  check('review request: no tools, sees the command and the user request', !(reviewReq.tools?.length) && /rm -rf \.\/build/.test(reviewReq.messages[1].content) && /clean the build output/.test(reviewReq.messages[1].content));
  fs.mkdirSync(path.join(DEMO, 'keep'), { recursive: true });
  const a1 = approvals;
  r = await runWith([textCalls({ name: 'shell_run', arguments: { command: 'rm -rf ./keep' } }), say('{"risk":"medium","decision":"deny","reason":"deletes a folder that existed before"}'), say('Did not delete.')], 'tidy up');
  check('medium: the user is asked, with the reviewer’s reason; declined → nothing deleted', approvals === a1 + 1 && /auto-review by local .*medium risk — deletes a folder that existed before/.test(promptsSeen.at(-1) ?? '') && fs.existsSync(path.join(DEMO, 'keep')), promptsSeen.at(-1));
  const a2 = approvals;
  r = await runWith([textCalls({ name: 'shell_run', arguments: { command: 'rm -rf ./keep' } }), say('looks fine to me!'), say('ok')], 'tidy up again');
  check('unreadable verdict: asks the user (fail closed)', approvals === a2 + 1 && /no verdict/.test(promptsSeen.at(-1) ?? ''), promptsSeen.at(-1));
  const a3 = approvals;
  r = await runWith([textCalls({ name: 'shell_run', arguments: { command: 'echo safe' } }), say('done')], 'say safe');
  check('commands that never needed approval are not reviewed', approvals === a3 && requests.at(-1).messages[0].content !== ar.REVIEW_SYSTEM);
  updateSettings({ autoReview: 'off' });
  unsub();
}

// ---------- AH: Images (A7) ----------
console.log('\n# AH. Images: attachments, vision models, read_image, image budget');
{
  const at = await import(`${SRC}/attachments.ts`);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const id = at.saveImage(PNG);
  check('attachments: content-addressed id, type sniffed from bytes', /^[a-f0-9]{64}\.png$/.test(id) && at.saveImage(PNG) === id && !!at.attachmentPath(id));
  let threw = '';
  try { at.saveImage(Buffer.from('<svg onload=alert(1)>')); } catch (e) { threw = (e as Error).message; }
  check('attachments: non-images refused (svg/html never stored)', /Not a PNG/.test(threw));
  check('attachments: ids are validated (no path tricks)', at.attachmentPath('../../config.json') === null && at.attachmentPath(`${'a'.repeat(64)}.exe`) === null);

  models.v0.data.push({ id: 'vision-mock', type: 'vlm', state: 'loaded', max_context_length: 32768, loaded_context_length: 32768 } as any);
  models.v1.models.push({ key: 'vision-mock', type: 'llm', max_context_length: 32768, loaded_instances: [{ id: 'vision-mock', config: { context_length: 32768 } }], capabilities: { vision: true } } as any);
  await lm.listModels();
  check('vision detected from LM Studio (vlm type / capability)', lm.isVisionModel('vision-mock') && !lm.isVisionModel('gemma-mock'));

  const vs = createSession('vision-mock');
  script = [say('A single pixel.')];
  await runnerFor(vs).handleUserMessage('what is this?', undefined, false, [id, 'not-an-id']);
  const req = requests.at(-1);
  const userMsg = req.messages.find((m: any) => Array.isArray(m.content));
  check('vision model: the image is sent as an image_url part', !!userMsg && userMsg.content.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), JSON.stringify(req.messages.map((m: any) => typeof m.content)).slice(0, 200));
  check('message keeps only valid attachment ids', JSON.stringify(vs.messages.find((m: any) => m.images)?.images) === JSON.stringify([id]));

  const ts = createSession('gemma-mock');
  script = [say('I cannot see images.')];
  await runnerFor(ts).handleUserMessage('what is this?', undefined, false, [id]);
  const treq = requests.at(-1);
  check('non-vision model: a text placeholder instead of the image', treq.messages.every((m: any) => typeof m.content === 'string') && treq.messages.some((m: any) => /\[image: .*can't view images\]/.test(m.content)));

  // Image budget: only the last 3 image messages carry images.
  const many: any[] = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 5; i++) many.push({ role: 'user', content: `pic ${i}`, images: [id] }, { role: 'assistant', content: 'ok' });
  const keep = at.imageKeepSet(many);
  check('image budget: older images become placeholders', keep.size === 3 && keep.has(9) && keep.has(5) && !keep.has(1), JSON.stringify([...keep]));

  // read_image: hidden for text-only models, works for vision models.
  check('read_image hidden unless the model can see', !enabledTools('main').some((t: any) => t.function.name === 'read_image') && enabledTools('main', { vision: true }).some((t: any) => t.function.name === 'read_image'));
  fs.writeFileSync(path.join(DEMO, 'shot.png'), PNG);
  const rs = createSession('vision-mock');
  script = [textCalls({ name: 'read_image', arguments: { path: 'shot.png' } }), say('It is one pixel.')];
  await runnerFor(rs).handleUserMessage('look at shot.png');
  const after = requests.at(-1);
  const imgTurn = after.messages.find((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'));
  check('read_image: the image follows the tool result as a user turn', !!imgTurn && rs.messages.some((m: any) => m.role === 'tool' && /Loaded .*shot\.png/.test(m.content)), JSON.stringify(rs.messages.slice(-3).map((m: any) => m.role + ':' + String(m.content).slice(0, 40))));
  fs.writeFileSync(path.join(DEMO, 'notes.md'), '# hi');
  const { read_image } = await import(`${SRC}/tools/image.ts`);
  const bad = await read_image.run({ path: 'notes.md' }, {} as any);
  check('read_image: text files refused', !bad.ok && /not a PNG/.test(bad.content));
}

// ---------- AI: lsp tool (A3) ----------
console.log('\n# AI. lsp: read-only code navigation through a language server');
{
  const L = await import(`${SRC}/lsp.ts`);
  const { lsp } = await import(`${SRC}/tools/lspTool.ts`);
  check('column from a symbol name (word boundary), 1-based', L.columnFor('const total = add(subtotal, tax);', 'add') === 15 && L.columnFor('  foo.bar()', 'bar') === 7 && L.columnFor('x', 'nope') === null && L.columnFor('abc', undefined, 2) === 2);
  check('server chosen by extension', L.serverFor('a.tsx')?.command === 'typescript-language-server' && L.serverFor('a.py')?.command === 'pyright-langserver' && L.serverFor('a.txt') === null);
  check('lsp is off by default and read-only in plan mode', !enabledTools('main').some((t: any) => t.function.name === 'lsp'));
  const proj = path.join(DEMO, 'tsproj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022' }, include: ['*.ts'] }));
  fs.writeFileSync(path.join(proj, 'math.ts'), '/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(proj, 'main.ts'), "import { add } from './math';\nconst total = add(1, 2);\nconst again = add(total, 3);\nconsole.log(again);\n");
  const missing = await lsp.run({ operation: 'definition', path: 'tsproj/main.ts', line: 2, symbol: 'add' }, {} as any);
  if (process.env.LOCALDEX_TEST_LSP_BIN) process.env.PATH = `${process.env.LOCALDEX_TEST_LSP_BIN}${path.delimiter}${process.env.PATH}`;
  if (!L.onPath('typescript-language-server')) {
    check('no server installed: clear install hint, no crash', !missing.ok && /not installed \(install: npm i -g typescript-language-server/.test(missing.content), missing.content);
    console.log('  (typescript-language-server not on PATH: real-server checks skipped)');
  } else {
    updateSettings({ approvedFolders: [DEMO] });
    const def = await lsp.run({ operation: 'definition', path: 'tsproj/main.ts', line: 2, symbol: 'add' }, {} as any);
    check('definition: jumps to math.ts line 2', def.ok && /tsproj\/math\.ts\n\s+2: export function add/.test(def.content), def.content);
    const refs = await lsp.run({ operation: 'references', path: 'tsproj/math.ts', line: 2, symbol: 'add' }, {} as any);
    check('references: grouped by file with line text', refs.ok && /tsproj\/main\.ts/.test(refs.content) && /2: const total = add\(1, 2\);/.test(refs.content) && /3: const again = add\(total, 3\);/.test(refs.content), refs.content);
    const hov = await lsp.run({ operation: 'hover', path: 'tsproj/main.ts', line: 2, symbol: 'add' }, {} as any);
    check('hover: signature and docs', hov.ok && /add\(a: number, b: number\): number/.test(hov.content) && /Adds two numbers/.test(hov.content), hov.content);
    const notThere = await lsp.run({ operation: 'definition', path: 'tsproj/main.ts', line: 2, symbol: 'subtract' }, {} as any);
    check('a symbol not on the line is refused before asking the server', !notThere.ok && /"subtract" is not on line 2/.test(notThere.content));
    L.closeAllLsp();
  }
  const outside = await lsp.run({ operation: 'hover', path: '/etc/hosts', line: 1, character: 1 }, {} as any).catch((e: Error) => ({ ok: false, content: e.message }));
  check('files outside the approved folders are refused', !outside.ok && /outside the approved folders/.test(outside.content), outside.content);
}

// ---------- AJ: Headless CLI (E2) ----------
console.log('\n# AJ. Headless CLI: localdex run "<task>"');
{
  const { spawn } = await import('node:child_process');
  const bin = new URL('../../bin/localdex.mjs', import.meta.url).pathname;
  const cfgBefore = fs.readFileSync(path.join(process.env.LOCALDEX_HOME!, 'config.json'), 'utf8');
  const runCli = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env }, cwd: DEMO });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => resolve({ code, out, err }));
    });
  const proj = fs.mkdtempSync(path.join(DEMO, 'cli-'));
  script = [textCalls({ name: 'write_file', arguments: { path: path.join(proj, 'hello.txt'), content: 'hi\n' } }), say('Wrote hello.txt.')];
  let r = await runCli(['run', 'create hello.txt saying hi', '--folder', proj, '--json']);
  const j = JSON.parse(r.out.trim().split('\n').pop() || '{}');
  check('stdout carries only the JSON (logs go to stderr)', r.out.trim().split('\n').length === 1 && r.out.trim().startsWith('{'), r.out.slice(0, 200));
  check('done: exit 0, JSON answer, the file is written', r.code === 0 && j.status === 'done' && j.answer === 'Wrote hello.txt.' && fs.existsSync(path.join(proj, 'hello.txt')) && !!j.session, `${r.code} ${r.out} ${r.err.slice(-300)}`);

  script = [textCalls({ name: 'write_file', arguments: { path: path.join(proj, 'nope.txt'), content: 'x' } }), say('I may not write files.'), say('I may not write files.')];
  r = await runCli(['run', 'write nope.txt', '--folder', proj, '--access', 'read']);
  check('--access read: nothing is written; plain answer on stdout', r.code === 0 && r.out.trim() === 'I may not write files.' && !fs.existsSync(path.join(proj, 'nope.txt')), `${r.code} ${r.out} ${r.err.slice(-200)}`);

  fs.mkdirSync(path.join(proj, 'build'), { recursive: true });
  script = [textCalls({ name: 'shell_run', arguments: { command: 'rm -rf ./build' } }), say('The deletion was not allowed.')];
  r = await runCli(['run', 'clean up', '--folder', proj, '--yes-safe']);
  check('dangerous commands are denied even with --yes-safe', r.code === 0 && /✗ denied \(headless\): rm -rf \.\/build/.test(r.err) && fs.existsSync(path.join(proj, 'build')), r.err.slice(-300));

  script = [textCalls({ name: 'list_dir', arguments: { path: '.' } }), textCalls({ name: 'list_dir', arguments: { path: '.' } })];
  r = await runCli(['run', 'keep going', '--folder', proj, '--max-steps', '1']);
  check('a run that stops: exit 1 with the reason', r.code === 1 && /\[stopped\] .*max steps/.test(r.err), `${r.code} ${r.err.slice(-300)}`);
  script = [];

  r = await runCli(['run']);
  check('bad usage: exit 2 with help', r.code === 2 && /Give the task in quotes/.test(r.err));
  check('CLI options never touch config.json', fs.readFileSync(path.join(process.env.LOCALDEX_HOME!, 'config.json'), 'utf8') === cfgBefore);
}

// ---------- AK: User hooks (S5) ----------
console.log('\n# AK. Hooks: PreToolUse blocks, PostToolUse feedback, UserPromptSubmit, Stop; never approve');
{
  const hk = await import(`${SRC}/hooks.ts`);
  const HOME = process.env.LOCALDEX_HOME!;
  const hdir = path.join(HOME, 'hook-scripts');
  fs.mkdirSync(hdir, { recursive: true });
  const w = (n: string, body: string) => (fs.writeFileSync(path.join(hdir, n), `#!/bin/bash\n${body}\n`), fs.chmodSync(path.join(hdir, n), 0o755), path.join(hdir, n));
  const guard = w('guard.sh', 'input=$(cat); if echo "$input" | grep -q "rm -rf"; then echo "no recursive deletes in this repo" >&2; exit 2; fi; exit 0');
  const allow = w('allow.sh', 'cat >/dev/null; echo \'{"hookSpecificOutput":{"permissionDecision":"allow"}}\'');
  const post = w('post.sh', 'cat >/dev/null; echo \'{"hookSpecificOutput":{"additionalContext":"remember to run the linter"}}\'');
  const prompt = w('prompt.sh', 'input=$(cat); if echo "$input" | grep -q "DROP DATABASE"; then echo \'{"decision":"block","reason":"not allowed here"}\'; else echo "Team rule: use pnpm"; fi');
  const slow = w('slow.sh', 'sleep 5');
  let stopCount = 0;
  const stopFile = path.join(hdir, 'stopped-once');
  const stop = w('stop.sh', `cat >/dev/null; if [ ! -f ${stopFile} ]; then touch ${stopFile}; echo '{"decision":"block","reason":"also update the changelog"}'; fi`);
  fs.writeFileSync(path.join(HOME, 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: guard }, { type: 'command', command: allow }, { type: 'command', command: slow, timeout: 1 }] }],
    PostToolUse: [{ matcher: 'Read|Edit', hooks: [{ type: 'command', command: post }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: prompt }] }],
    Stop: [{ hooks: [{ type: 'command', command: stop }] }],
  } }));
  check('names and fields in Claude Code terms', hk.ccToolName('shell_run') === 'Bash' && hk.ccToolName('edit_file') === 'Edit' && hk.ccToolInput('read_file', { path: 'a' }).file_path === 'a');
  check('off by default: nothing runs', !hk.hooksActive() && (await hk.runHooks('PreToolUse', { tool_input: { command: 'rm -rf /' } }, 'Bash')).block === false);
  updateSettings({ hooksSource: 'localdex' });
  fs.mkdirSync(path.join(DEMO, 'hooked'), { recursive: true });
  approve = true; // even an approved dangerous command is stopped by the hook first
  const a0 = approvals;
  let r = await runWith([textCalls({ name: 'shell_run', arguments: { command: 'rm -rf ./hooked' } }), say('Blocked, so I stopped.'), say('Blocked, so I stopped.')], 'delete hooked');
  const blockedRes = toolResults(r.messages)[0]?.content ?? '';
  check('PreToolUse: exit 2 blocks the call; the model sees the reason; no prompt shown', /Blocked by the user's hook: no recursive deletes in this repo/.test(blockedRes) && fs.existsSync(path.join(DEMO, 'hooked')) && approvals === a0, blockedRes);
  check('a hook that times out is skipped (logged), and "allow" is ignored', logs.some((l) => /\[hook PreToolUse\] skipped \(timed out\)/.test(l)) && logs.some((l) => /"allow" ignored/.test(l)));
  approve = false;
  fs.writeFileSync(path.join(DEMO, 'h.txt'), 'x\n');
  r = await runWith([textCalls({ name: 'read_file', arguments: { path: 'h.txt' } }), say('Read it.')], 'read h.txt');
  check('PostToolUse: feedback appended to the tool result', /\[hook feedback\] remember to run the linter/.test(toolResults(r.messages)[0]?.content ?? ''), toolResults(r.messages)[0]?.content);
  const hs = createSession('gemma-mock');
  const before = requests.length;
  await runnerFor(hs).handleUserMessage('run DROP DATABASE prod');
  check('UserPromptSubmit: a blocked message is not sent to the model', requests.length === before && !hs.messages.some((m: any) => /DROP DATABASE/.test(m.content)));
  script = [say('Done with the task.'), say('Changelog updated too.')];
  await runnerFor(hs).handleUserMessage('small change please');
  check('UserPromptSubmit: plain stdout becomes context', hs.messages.some((m: any) => m.role === 'user' && /From your hooks:\nTeam rule: use pnpm/.test(m.content)));
  check('Stop: a blocking Stop hook gets one more turn with its reason', hs.messages.some((m: any) => /Your hook asked to keep going: also update the changelog/.test(m.content)) && hs.messages.at(-1)?.content === 'Changelog updated too.', JSON.stringify(hs.messages.slice(-3).map((m: any) => String(m.content).slice(0, 50))));
  updateSettings({ hooksSource: 'off' });
  void stopCount;
}

// ---------- AL: Selectable edit format (A8) ----------
console.log('\n# AL. Edit styles: apply_patch and str_replace_editor');
{
  const es = await import(`${SRC}/tools/editStyles.ts`);
  const { editStyleFor } = await import(`${SRC}/tools/index.ts`);
  const patchText = '*** Begin Patch\n*** Update File: p.py\n@@ def f\n def f():\n-    return 1\n+    return 2\n*** Add File: q.py\n+print("q")\n*** End Patch';
  const ops = es.parsePatch(patchText);
  check('parse: update + add with hunks', ops.length === 2 && ops[0].kind === 'update' && ops[0].hunks![0].join('|') === ' def f():|-    return 1|+    return 2' && ops[1].lines![0] === 'print("q")');
  check('parse: malformed patches are refused', (() => { try { es.parsePatch('*** Update File: x'); return false; } catch { return true; } })());
  check('hunks: forgive trailing whitespace, keep the final newline', es.applyHunks('a\nb  \nc\n', [[' a', '-b', '+B', ' c']]) === 'a\nB\nc\n');
  check('hunks: a hunk that does not match is refused with its first line', (() => { try { es.applyHunks('x\n', [['-nope', '+y']]); return false; } catch (e) { return /does not match.*nope/.test((e as Error).message); } })());

  updateSettings({ editStyle: { 'gemma-mock': 'apply_patch' } });
  const names = enabledTools('main', { model: 'gemma-mock' }).map((t: any) => t.function.name);
  check('apply_patch style: only apply_patch is offered for that model', names.includes('apply_patch') && !names.includes('edit_file') && !names.includes('write_file') && !names.includes('str_replace_editor') && editStyleFor('other') === 'edit_file', names.join(','));
  fs.writeFileSync(path.join(DEMO, 'p.py'), 'def f():\n    return 1\n');
  let r = await runWith([textCalls({ name: 'apply_patch', arguments: { patch: patchText } }), say('patched')], 'patch it');
  check('read-before-edit still applies to apply_patch', /has not been read/.test(toolResults(r.messages)[0].content) && read('p.py').includes('return 1'), toolResults(r.messages)[0].content.slice(0, 200));
  r = await runWith([textCalls({ name: 'read_file', arguments: { path: 'p.py' } }), textCalls({ name: 'apply_patch', arguments: { patch: patchText } }), say('patched')], 'patch it after reading');
  check('apply_patch: updates and adds files', read('p.py') === 'def f():\n    return 2\n' && read('q.py') === 'print("q")\n' && /Patch applied: updated p\.py; added q\.py/.test(toolResults(r.messages)[1].content), toolResults(r.messages)[1].content);

  updateSettings({ editStyle: { 'gemma-mock': 'str_replace_editor' } });
  fs.writeFileSync(path.join(DEMO, 's.txt'), 'one\ntwo\n');
  r = await runWith([
    textCalls({ name: 'str_replace_editor', arguments: { command: 'view', path: 's.txt' } }),
    textCalls({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: 's.txt', old_str: 'two', new_str: 'TWO' } }),
    textCalls({ name: 'str_replace_editor', arguments: { command: 'insert', path: 's.txt', insert_line: 0, new_str: 'zero' } }),
    textCalls({ name: 'str_replace_editor', arguments: { command: 'create', path: 'new.txt', file_text: 'fresh\n' } }),
    say('edited'),
  ], 'edit s.txt');
  check('str_replace_editor: view → str_replace → insert → create', read('s.txt') === 'zero\none\nTWO\n' && read('new.txt') === 'fresh\n', `${JSON.stringify(read('s.txt'))} ${toolResults(r.messages).map((m: any) => m.ok).join(',')}`);
  updateSettings({ editStyle: {}, permissionPreset: 'read-only' });
  check('Read only preset: no edit tool of any style', !enabledTools('main', { model: 'gemma-mock' }).some((t: any) => ['apply_patch', 'str_replace_editor', 'edit_file', 'write_file'].includes(t.function.name)));
  updateSettings({ permissionPreset: 'full' });
}

// ---------- AM: Scheduled goal runs (E5) ----------
console.log('\n# AM. Scheduled goals: due once per slot, approved folders only, starts a goal session');
{
  const sch = await import(`${SRC}/schedule.ts`);
  check('validation: time format, a day, an approved folder', typeof sch.saveSchedule({ brief: 'x', time: '7:30' }) === 'string' && typeof sch.saveSchedule({ brief: 'x', time: '07:30', days: [] }) === 'string' && /approved folders/.test(String(sch.saveSchedule({ brief: 'x', time: '07:30', folder: '/etc' }))) && typeof sch.saveSchedule({ brief: '', time: '07:30' }) === 'string');
  const sc = sch.saveSchedule({ brief: 'Run the tests and fix failures', time: '07:30', days: [1, 2, 3, 4, 5] }) as any;
  check('saved with defaults (first approved folder, local lead, 10 iterations)', sc.id && sc.folder === DEMO && sc.lead === 'local' && sc.maxIterations === 10 && sch.listSchedules().length === 1);
  const mon0729 = new Date(2026, 10, 2, 7, 29);
  const mon0731 = new Date(2026, 10, 2, 7, 31);
  const mon0745 = new Date(2026, 10, 2, 7, 45);
  const sun0731 = new Date(2026, 10, 1, 7, 31);
  check('due: in the slot (and 10 min after), not before, not on unscheduled days, not long after', sch.dueSlot(sc, mon0729) === null && sch.dueSlot(sc, mon0731) !== null && sch.dueSlot(sc, sun0731) === null && sch.dueSlot(sc, mon0745) === null);
  const started: string[] = [];
  const starter = async (x: any) => {
    const s = createSession('gemma-mock');
    s.title = `⏰ ${x.brief}`;
    const r = runnerFor(s);
    r.setGoal({ mode: 'goal', brief: sch.scheduledBrief(x), doneCriteria: x.doneCriteria, maxIterations: 1, lead: 'local' });
    script = [say('Tests pass.'), say('{"done": true, "remaining": []}'), say('{"done": true, "remaining": []}')];
    await r.startGoalRun();
    started.push(s.id);
    return s.id;
  };
  const n1 = await sch.tickSchedules(mon0731, starter);
  const n2 = await sch.tickSchedules(new Date(2026, 10, 2, 7, 32), starter);
  check('tick: starts once per slot, records the session', n1 === 1 && n2 === 0 && sch.listSchedules()[0].lastSessionId === started[0], `${n1} ${n2}`);
  const { getSession } = await import(`${SRC}/store.ts`);
  const ran = getSession(started[0]);
  check('the run is a goal session with the scheduled brief', !!ran && /Run the tests and fix failures/.test(ran.goal?.brief ?? '') && /Scheduled run: 07:30/.test(ran.goal?.brief ?? ''), ran?.goal?.brief);
  sch.saveSchedule({ ...sch.listSchedules()[0], enabled: false });
  check('disabled schedules never start', sch.dueSlot(sch.listSchedules()[0], new Date(2026, 10, 3, 7, 31)) === null);
  check('delete', sch.deleteSchedule(sc.id) && sch.listSchedules().length === 0);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
