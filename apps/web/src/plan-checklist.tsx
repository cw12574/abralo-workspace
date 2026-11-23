import { useEffect, useState } from 'react';
import { Check, Circle, CircleDot } from 'lucide-react';
import { api } from './api';
import { EmployeeMark } from './employee-mark';
import { goalPresentation, type GoalProgress } from './goal-presentation';

export type PlannedWork = {
  goalId?: string;
  title?: string;
  employeeId: string;
  name: string;
  status: string;
  summary: string;
  task: string;
  receiptMessageId: string;
};
type LiveGoal = GoalProgress & {
  id: string;
  title: string;
  leadAgentId: string | null;
  leadAgentName: string | null;
};

/**
 * Everything agreed in this conversation, in one list, each with the employee
 * who owns it. Goal states stay live from their durable records, so the human
 * can watch work move without asking. Changes are made by voice.
 */
export function PlanChecklist({ items }: { items: PlannedWork[] }) {
  const work = items.filter((i) => i.status !== 'removed');
  const ids = work.filter((i) => i.goalId).map((i) => i.goalId!);
  const key = ids.join(',');
  const [live, setLive] = useState<Record<string, LiveGoal>>({});
  useEffect(() => {
    let alive = true;
    const refresh = (only?: string) =>
      Promise.all(
        ids
          .filter((id) => !only || id === only)
          .map((id) =>
            api(`/goals/${id}`)
              .then((goal: LiveGoal) => [id, goal] as const)
              .catch(() => null),
          ),
      ).then((rows) => {
        if (!alive) return;
        setLive((old) => {
          const next = { ...old };
          for (const row of rows) if (row) next[row[0]] = row[1];
          return next;
        });
      });
    void refresh();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.type === 'workspace.resync') void refresh();
      else if (detail?.type === 'goal.changed' && ids.includes(detail.payload?.id))
        void refresh(detail.payload.id);
    };
    window.addEventListener('workspace-event', changed);
    return () => {
      alive = false;
      window.removeEventListener('workspace-event', changed);
    };
  }, [key]);
  if (!work.length) return null;
  return (
    <section className="chief-plan ui-stack" aria-label="Today’s plan" aria-live="polite">
      <span className="chief-eyebrow">Today’s plan</span>
      <ol className="chief-plan-list">
        {work.map((item) => {
          const goal = item.goalId ? live[item.goalId] : undefined;
          const view = goal ? goalPresentation(goal) : null;
          const state = !item.goalId
            ? 'sent'
            : view?.state || (item.status === 'sequenced' ? 'next' : 'working');
          const label = !item.goalId
            ? item.status === 'created'
              ? 'New employee'
              : 'Task sent'
            : view
              ? view.label
              : state === 'next'
                ? 'Up next'
                : 'Starting';
          const Icon =
            state === 'complete' || state === 'sent'
              ? Check
              : state === 'next' || state === 'saved'
                ? Circle
                : CircleDot;
          const title = goal?.title || item.title || item.task || item.name;
          const lead = goal?.leadAgentName || item.name;
          const detail = state === 'next' && view ? view.progress : '';
          return (
            <li key={item.goalId || item.receiptMessageId} className={`chief-plan-item state-${state}`}>
              <Icon size={16} aria-hidden="true" />
              <div className="ui-stack">
                <strong>{title}</strong>
                <span className="chief-plan-lead">
                  <EmployeeMark id={goal?.leadAgentId || item.employeeId} className="chief-plan-mark" />
                  <span>{lead}</span>
                  <span aria-hidden="true">·</span>
                  <span>{label}</span>
                </span>
                {detail && <span className="chief-plan-detail">{detail}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
