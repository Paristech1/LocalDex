import type { ChatMessage, GoalMode, Session, SessionMode } from '@localdex/shared';
import { getSettings } from '../config.js';
import { enabledTools } from '../tools/index.js';
import { saveSession } from '../store.js';
import { bus } from './bus.js';
import { compactMain, maybeCompactMain } from './compact.js';
import { assessGoal } from './goal.js';
import { runLoop } from './loop.js';
import { goalContinuePrompt, mainSystemPrompt } from './prompts.js';
import { WorkerManager } from './workers.js';
import { runCouncil, runSummary, runVia, type CouncilContext } from '../council/orchestrator.js';
import { classify, classifyWithLocal, parseCommand, withRisk, type Route } from '../council/router.js';
import type { CouncilRequest } from '../tools/types.js';

/** Orchestrates one session: main loop, corrections, workers, goal/loop autonomy, compaction. */
export class SessionRunner {
  private abort: AbortController | null = null;
  private corrections: string[] = [];
  readonly workers: WorkerManager;

  constructor(readonly session: Session) {
    this.workers = new WorkerManager(session, () => this.persist());
  }

  get running(): boolean {
    return this.abort !== null;
  }

  persist(): void {
    saveSession(this.session);
  }

  private sync(): void {
    bus.emit({ type: 'session', session: this.session });
  }

  /** User sent a message. Starts a run, or queues a correction if one is already in flight. */
  async handleUserMessage(content: string): Promise<void> {
    if (this.running) {
      this.corrections.push(content);
      bus.log('info', 'Correction queued; it will be delivered before the next model call.');
      return;
    }
    if (this.session.messages.length === 0 || this.session.title === 'New session') {
      this.session.title = content.trim().split('\n')[0].slice(0, 60) || 'New session';
    }
    this.session.messages.push({ role: 'user', content, ts: Date.now() });
    this.persist();
    this.sync();
    if (this.councilMode) await this.runCouncilTurn(content);
    else await this.run();
  }

  /** Council mode is on for this session and the council is enabled in Settings. */
  get councilMode(): boolean {
    return this.session.mode === 'council' && getSettings().council.enabled;
  }

  setMode(mode: SessionMode): void {
    this.session.mode = mode;
    this.persist();
    this.sync();
  }

  private councilContext(signal: AbortSignal): CouncilContext {
    return {
      session: this.session,
      signal,
      persist: () => {
        this.persist();
        this.sync();
      },
      delegateLocal: (name, task) => this.workers.delegate(name, task, signal),
    };
  }

  /** The local lead agent's ask_member / council tools land here. */
  private councilFor(signal: AbortSignal) {
    return async (req: CouncilRequest): Promise<string> => {
      const route: Route = { pattern: req.pattern, role: req.role, member: req.member, task: req.task, note: 'requested by the local lead agent' };
      const run = await runCouncil(this.councilContext(signal), route);
      return `[council ${run.pattern} via ${runVia(run)}]\n${runSummary(run)}\n\n${run.result ?? '(no result)'}`;
    };
  }

