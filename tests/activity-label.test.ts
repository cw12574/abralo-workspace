import { describe, expect, it } from 'vitest';
import { activityLabel, isQuietStep } from '../packages/contracts/src/activity-label';
import { activitySummary } from '../packages/contracts/src/activity-summary';

const step = (title: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  id: 's',
  type: 'tool',
  title,
  time: '2026-11-19T13:00:00Z',
  detail: JSON.stringify(input) + '\n\nResult:\nok',
  ...extra,
});

describe('step labels', () => {
  it('says what Claude Code tools did', () => {
    expect(activityLabel(step('Edit', { file_path: 'C:\\repo\\apps\\service\\src\\connections.ts' }))).toBe('Edited connections.ts');
    expect(activityLabel(step('Read', { file_path: '/repo/README.md' }))).toBe('Read README.md');
    expect(activityLabel(step('Write', { file_path: '/repo/notes.md' }))).toBe('Wrote notes.md');
    expect(activityLabel(step('Grep', { pattern: 'toolchain' }))).toBe('Searched for “toolchain”');
    expect(activityLabel(step('Bash', { command: 'pnpm test', description: 'Run the test suite' }))).toBe('Run the test suite');
    expect(activityLabel(step('Bash', { command: 'cd /repo && pnpm test' }))).toBe('Ran pnpm test');
    expect(activityLabel(step('WebFetch', { url: 'https://www.railway.com/pricing' }))).toBe('Read railway.com');
    expect(activityLabel(step('TodoWrite', { todos: [] }))).toBe('Updated the plan');
  });

  it('reads Codex commands and file changes', () => {
    const cmd = { id: 'c', type: 'commandExecution', title: "/bin/bash -lc 'npm run build'", time: '', detail: JSON.stringify({ command: "/bin/bash -lc 'npm run build'" }) };
    expect(activityLabel(cmd)).toBe('Ran npm run build');
    const change = { id: 'f', type: 'fileChange', title: 'fileChange', time: '', detail: JSON.stringify({ changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }) };
    expect(activityLabel(change)).toBe('Edited a.ts and 1 more');
  });

  it('reads OpenCode tool state', () => {
    expect(activityLabel(step('edit', { status: 'completed', input: { filePath: '/w/src/app.ts' } }))).toBe('Edited app.ts');
  });

  it('keeps long labels to one short line', () => {
    const label = activityLabel(step('Bash', { command: 'node scripts/a-very-long-script-name.mjs --with --many --flags --that --go --on --and --on' }))!;
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith('…')).toBe(true);
  });

  it('falls back to the title when there is nothing better to say', () => {
    expect(activityLabel(step('mcp__workspace__workspace_goals', {}))).toBeUndefined();
    expect(activityLabel({ type: 'tool', title: 'Bash', detail: '...truncated' })).toBeUndefined();
    expect(activityLabel({ type: 'reasoning', title: 'Thinking' })).toBeUndefined();
  });

  it('marks thinking as a quiet step', () => {
    expect(isQuietStep({ type: 'reasoning', title: 'Thinking' })).toBe(true);
    expect(isQuietStep({ type: 'tool', title: 'Edit' })).toBe(false);
  });

  it('travels in history summaries, which drop the detail', () => {
    const summary = activitySummary(step('Edit', { file_path: '/r/connections.ts' }));
    expect(summary.detail).toBeUndefined();
    expect(summary.hasDetail).toBe(true);
    expect(summary.label).toBe('Edited connections.ts');
    expect(activitySummary({ ...summary, detail: undefined }).label).toBe('Edited connections.ts');
  });
});
