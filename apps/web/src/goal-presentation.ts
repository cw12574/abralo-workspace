/** One projection of the durable record, shared by the list and conversation. */
export type GoalProgress = {
  status: 'active' | 'paused' | 'complete';
  current: string;
  nextStep: string;
  execution: { state: string; question: string; reason: string };
  updates: { summary: string }[];
};

export function goalPresentation(goal: GoalProgress) {
  const execution = goal.execution;
  // Terminal/manual state wins even while an old execution is stopping.
  const state =
    goal.status === 'complete' || goal.status === 'paused'
      ? goal.status
      : execution.state === 'saved'
        ? 'saved'
        : execution.state === 'sequenced'
          ? 'next'
          : execution.state === 'checking'
          ? 'checking'
          : ['working', 'queued'].includes(execution.state)
            ? 'working'
            : 'waiting';
  const labels = {
    saved: 'Saved',
    next: 'Up next',
    working: 'Working',
    waiting: 'Waiting',
    checking: 'Checking',
    complete: 'Complete',
    paused: 'Paused',
  };
  const latest = goal.current.trim() || goal.updates[0]?.summary.trim() || '';
  const next = goal.nextStep.trim();
  let progress: string;
  if (state === 'next') progress = execution.reason.trim() || 'Starts when the goal before it is complete.';
  else if (state === 'complete') progress = latest || 'The agreed outcome has been verified.';
  else if (state === 'waiting')
    progress =
      execution.question.trim() ||
      execution.reason.trim() ||
      next ||
      'Waiting for the next action to become available.';
  else if (state === 'checking') progress = 'Checking the result against the completion criteria.';
  else
    progress = next
      ? `Next: ${next}`
      : latest ||
        (state === 'saved'
          ? 'Saved for later.'
          : state === 'paused'
            ? 'Work is paused.'
            : 'The lead is establishing the next step.');
  return {
    state,
    label: labels[state],
    progress,
    showInConversation: ['working', 'waiting', 'checking'].includes(state),
  };
}
