import { expect, it } from 'vitest';
import { validTransition } from '../packages/contracts/src/index.js';

it('accepts a completed result that arrives while an agent is waiting for a decision', () => {
  expect(validTransition('waiting_permission', 'completed')).toBe(true);
  expect(validTransition('waiting_input', 'completed')).toBe(true);
});
