import type { ChatMessage, CouncilRun, CouncilRunAccess, EscalatePattern, GoalLead, GoalMode, MemberId, Session, SessionMode } from '@localdex/shared';
import { getSettings } from '../config.js';
import { enabledTools } from '../tools/index.js';
import { saveSession } from '../store.js';
import { bus } from './bus.js';
import { compactMain, maybeCompactMain, verifiedFileFacts } from './compact.js';
import { assessGoal, goalCouncilAssessTask, parseAssessment } from './goal.js';
import { beginTurn, endTurn } from '../checkpoints.js';
import { runLoop } from './loop.js';
import { goalContinuePrompt, mainSystemPrompt } from './prompts.js';
import { WorkerManager } from './workers.js';
import { redactIfEnabled, runCouncil, runSummary, runVia, type CouncilContext } from '../council/orchestrator.js';
import { classify, classifyWithLocal, domainBuilder, markNotRisky, parseCommand, settingsForAccess, withRisk, type Route } from '../council/router.js';
import type { CouncilRequest } from '../tools/types.js';

/** Orchestrates one session: main loop, corrections, workers, goal/loop autonomy, compaction. */
export class SessionRunner {
  private abort: AbortController | null = null;
  /** Messages sent while a run is in flight, each with the access picked for it (Council mode). */
  private corrections: QueuedMessage[] = [];
  /** Set when a Solo run got stuck and Settings → Council says to hand it over automatically. */
  private pendingEscalation: string | null = null;
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
  async handleUserMessage(content: string, access?: CouncilRunAccess, notRisky = false): Promise<void> {
    if (this.running) {
      this.corrections.push({ content, ...(access ? { access } : {}), ...(notRisky ? { notRisky } : {}) });
      bus.log('info', 'Correction queued; it will be delivered before the next model call.');
      return;
    }
    if (this.session.messages.length === 0 || this.session.title === 'New session') {
      this.session.title = content.trim().split('\n')[0].slice(0, 60) || 'New session';
    }
    this.session.messages.push({ role: 'user', content, ts: Date.now() });
    this.persist();
    this.sync();
    if (this.councilMode) await this.runCouncilTurn(content, access, notRisky);
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

  /** "New conversation with members": forget every member's own session, so the next message starts fresh. */
  clearMemberSessions(): void {
    delete this.session.memberSessions;
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
  private async runCouncilTurn(content: string, access?: CouncilRunAccess, notRisky = false): Promise<void> {
    await this.councilTurn(async (signal) => {
      // The access picked for this message also steers routing (e.g. "Read only" never routes to a builder).
      const c = settingsForAccess(access);
      let route = parseCommand(content);
      if (!route) {
        if (c.defaultPattern === 'auto') route = c.routing === 'local' ? await classifyWithLocal(content, signal, c, { notRisky }) : classify(content, c, { notRisky });
        else route = { ...classify(content, c, { notRisky }), pattern: c.defaultPattern, note: `default pattern: ${c.defaultPattern}` };
      }
      // Rate risk on what was asked, before conversation context is appended (slash commands keep their pattern).
      route = notRisky ? markNotRisky(route) : withRisk(route);
      if (route.riskOverridden?.length) bus.log('info', `[council] you marked this message not risky (classifier said: ${route.riskOverridden.join(', ')})`);
      const asked = route.task;
      // chatMessage lets a follow-up to the same member continue its own session with just this message.
      route = { ...route, chatMessage: asked, ...(access ? { access } : {}) };
      const history = conversationContext(this.session.messages.slice(0, -1));
      if (history) route = { ...route, task: `${route.task}\n\n---\nEarlier in this conversation (for context):\n${history}` };
      return { route, asked };
    });
  }

  /**
   * "Hand to council" from a Solo chat: the latest real request plus a summary of what the local agent did goes to
   * the council as one run. The answer is appended here as a council turn; the session stays in Solo mode.
   */
  async escalate(opts: { pattern: EscalatePattern; member?: MemberId; note?: string; access?: CouncilRunAccess; notRisky?: boolean }): Promise<void> {
    const sid = this.session.id;
    if (this.running) {
      const msg = 'A run is in progress. Wait for it to finish (or press Stop), then hand it to the council.';
      bus.log('warn', msg);
      bus.emit({ type: 'error', sessionId: sid, message: msg });
      return;
    }
    const request = lastUserRequest(this.session.messages);
    if (!request) {
      bus.emit({ type: 'error', sessionId: sid, message: 'Nothing to hand over yet: send a request first.' });
      return;
    }
    const pattern: EscalatePattern = Object.hasOwn(ESCALATE_LABELS, opts.pattern) ? opts.pattern : 'auto';
    const note = (opts.note ?? '').trim().slice(0, 2000);
    const label = pattern === 'single' && opts.member ? `ask ${opts.member}` : ESCALATE_LABELS[pattern];
    // Bracketed, so later council context and the next hand-over skip it; it also keeps user/assistant turns alternating.
    this.session.messages.push({ role: 'user', content: `[Handed to council: ${label}]${note ? ` ${note}` : ''}`, ts: Date.now() });
    this.persist();
    this.sync();
    await this.councilTurn(async (signal) => {
      const asked = note ? `${request}\n\nNote from the user: ${note}` : request;
      const c = settingsForAccess(opts.access);
      let route: Route;
      const nr = { notRisky: opts.notRisky === true };
      if (pattern === 'auto') route = c.routing === 'local' ? await classifyWithLocal(asked, signal, c, nr) : classify(asked, c, nr);
      else if (pattern === 'single') route = { ...classify(asked, c, nr), pattern: 'single', member: opts.member, note: opts.member ? `handed over → ${opts.member}` : 'handed over → router picks the member' };
      else if (pattern === 'vote') route = { pattern: 'vote', role: 'researcher', task: asked, note: 'handed over → vote' };
      else route = { pattern, role: domainBuilder(asked).role, task: asked, note: `handed over → ${ESCALATE_LABELS[pattern]}` };
      // Risk is rated on the request itself, before the local agent's history is appended.
      const base: Route = { ...route, task: asked, escalated: true, ...(opts.access ? { access: opts.access } : {}) };
      route = nr.notRisky ? markNotRisky(base) : withRisk(base);
      if (route.riskOverridden?.length) bus.log('info', `[council] you marked this request not risky (classifier said: ${route.riskOverridden.join(', ')})`);
      const work = localWorkSummary(this.session.messages);
      if (work) route = { ...route, task: `${asked}\n\n---\nEarlier in this conversation, LocalDex's local agent worked on this in Solo mode. What it did:\n${work}` };
      return { route, asked };
    });
  }

  /** One council run as a chat turn: run it, then append the call, its summary and the answer (with `via`). */
  private async councilTurn(prepare: (signal: AbortSignal) => Promise<{ route: Route; asked: string }>): Promise<void> {
    if (this.running) return;
    const ac = new AbortController();
    this.abort = ac;
    const s = this.session;
    try {
      const { route, asked } = await prepare(ac.signal);
      bus.log('info', `[council] ${route.note} · risk: ${route.risk}${route.riskReasons?.length ? ` (${route.riskReasons.join(', ')})` : ''}${route.access ? ` · access: ${route.access}` : ''}`);

      const run = await runCouncil(this.councilContext(ac.signal), route);
      this.appendCouncilTurn(run, asked);
      // A council-led goal continues after a normal council turn, so a chat message in Council mode doesn't stall it.
      if (s.goal?.active && (s.goal.lead ?? 'local') === 'council' && !ac.signal.aborted && !this.corrections.length) {
        await this.councilGoalIterations(ac.signal, run);
      }
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
        const next = pending.map((m) => m.content).join('\n\n');
        s.messages.push({ role: 'user', content: next, ts: Date.now() });
        // Queued follow-ups keep the access picked for them; several at once get the strictest one.
        void (this.councilMode ? this.runCouncilTurn(next, strictestAccess(pending.map((m) => m.access)), pending.every((m) => m.notRisky === true)) : this.run());
      }
    }
  }

  /** Append one finished council run to the chat: the call, its step summary, and the answer (with `via`). */
  private appendCouncilTurn(run: CouncilRun, asked: string): void {
    const s = this.session;
    const callId = `council-${run.id}`;
    const now = Date.now();
    s.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'council', arguments: JSON.stringify({ pattern: run.pattern, task: asked }) } }], ts: now });
    s.messages.push({ role: 'tool', tool_call_id: callId, name: 'council', content: runSummary(run), ok: run.status === 'done', ts: now });
    s.messages.push({ role: 'assistant', content: run.result ?? '(no result)', via: runVia(run), councilRunId: run.id, ts: now });
    this.persist();
    this.sync();
  }

  /**
   * Council-led goal (goal.lead = 'council'): each iteration is a council turn with the brief plus the last checkpoint,
   * and the finish checkpoint is judged by the council's reviewer role, never by the local model. `lastRun` is a run
   * that already happened this turn (counts as the first iteration); otherwise the first iteration starts here.
   * Respects maxIterations and Stop, like the local goal controller in run().
   */
  private async councilGoalIterations(signal: AbortSignal, lastRun?: CouncilRun): Promise<void> {
    const s = this.session;
    let run = lastRun;
    while (!signal.aborted) {
      const goal = s.goal;
      if (!goal?.active || (goal.lead ?? 'local') !== 'council') return;
      if (!run) {
        const c = getSettings().council;
        const task = goalIterationTask(goal);
        let route = classify(task, c);
        route = { ...route, task, note: `goal iteration ${goal.iteration + 1} (council-led): ${route.note}` };
        bus.log('info', `[council] goal iteration ${goal.iteration + 1}: ${route.note}`);
        run = await runCouncil(this.councilContext(signal), route);
        this.appendCouncilTurn(run, task);
        if (signal.aborted) return;
      }
      goal.iteration += 1;
      if (goal.iteration >= goal.maxIterations) {
        goal.active = false;
        bus.log('info', `Goal stopped: reached ${goal.maxIterations} iterations.`);
        s.messages.push({ role: 'user', content: `[Goal paused] Reached the iteration cap (${goal.maxIterations}). Raise it or clear the goal to continue.`, ts: Date.now() });
        this.persist();
        this.sync();
        return;
      }
      const a = await this.assessGoalWithCouncil(signal, run);
      if (signal.aborted) return;
      goal.remaining = a.remaining;
      goal.lastAssessment = a.note;
      this.persist();
      this.sync();
      if (a.done) {
        goal.active = false;
        bus.log('info', `Goal complete (council reviewer): ${a.note}`);
        return;
      }
      bus.log('info', `Goal iteration ${goal.iteration} (council): ${a.note || 'continuing'}`);
      s.messages.push({ role: 'user', content: goalContinuePrompt(goal.brief, a.remaining, goal.mode), ts: Date.now() });
      this.persist();
      this.sync();
      run = undefined;
    }
  }

  /** The finish checkpoint of a council-led goal: a single read-only run on the reviewer role, parsed like the local one. */
  private async assessGoalWithCouncil(signal: AbortSignal, lastRun: CouncilRun): Promise<{ done: boolean; remaining: string[]; note: string }> {
    const goal = this.session.goal!;
    bus.emit({ type: 'agent_status', sessionId: this.session.id, agent: 'main', status: 'thinking', detail: 'Finish checkpoint (council reviewer)…' });
    const facts = await verifiedFileFacts(this.session.messages).catch(() => '');
    const task = goalCouncilAssessTask({ brief: goal.brief, doneCriteria: goal.doneCriteria, mode: goal.mode, iteration: goal.iteration }, lastRun.result ?? '', facts);
    const run = await runCouncil(this.councilContext(signal), { pattern: 'single', role: 'reviewer', task, access: 'read', note: `goal checkpoint ${goal.iteration} (council reviewer)`, risk: 'normal', riskReasons: [] });
    if (run.status !== 'done' || !run.result) {
      // Fail open, like the local checkpoint: not done, and the user keeps control through Stop and the iteration cap.
      const why = run.result ?? run.status;
      bus.log('warn', `goal checkpoint: the council reviewer gave no answer (${String(why).slice(0, 160)})`);
      return { done: false, remaining: [], note: `checkpoint unavailable: ${String(why).split('\n')[0].slice(0, 160)}` };
    }
    const a = parseAssessment(run.result);
    if (goal.mode === 'loop') a.done = false;
    return { ...a, note: `${a.note || '(no note)'} (judged by ${runVia(run)})` };
  }

  stop(): void {
    if (!this.abort) return;
    bus.log('info', 'Stopping…');
    bus.cancelPrompts(this.session.id);
    this.abort.abort();
  }

  setGoal(goal: { mode: GoalMode; brief: string; doneCriteria: string; maxIterations: number; lead?: GoalLead }): void {
    // A council-led goal needs the council on; otherwise the local loop leads, whatever the session mode says.
    const wanted: GoalLead = goal.lead === 'council' || goal.lead === 'local' ? goal.lead : this.session.mode === 'council' ? 'council' : 'local';
    const lead: GoalLead = wanted === 'council' && getSettings().council.enabled ? 'council' : 'local';
    if (wanted === 'council' && lead === 'local') bus.log('warn', 'Goal: the council is off (Settings → Council), so the local model leads this goal.');
    this.session.goal = {
      mode: goal.mode,
      lead,
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
    if ((g.lead ?? 'local') === 'council' && getSettings().council.enabled) await this.runCouncilGoal();
    else await this.run();
  }

  /** A council-led goal started on an idle session: iterate council turns until done, paused or stopped. */
  private async runCouncilGoal(): Promise<void> {
    if (this.running) return;
    const ac = new AbortController();
    this.abort = ac;
    const s = this.session;
    try {
      await this.councilGoalIterations(ac.signal);
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
        const next = pending.map((m) => m.content).join('\n\n');
        s.messages.push({ role: 'user', content: next, ts: Date.now() });
        void (this.councilMode ? this.runCouncilTurn(next, strictestAccess(pending.map((m) => m.access)), pending.every((m) => m.notRisky === true)) : this.run());
      }
    }
  }

  private pullCorrections = (): string[] => {
    const out = this.corrections;
    this.corrections = [];
    return out.map((m) => m.content);
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
      // Solo edits land on disk directly; the turn's checkpoint makes them visible and undoable.
      beginTurn(sid);

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

        if (result.reason === 'aborted') break;
        if (result.reason === 'error' || result.reason === 'stuck') {
          this.noteStopped(result.reason === 'error' ? `LM Studio returned an error: ${result.error}` : `the local model got stuck: ${result.error}`);
          break;
        }
        if (result.reason === 'max_steps') {
          s.messages.push({
            role: 'user',
            content: `[system] Step limit (${getSettings().maxSteps}) reached; run paused. Send a message to continue.${this.councilHint()}`,
            ts: Date.now(),
          });
          break;
        }

        // Deliver corrections that arrived during the final turn as a fresh run.
        if (this.corrections.length) continue;

        // Goal / Loop controller: finish checkpoint. Council-led goals are iterated by councilGoalIterations instead.
        const goal = s.goal;
        if (!goal?.active) break;
        if ((goal.lead ?? 'local') === 'council' && getSettings().council.enabled) {
          await this.councilGoalIterations(ac.signal);
          break;
        }
        goal.iteration += 1;
        if (goal.iteration >= goal.maxIterations) {
          goal.active = false;
          bus.log('info', `Goal stopped: reached ${goal.maxIterations} iterations.`);
          s.messages.push({
            role: 'user',
            content: `[Goal paused] Reached the iteration cap (${goal.maxIterations}). Raise it or clear the goal to continue.${this.councilHint()}`,
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
      const cp = endTurn(s);
      if (cp) bus.log('info', `[checkpoint] turn changed ${cp.files.length} file${cp.files.length === 1 ? '' : 's'} (+${cp.files.reduce((n, f) => n + f.added, 0)} −${cp.files.reduce((n, f) => n + f.removed, 0)}); Undo this turn is available under the answer`);
      bus.emit({ type: 'agent_status', sessionId: sid, agent: 'main', status: 'idle' });
      this.persist();
      this.sync();
      const why = this.pendingEscalation;
      this.pendingEscalation = null;
      // A correction that arrived too late to be injected becomes a new turn.
      if (this.corrections.length) {
        const pending = this.corrections;
        this.corrections = [];
        for (const c of pending) s.messages.push({ role: 'user', content: c.content, ts: Date.now() });
        void this.run();
      } else if (why && !ac.signal.aborted) {
        bus.log('info', `[council] handing the stuck request over automatically (${why})`);
        void this.escalate({ pattern: 'auto', note: `LocalDex's local model could not finish this (${why}). Pick it up from what it already did.` });
      }
    }
  }

  /**
   * The local run stopped without finishing (LM Studio error, or the loop decided the model is stuck). Say so in the
   * chat, where it stays visible, and route the request to the council when Settings → Council allows it.
   */
  private noteStopped(why: string): void {
    const c = getSettings().council;
    const route = c.enabled && (c.autoEscalate ?? 'suggest') !== 'off';
    let text = `[system] Run stopped: ${why}.`;
    if (route && c.autoEscalate === 'auto') {
      text += '\nHanding the request to the council, together with what the local agent already did.';
      this.pendingEscalation = why.slice(0, 300);
    } else {
      text += this.councilHint() || '\nTry again, load a stronger local model, or turn on the model council (Settings → Council) so LocalDex can hand requests like this to a cloud model.';
    }
    this.session.messages.push({ role: 'user', content: text, ts: Date.now() });
    bus.log('warn', `Run stopped: ${why}`);
  }

  /** Suffix pointing at Hand to council, when the council is on and suggestions are not switched off. */
  private councilHint(): string {
    const c = getSettings().council;
    if (!c.enabled || (c.autoEscalate ?? 'suggest') === 'off') return '';
    return '\nPress "Hand to council ☁" below to send the request, with what the local agent already did, to a cloud model (Claude and the other members you have signed in).';
  }

  private ensureSystemPrompt(): void {
    const prompt = mainSystemPrompt();
    const first = this.session.messages[0];
    if (first?.role === 'system') first.content = prompt;
    else this.session.messages.unshift({ role: 'system', content: prompt });
  }
}

interface QueuedMessage {
  content: string;
  access?: CouncilRunAccess;
  notRisky?: boolean;
}

const ACCESS_RANK: Record<CouncilRunAccess, number> = { read: 0, confirm: 1, auto: 2 };

/**
 * The access for several queued messages sent as one turn: the strictest one picked (read < confirm < auto).
 * Messages without a pick (Settings decide) don't loosen an explicit pick; all without one → undefined (Settings).
 */
export function strictestAccess(list: Array<CouncilRunAccess | undefined>): CouncilRunAccess | undefined {
  let out: CouncilRunAccess | undefined;
  for (const a of list) if (a && Object.hasOwn(ACCESS_RANK, a) && (!out || ACCESS_RANK[a] < ACCESS_RANK[out])) out = a;
  return out;
}

/** The task one council-led goal iteration sends: the brief, the done criteria and the last checkpoint's leftovers. */
function goalIterationTask(goal: NonNullable<Session['goal']>): string {
  const parts = [goal.mode === 'goal' ? `Goal: ${goal.brief}` : `Ongoing brief (pick the next most valuable thing and do it): ${goal.brief}`];
  if (goal.doneCriteria) parts.push(`Done when: ${goal.doneCriteria}`);
  if (goal.iteration > 0) {
    parts.push(`This is iteration ${goal.iteration + 1}. Last checkpoint: ${goal.lastAssessment || '(none)'}`);
    if (goal.remaining.length) parts.push(`Still to do:\n${goal.remaining.map((r) => `- ${r}`).join('\n')}`);
  }
  parts.push('Work toward the goal without waiting for confirmation; verify your work (run tests/builds where relevant) and report what you did.');
  return parts.join('\n');
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
  // Chat history rides along to cloud members, so keys pasted earlier in the chat are removed here too.
  return redactIfEnabled(parts.join('\n\n'));
}

const ESCALATE_LABELS: Record<EscalatePattern, string> = {
  auto: 'auto',
  single: 'ask one member',
  plan_build_review: 'plan → build → review',
  second_opinion: 'second opinion',
  vote: 'vote',
  arena: 'arena (two builders race)',
};

/** The user's latest real request: skips notes LocalDex adds itself ([system], [Goal …], [Handed to council] …). */
export function lastUserRequest(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.content.trim() && !m.content.startsWith('[')) return m.content;
  }
  return null;
}

