import type { Session, WorkerState } from '@localdex/shared';
import { getSettings } from '../config.js';
import { enabledTools } from '../tools/index.js';
import { bus } from './bus.js';
import { runLoop } from './loop.js';
import { workerSystemPrompt } from './prompts.js';
import { maybeCompactWorker } from './compact.js';

/** Simple counting semaphore so parallel delegations don't flood a single-model LM Studio. */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private limit: () => number) {}
  async acquire(): Promise<() => void> {
    if (this.active < Math.max(1, this.limit())) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    return () => this.release();
  }
  private release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class WorkerManager {
  private sem = new Semaphore(() => getSettings().workerConcurrency);

  constructor(
    private session: Session,
    private persist: () => void,
  ) {}

  getOrCreate(name: string): WorkerState {
    let w = this.session.workers[name];
    if (!w) {
      const now = Date.now();
      w = {
        name,
        model: null,
        messages: [],
        archive: [],
        status: 'idle',
        lastTask: null,
        lastResult: null,
        createdAt: now,
        updatedAt: now,
      };
      this.session.workers[name] = w;
    }
    return w;
  }

  async delegate(name: string, task: string, signal: AbortSignal): Promise<string> {
    const w = this.getOrCreate(name);
    const agent = `worker:${name}` as const;
    const sessionId = this.session.id;
    if (w.status === 'running' || w.status === 'queued') {
      return `Worker "${name}" is already busy with another task. Wait for its report or use a different name.`;
    }

    w.status = 'queued';
    w.lastTask = task;
    w.updatedAt = Date.now();
    this.persist();
    bus.emit({ type: 'agent_status', sessionId, agent, status: 'queued' });
    bus.emit({ type: 'session', session: this.session });

    const release = await this.sem.acquire();
    try {
      if (signal.aborted) return 'Cancelled before the worker started.';
      w.status = 'running';
      const model = getSettings().workerModel ?? this.session.model ?? getSettings().model;
      if (!model) return 'No model selected.';
      w.model = model;

      if (w.messages.length === 0) {
        w.messages.push({ role: 'system', content: workerSystemPrompt(name) });
      } else {
        w.messages[0] = { role: 'system', content: workerSystemPrompt(name) };
      }
      w.messages.push({ role: 'user', content: task, ts: Date.now() });
      const startIndex = w.messages.length;

      const result = await runLoop({
        sessionId,
        agent,
        model,
        messages: w.messages,
        tools: enabledTools('worker'),
        signal,
        maxSteps: getSettings().maxSteps,
        beforeStep: () => maybeCompactWorker(this.session, w),
        onUsage: (u) => {
          this.session.usage.promptTokens += u.promptTokens;
          this.session.usage.completionTokens += u.completionTokens;
        },
        onPersist: () => {
          w.updatedAt = Date.now();
          this.persist();
        },
      });

      let report = result.text.trim();
      const toolMsgs = w.messages.slice(startIndex).filter((m) => m.role === 'tool');
      const mutating = toolMsgs.filter((m) => m.role === 'tool' && /^(write_file|edit_file|shell_run|terminal_)/.test(m.name ?? ''));
      if (toolMsgs.length === 0) {
        report += '\n\n[note: this worker made NO tool calls while handling the task; treat any claims about files or commands as unverified]';
      } else if (mutating.length === 0 && /creat|wrote|written|edited|modified|ran|executed/i.test(report)) {
        report += '\n\n[note: this worker only used read-only tools; it did not write files or run commands]';
      }
      if (result.reason === 'max_steps') report += `\n\n[worker hit the step limit (${getSettings().maxSteps}) before finishing]`;
      if (result.reason === 'error') report = `[worker error] ${result.error}\n${report}`;
      if (result.reason === 'aborted') report = `[worker cancelled]\n${report}`;
      if (result.reason === 'stuck') report = `[worker got stuck: ${result.error}. Its work may be incomplete; check the files before relying on it.]\n${report}`;
      if (!report) report = '(worker finished without a report)';

      w.lastResult = report;
      w.status = result.reason === 'error' ? 'error' : 'idle';
      return report;
    } finally {
      release();
      if (w.status === 'running' || w.status === 'queued') w.status = 'idle';
      w.updatedAt = Date.now();
      this.persist();
      bus.emit({ type: 'agent_status', sessionId, agent, status: w.status });
      bus.emit({ type: 'session', session: this.session });
    }
  }
}
