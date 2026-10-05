import { randomUUID } from 'node:crypto';
import type { AgentId, ServerEvent } from '@localdex/shared';

type Listener = (ev: ServerEvent) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  sessionId: string;
}

/** Broadcasts server events to all connected UIs and tracks prompts awaiting a user response. */
export class Bus {
  private listeners = new Set<Listener>();
  private pending = new Map<string, Pending>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(ev: ServerEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* ignore */
      }
    }
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${level}] ${message}`);
    this.emit({ type: 'log', level, message });
  }

  requestApproval(sessionId: string, agent: AgentId, command: string, cwd: string, signal: AbortSignal): Promise<boolean> {
    const id = randomUUID();
    this.emit({ type: 'agent_status', sessionId, agent, status: 'waiting', detail: 'Waiting for command approval' });
    this.emit({ type: 'approval_request', sessionId, agent, id, command, cwd });
    return this.wait<boolean>(id, sessionId, signal);
  }

  askUser(sessionId: string, agent: AgentId, question: string, signal: AbortSignal): Promise<string> {
    const id = randomUUID();
    this.emit({ type: 'agent_status', sessionId, agent, status: 'waiting', detail: 'Waiting for your answer' });
    this.emit({ type: 'ask_user', sessionId, agent, id, question });
    return this.wait<string>(id, sessionId, signal);
  }

  resolvePrompt(id: string, value: unknown): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(value);
    this.emit({ type: 'prompt_resolved', id });
    return true;
  }

  cancelPrompts(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      p.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      this.emit({ type: 'prompt_resolved', id });
    }
  }

  private wait<T>(id: string, sessionId: string, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, sessionId });
      signal.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(id)) {
            reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
            this.emit({ type: 'prompt_resolved', id });
          }
        },
        { once: true },
      );
    });
  }
}

export const bus = new Bus();
