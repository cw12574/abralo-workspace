import { describe, expect, it } from 'vitest';
import { goalPresentation, type GoalProgress } from '../apps/web/src/goal-presentation.js';

const goal: GoalProgress = {
  status: 'active',
  current: 'Built and installed; live listening remains.',
  nextStep: 'Check spoken replies and interruptions with live voice.',
  execution: { state: 'saved', question: '', reason: 'Assigned a dedicated project lead.' },
  updates: [],
};

describe('shared goal presentation', () => {
  it('keeps an installed, saved legacy goal off the conversation without implying completion', () => {
    const legacy = { ...goal, steps: [{ status: 'done', evidence: 'Mocked audio checks passed' }] };
    const result = goalPresentation(legacy);
    expect(result).toEqual({
      state: 'saved',
      label: 'Saved',
      showInConversation: false,
      progress: 'Next: Check spoken replies and interruptions with live voice.',
    });
  });

  it.each(['working', 'queued'])('shows %s as current work', (state) => {
    expect(goalPresentation({ ...goal, execution: { ...goal.execution, state } })).toMatchObject({
      label: 'Working',
      showInConversation: true,
      progress: 'Next: ' + goal.nextStep,
    });
  });

  it.each(['needs_input', 'needs_permission', 'waiting_external', 'scheduled', 'stopping'])(
    'shows %s as Waiting with the actual blocker',
    (state) => {
      expect(
        goalPresentation({
          ...goal,
          execution: { state, question: '', reason: 'Waiting for the approved upload to finish.' },
        }),
      ).toMatchObject({
        label: 'Waiting',
        showInConversation: true,
        progress: 'Waiting for the approved upload to finish.',
      });
    },
  );

  it('gives an unresolved question precedence over old progress', () => {
    expect(
      goalPresentation({
        ...goal,
        execution: {
          state: 'needs_input',
          reason: 'Decision needed',
          question: 'Which audience should we prioritise?',
        },
      }).progress,
    ).toBe('Which audience should we prioritise?');
  });

  it('distinguishes checking from completion even after all steps pass', () => {
    expect(
      goalPresentation({ ...goal, execution: { ...goal.execution, state: 'checking' } }),
    ).toMatchObject({
      label: 'Checking',
      showInConversation: true,
      progress: 'Checking the result against the completion criteria.',
    });
  });

  it.each(['paused', 'complete'] as const)(
    'honours %s while an older execution is stopping',
    (status) => {
      expect(
        goalPresentation({ ...goal, status, execution: { ...goal.execution, state: 'stopping' } }),
      ).toMatchObject({
        state: status,
        showInConversation: false,
      });
    },
  );

  it('does not show an obsolete next action for a completed goal', () => {
    const result = goalPresentation({
      ...goal,
      status: 'complete',
      current: 'Live voice and interruptions verified.',
    });
    expect(result.label).toBe('Complete');
    expect(result.progress).toBe('Live voice and interruptions verified.');
  });
  it('shows a sequenced goal as up next with what it is waiting for', () => {
    const result = goalPresentation({
      ...goal,
      execution: { state: 'sequenced', question: '', reason: 'Starts after “Cloud version” is complete.' },
    });
    expect(result).toEqual({
      state: 'next',
      label: 'Up next',
      showInConversation: false,
      progress: 'Starts after “Cloud version” is complete.',
    });
  });
});
