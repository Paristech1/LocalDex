import { useState } from 'react';
import type { PlanModeState, PlanStep } from '@localdex/shared';
import { send } from '../store';
import { Button, cx, inputCls } from './ui';

/** Plan mode: a badge while the agent plans (read-only), then Approve & run / Revise / Cancel once the plan is ready. */
export function PlanCard({ sessionId, planMode, steps, running }: { sessionId: string; planMode: PlanModeState; steps: PlanStep[]; running: boolean }) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const review = planMode.status === 'review';

  const revise = () => {
    const f = feedback.trim();
    if (!f) return;
    send({ type: 'plan_revise', sessionId, feedback: f });
    setFeedback('');
    setRevising(false);
  };

  return (
    <div className={cx('my-3 rounded-lg border px-3 py-2 text-xs', review ? 'border-accent/50 bg-accent/5' : 'border-ink-700 bg-ink-900/60')}>
      <div className="flex items-center gap-2">
        <span className={cx('font-medium', review ? 'text-accent' : 'text-ink-200')}>
          {review ? 'Plan ready for review' : running ? 'Plan mode · read-only tools' : 'Plan mode · paused'}
        </span>
        <span className="text-ink-400 truncate">· {planMode.task}</span>
        {planMode.revisions > 0 && <span className="text-ink-500">· revision {planMode.revisions}</span>}
        <span className="flex-1" />
        {!running && (
          <Button variant="ghost" size="sm" onClick={() => send({ type: 'plan_cancel', sessionId })} title="Leave plan mode. Nothing was changed.">
            Cancel
          </Button>
        )}
      </div>
      {!review && !running && <div className="mt-1 text-ink-400">The planning run stopped early. Send a message to continue planning, or cancel.</div>}
      {review && (
        <>
          {steps.length > 0 ? (
            <ol className="mt-2 space-y-0.5 list-decimal list-inside text-ink-200">
              {steps.map((s) => (
                <li key={s.id}>{s.title}</li>
              ))}
            </ol>
          ) : (
            <div className="mt-2 text-warn">The agent did not produce plan steps; read its summary above, then revise or cancel.</div>
          )}
          <div className="mt-2 text-ink-400">Nothing has been changed yet. Approving restores all tools and runs this plan; the composer sends feedback instead of a new task until you decide.</div>
          {revising ? (
            <div className="mt-2 space-y-1.5">
              <textarea
                autoFocus
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    revise();
                  }
                }}
                rows={2}
                placeholder="What should change in the plan?"
                className={cx(inputCls, 'w-full resize-none')}
              />
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={revise} disabled={!feedback.trim()}>
                  Send feedback
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRevising(false)}>
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button variant="primary" size="sm" onClick={() => send({ type: 'plan_approve', sessionId })} title="Restore all tools and carry out the plan">
                Approve &amp; run
              </Button>
              <Button size="sm" onClick={() => setRevising(true)} title="Send feedback; the agent revises the plan, still read-only">
                Revise
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