const FILE_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * What the local agent did in this session, for a council run handed over from Solo mode: files it wrote or edited,
 * commands it ran, failures, and the conversation (newest kept when over budget). Redacted, then capped at `maxChars`.
 */
export function localWorkSummary(messages: ChatMessage[], maxChars = 20_000): string {
  const results = new Map<string, { ok?: boolean; content: string }>();
  for (const m of messages) if (m.role === 'tool') results.set(m.tool_call_id, { ok: m.ok, content: m.content });

  const files = new Map<string, Set<string>>();
  const commands: string[] = [];
  const failures: string[] = [];
  const talk: string[] = [];
  for (const m of messages) {
    if (m.role === 'user' && m.content.trim() && !m.content.startsWith('[')) talk.push(`User: ${clip(m.content, 2000)}`);
    if (m.role !== 'assistant') continue;
    if (m.content?.trim()) talk.push(`${m.via ? `Council (${m.via})` : 'Local agent'}: ${clip(m.content, 3000)}`);
    for (const call of m.tool_calls ?? []) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      const res = results.get(call.id);
      const failed = res?.ok === false;
      if (FILE_TOOLS.has(name) && typeof args.path === 'string') {
        const verbs = files.get(args.path) ?? new Set<string>();
        verbs.add(`${name === 'write_file' ? 'wrote' : 'edited'}${failed ? ' (failed)' : ''}`);
        files.set(args.path, verbs);
      } else if (name === 'shell_run' && typeof args.command === 'string') {
        commands.push(`${failed ? '✗' : res ? '✓' : '?'} $ ${clip(args.command, 300)}`);
      }
      if (failed && res) failures.push(`${name}${typeof args.path === 'string' ? ` ${args.path}` : ''}: ${clip(res.content.trim().split('\n').slice(0, 4).join(' / '), 400)}`);
    }
  }

  const lists: string[] = [];
  if (files.size) lists.push(`Files the local agent touched:\n${[...files].slice(-80).map(([f, v]) => `- ${f} (${[...v].join(', ')})`).join('\n')}`);
  if (commands.length) lists.push(`Commands it ran:\n${commands.slice(-40).join('\n')}`);
  if (failures.length) lists.push(`Failures:\n${failures.slice(-30).map((f) => `- ${f}`).join('\n')}`);
  // Redact before cutting, so a cut can't leave half a key behind.
  const head = redactIfEnabled(lists.join('\n\n'));
  // The conversation fills what is left, newest first, so the latest answers survive the cap.
  let budget = Math.max(0, maxChars - head.length - 60);
  const kept: string[] = [];
  for (let i = talk.length - 1; i >= 0 && budget > 0; i--) {
    const t = redactIfEnabled(talk[i]);
    if (t.length > budget) {
      kept.unshift(`… ${t.slice(t.length - budget + 2)}`);
      break;
    }
    kept.unshift(t);
    budget -= t.length + 2;
  }
  if (kept.length && kept.length < talk.length) kept.unshift('(earlier messages left out)');
  const out = [head, kept.length ? `Conversation:\n${kept.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
  return out.slice(0, maxChars);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
