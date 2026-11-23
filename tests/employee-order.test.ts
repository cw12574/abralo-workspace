import { expect, it } from 'vitest';
import {
  closestEmployeeSlot,
  moveEmployee,
  reconcileEmployeeOrder,
} from '../apps/web/src/employee-order';

it('keeps a saved order while removing missing employees and appending new hires', () => {
  expect(reconcileEmployeeOrder(['a', 'b', 'c', 'new'], ['c', 'missing', 'a', 'c'])).toEqual([
    'c',
    'a',
    'b',
    'new',
  ]);
});
it('recovers from invalid preferences without losing employees', () => {
  expect(reconcileEmployeeOrder(['a', 'b'], { order: ['b'] })).toEqual(['a', 'b']);
  expect(reconcileEmployeeOrder(['a', 'b'], [null, 1, 'b'])).toEqual(['b', 'a']);
});
it('moves both directions without mutating the original and clamps list boundaries', () => {
  const original = ['a', 'b', 'c', 'd'];
  expect(moveEmployee(original, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
  expect(moveEmployee(original, 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
  expect(moveEmployee(original, 'a', -1)).toEqual(original);
  expect(moveEmployee(original, 'a', 100)).toEqual(['b', 'c', 'd', 'a']);
  expect(moveEmployee(original, 'absent', 0)).toEqual(original);
  expect(original).toEqual(['a', 'b', 'c', 'd']);
});
it('chooses the nearest slot with unequal row heights and out-of-bounds pointers', () => {
  const centres = [20, 60, 110, 170];
  expect(closestEmployeeSlot(centres, -100)).toBe(0);
  expect(closestEmployeeSlot(centres, 88)).toBe(2);
  expect(closestEmployeeSlot(centres, 1000)).toBe(3);
});
