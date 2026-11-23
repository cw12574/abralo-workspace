import { expect, it } from 'vitest';
import {
  briefingCommand,
  briefBeforeFinish,
  nextQuestion,
  readback,
} from '../apps/web/src/briefing-controller';
import type { Briefing } from '../apps/service/src/briefings';

it('recognizes explicit whole-utterance commands without approving tentative or negated remarks', () => {
  expect(briefBeforeFinish('Prepare the list. That’s everything.')).toBe('Prepare the list.');
  expect(briefBeforeFinish('I think that’s everything except pricing.')).toBeNull();
  expect(briefingCommand('Yes, go ahead.')).toBe('confirm');
  expect(briefingCommand('That’s everything.')).toBe('finish');
  expect(briefingCommand('Next question')).toBe('next');
  for (const text of [
    'Do not go ahead',
    'Maybe go ahead',
    'Go ahead if the customer agrees',
    'When I say go ahead, send it',
    'Yes, but remove the outreach',
    'I think that’s everything except pricing',
  ])
    expect(briefingCommand(text)).toBeNull();
});
it('prioritizes queued questions and reads only proposed assignments with missing evidence visible', () => {
  const b = {
    participants: [
      { id: 'a', name: 'Maya', state: 'ready' },
      { id: 'b', name: 'Sam', state: 'unavailable' },
    ],
    questions: [
      { id: 'answered', state: 'answered', priority: 3 },
      { id: 'later', state: 'queued', priority: 1 },
      { id: 'blocking', state: 'queued', priority: 3 },
      { id: 'deferred', state: 'deferred', priority: 3 },
    ],
    actions: [
      { employeeId: 'a', selected: true, text: 'Prepare a list. Do not contact anyone.' },
      { employeeId: 'b', selected: false, text: 'Send outreach.' },
    ],
  } as unknown as Briefing;
  expect(nextQuestion(b)?.id).toBe('blocking');
  expect(readback(b)).toContain('Maya: Prepare a list. Do not contact anyone.');
  expect(readback(b)).not.toContain('Send outreach');
  expect(readback(b)).toContain('1 employees could not prepare');
  expect(readback(b)).toContain('1 questions remain unresolved');
});
