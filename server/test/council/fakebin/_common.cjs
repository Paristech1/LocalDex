// Shared helpers for the stand-in vendor CLIs used in LocalDex council tests.
const fs = require('fs'); const path = require('path');
const CTL = process.env.FAKE_CTL || path.join(__dirname, '..', 'fakectl');
exports.flag = (name) => fs.existsSync(path.join(CTL, name));
// Record what a stand-in received so tests can assert on args/prompts: <ctl>/<name>.last.json and <name>.log.jsonl
exports.record = (name, data) => { try { fs.mkdirSync(CTL, { recursive: true }); const line = JSON.stringify({ ts: Date.now(), ...data }); fs.writeFileSync(path.join(CTL, name + '.last.json'), line); fs.appendFileSync(path.join(CTL, name + '.log.jsonl'), line + '\n'); } catch {} };
exports.out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
exports.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.readStdin = () => new Promise((r) => { let d = ''; if (process.stdin.isTTY) return r(''); process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => r(d)); });
exports.role = (text) => (/You are the PLANNER/.test(text) ? 'planner' : /You are the BUILDER/.test(text) ? 'builder' : /You are the REVIEWER/.test(text) ? 'reviewer' : /You are the JUDGE/.test(text) ? 'judge' : /independent advisers/.test(text) ? 'voter' : /RESEARCHER/.test(text) ? 'researcher' : 'quick');
exports.answer = (role, who, prompt) => {
  const fixRound = /requested fixes/.test(prompt);
  switch (role) {
    case 'planner': return `## Plan (${who})\n1. Add \`src/rateLimit.ts\` exporting \`rateLimit(maxPerMinute)\` using a sliding window keyed by IP.\n2. Wire it into \`src/server.ts\` before the routes.\n3. Add \`tests/rateLimit.test.ts\` covering under/over the limit.\n4. Verify with \`npm test\`.`;
    case 'builder': return fixRound ? `Fixed the reviewer's point: \`rateLimit\` now evicts stale timestamps so memory stays bounded (src/rateLimit.ts). (${who})` : `Implemented the plan (${who}).\n- Created \`src/rateLimit.ts\` (sliding window, 60 req/min default)\n- Added a test in \`tests/rateLimit.test.ts\`\n- Ran \`npm test\`: 3 passed`;
    case 'reviewer': return exports.flag('review_changes') && !fs.existsSync(path.join(CTL, 'reviewed_once')) ? (fs.writeFileSync(path.join(CTL, 'reviewed_once'), '1'), `VERDICT: CHANGES_REQUESTED\n- src/rateLimit.ts:8 — timestamps are never evicted, so the map grows forever. Drop entries older than the window on each call.`) : `VERDICT: APPROVE\nThe sliding window is correct and the test covers both sides of the limit. Minor: consider making the window configurable later. (${who})`;
    case 'judge': return `**Agreement:** All advisers prefer **zod** for this codebase: it is already a transitive dependency and has the larger ecosystem.\n\n**Disagreement:** Gemini notes valibot's smaller bundle matters for the web client.\n\n**Recommendation:** Use zod on the server now; revisit valibot only if the web bundle size becomes a problem.`;
    case 'voter': return who === 'gemini' ? `Valibot is tree-shakeable and much smaller in the browser, but zod is fine on the server.\n\nBottom line: zod for the server, consider valibot for the web bundle.` : `Zod: mature, great TypeScript inference, huge ecosystem, already used by your MCP dependency.\n\nBottom line: zod.`;
    case 'researcher': return `\`src/math.ts\` exports a single \`add(a, b)\` function; nothing imports it yet. The README is a one-line description. (${who})`;
    default: return `Short answer from ${who}: \`add\` returns the sum of its two arguments.`;
  }
};
