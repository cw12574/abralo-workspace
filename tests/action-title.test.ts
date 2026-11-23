import { expect, it } from 'vitest';
import { actionTitle } from '../apps/web/src/action-title';

it.each([
  ['create-project', 'Create project'],
  ['connect_service_source', 'Connect service source'],
  ['createDraftEmail', 'Create draft email'],
  ['mcp__railway__delete-service', 'Delete service'],
  ['get-API-token', 'Get API token'],
  ['', 'Action'],
])('names %s as "%s"', (tool, title) => {
  expect(actionTitle(tool)).toBe(title);
});