  /** Council mode: route the message to cloud members instead of the local model. */
  private async runCouncilTurn(content: string): Promise<void> {
    if (this.running) return;
    const ac = new AbortController();
    this.abort = ac;
    const s = this.session;
    try {
      const c = getSettings().council;
      let route = parseCommand(content);
      if (!route) {
        if (c.defaultPattern === 'auto') route = c.routing === 'local' ? await classifyWithLocal(content, ac.signal) : classify(content);
        else route = { ...classify(content), pattern: c.defaultPattern, note: `default pattern: ${c.defaultPattern}` };
      }
      // Rate risk on what was asked, before conversation context is appended (slash commands keep their pattern).
      route = withRisk(route);
      const asked = route.task;
      const history = conversationContext(s.messages.slice(0, -1));
      if (history) route = { ...route, task: `${route.task}\n\n---\nEarlier in this conversation (for context):\n${history}` };
      bus.log('info', `[council] ${route.note} · risk: ${route.risk}${route.riskReasons?.length ? ` (${route.riskReasons.join(', ')})` : ''}`);

      const run = await runCouncil(this.councilContext(ac.signal), route);
      const callId = `council-${run.id}`;
      const now = Date.now();
      s.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'council', arguments: JSON.stringify({ pattern: run.pattern, task: asked }) } }], ts: now });
      s.messages.push({ role: 'tool', tool_call_id: callId, name: 'council', content: runSummary(run), ok: run.status === 'done', ts: now });
      s.messages.push({ role: 'assistant', content: run.result ?? '(no result)', via: runVia(run), ts: now });
    } catch (e) {
      const msg = (e as Error).message;
      if (!ac.signal.aborted) {
        bus.log('error', msg);
        bus.emit({ type: 'error', sessionId: s.id, message: msg });
      }
    } finally {
      this.abort = null;
      bus.emit({ type: 'agent_status', sessionId: s.id, agent: 'main', status: 'idle' });
      this.persist();
      this.sync();
      if (this.corrections.length) {
        const pending = this.corrections;
        this.corrections = [];
        const next = pending.join('\n\n');
        s.messages.push({ role: 'user', content: next, ts: Date.now() });
        void (this.councilMode ? this.runCouncilTurn(next) : this.run());
      }
    }
  }

  stop(): void {
    if (!this.abort) return;
    bus.log('info', 'Stopping…');
    bus.cancelPrompts(this.session.id);
    this.abort.abort();
  }

  setGoal(goal: { mode: GoalMode; brief: string; doneCriteria: string; maxIterations: number }): void {
    this.session.goal = {
      mode: goal.mode,
      brief: goal.brief,
      doneCriteria: goal.doneCriteria,
      maxIterations: Math.max(1, goal.maxIterations || 10),
      iteration: 0,
      active: true,
      remaining: [],
    };
    this.persist();
    this.sync();
  }

  clearGoal(): void {
    if (this.session.goal) this.session.goal.active = false;
    this.persist();
    this.sync();
  }

  async compact(): Promise<void> {
    if (this.running) {
      bus.log('warn', 'Cannot compact while a run is in progress; press Stop first.');
      return;
    }
    await compactMain(this.session, undefined, 'manual');
    this.persist();
  }

  /** Kick off a goal run without a new user message (e.g. user set a goal on an idle session). */
  async startGoalRun(): Promise<void> {
    if (this.running || !this.session.goal?.active) return;
    const g = this.session.goal;
    this.session.messages.push({
      role: 'user',
      content: g.mode === 'goal' ? `[Goal set] ${g.brief}${g.doneCriteria ? `\nDone when: ${g.doneCriteria}` : ''}` : `[Loop started] ${g.brief}`,
      ts: Date.now(),
    });
    if (this.session.title === 'New session') this.session.title = g.brief.slice(0, 60);
    this.persist();
    this.sync();
    await this.run();
  }

  private pullCorrections = (): string[] => {
    const out = this.corrections;
    this.corrections = [];
    return out;
  };

  private async run(): Promise<void> {
    if (this.running) return;
    const ac = new AbortController();
    this.abort = ac;
    const s = this.session;
    const sid = s.id;

    try {
      const model = s.model ?? getSettings().model;
      if (!model) {
        bus.emit({ type: 'error', sessionId: sid, message: 'Pick a model first (top bar).' });
        return;
      }
      s.model = model;
      this.ensureSystemPrompt();

      // Main loop, possibly repeated by the goal controller.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await runLoop({
          sessionId: sid,
          agent: 'main',
          model,
          messages: s.messages,
          tools: enabledTools('main'),
          signal: ac.signal,
          maxSteps: getSettings().maxSteps,
          delegate: (name, task) => this.workers.delegate(name, task, ac.signal),
          council: getSettings().council.enabled ? this.councilFor(ac.signal) : undefined,
          updatePlan: (steps) => {
            s.plan = steps;
            this.persist();
            this.sync();
          },
          pullCorrections: this.pullCorrections,
          beforeStep: async () => {
            this.ensureSystemPrompt();
            await maybeCompactMain(s, ac.signal);
          },
          onUsage: (u) => {
            s.usage.promptTokens += u.promptTokens;
            s.usage.completionTokens += u.completionTokens;
            s.usage.lastPromptTokens = u.promptTokens;
          },
          onPersist: () => {
            this.persist();
            this.sync();
          },
        });

        if (result.reason === 'aborted' || result.reason === 'error') break;
        if (result.reason === 'max_steps') {
          s.messages.push({
            role: 'user',
            content: `[system] Step limit (${getSettings().maxSteps}) reached; run paused. Send a message to continue.`,
            ts: Date.now(),
          });
          break;
        }

        // Deliver corrections that arrived during the final turn as a fresh run.
        if (this.corrections.length) continue;

        // Goal / Loop controller: finish checkpoint.
        const goal = s.goal;
        if (!goal?.active) break;
        goal.iteration += 1;
        if (goal.iteration >= goal.maxIterations) {
          goal.active = false;
          bus.log('info', `Goal stopped: reached ${goal.maxIterations} iterations.`);
          s.messages.push({
            role: 'user',
            content: `[Goal paused] Reached the iteration cap (${goal.maxIterations}). Raise it or clear the goal to continue.`,
            ts: Date.now(),
          });
          break;
        }
        const a = await assessGoal(s, ac.signal);
        if (ac.signal.aborted) break;
        goal.remaining = a.remaining;
        goal.lastAssessment = a.note;
        this.persist();
        this.sync();
        if (a.done) {
          goal.active = false;
          bus.log('info', `Goal complete: ${a.note}`);
          break;
        }
        bus.log('info', `Goal iteration ${goal.iteration}: ${a.note || 'continuing'}`);
        s.messages.push({ role: 'user', content: goalContinuePrompt(goal.brief, a.remaining, goal.mode), ts: Date.now() });
        this.persist();
        this.sync();
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (!ac.signal.aborted) {
        bus.log('error', msg);
        bus.emit({ type: 'error', sessionId: sid, message: msg });
      }
    } finally {
      this.abort = null;
      bus.emit({ type: 'agent_status', sessionId: sid, agent: 'main', status: 'idle' });
      this.persist();
      this.sync();
      // A correction that arrived too late to be injected becomes a new turn.
      if (this.corrections.length) {
        const pending = this.corrections;
        this.corrections = [];
        for (const c of pending) s.messages.push({ role: 'user', content: c, ts: Date.now() });
        void this.run();
      }
    }
  }

  private ensureSystemPrompt(): void {
    const prompt = mainSystemPrompt();
    const first = this.session.messages[0];
    if (first?.role === 'system') first.content = prompt;
    else this.session.messages.unshift({ role: 'system', content: prompt });
  }
}

/** Recent user/assistant text so council members can follow up on earlier turns. */
function conversationContext(messages: ChatMessage[], maxChars = 6000): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && used < maxChars; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.content.startsWith('[')) {
      const t = `User: ${m.content}`;
      parts.unshift(t.slice(0, 1500));
      used += Math.min(t.length, 1500);
    } else if (m.role === 'assistant' && m.content) {
      const t = `Assistant${m.via ? ` (${m.via})` : ''}: ${m.content}`;
      parts.unshift(t.slice(0, 2000));
      used += Math.min(t.length, 2000);
    }
    if (parts.length >= 8) break;
  }
  return parts.join('\n\n');
}

const runners = new Map<string, SessionRunner>();

export function runnerFor(session: Session): SessionRunner {
  let r = runners.get(session.id);
  if (!r) {
    r = new SessionRunner(session);
    runners.set(session.id, r);
  }
  return r;
}

export function dropRunner(id: string): void {
  runners.get(id)?.stop();
  runners.delete(id);
}
