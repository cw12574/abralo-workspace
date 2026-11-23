import type { Activity } from './index.js';

// A short, plain description of what a step did: "Edited connections.ts",
// "Ran the test suite", "Searched for “toolchain”". Engines report steps by
// tool name ("Bash", "Edit", "commandExecution"), which says little; the input
// in the step's detail says what actually happened. Returns undefined when
// there is nothing better than the title to say.

const MAX = 64;

const clip = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX ? line.slice(0, MAX - 1).trimEnd() + '…' : line;
};

const fileName = (path: unknown) =>
  typeof path === 'string' && path.trim() ? path.trim().split(/[\\/]/).filter(Boolean).at(-1) : undefined;

const quoted = (text: unknown) => (typeof text === 'string' && text.trim() ? `“${clip(text).slice(0, 40)}”` : undefined);

/** The input an engine recorded for this step, if its detail starts with one. */
function stepInput(detail?: string): Record<string, any> | undefined {
  if (!detail) return undefined;
  const head = detail.split('\n\nResult:\n')[0].trim();
  if (!head.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(head);
    if (!value || typeof value !== 'object') return undefined;
    // OpenCode wraps the input in the tool's state; Codex sends the whole item.
    return value.input && typeof value.input === 'object' ? { ...value, ...value.input } : value;
  } catch {
    return undefined;
  }
}

/** A shell command, without the wrappers engines add around it. */
function command(value: unknown) {
  if (typeof value !== 'string' && !Array.isArray(value)) return undefined;
  let text = Array.isArray(value) ? value.join(' ') : value;
  text = text
    .replace(/^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+/, '')
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .replace(/^(?:powershell(?:\.exe)?|pwsh)\s+(?:-\w+\s+)*-Command\s+/i, '')
    .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
  return text.trim() ? text : undefined;
}

/** Steps that only mark the agent thinking; summaries skip them. */
export function isQuietStep(activity: Pick<Activity, 'type' | 'title'>) {
  return activity.type === 'reasoning' || /^thinking$/i.test(activity.title);
}

export function activityLabel(activity: Pick<Activity, 'type' | 'title' | 'detail'>): string | undefined {
  if (isQuietStep(activity)) return undefined;
  const tool = activity.title.replace(/^mcp__[^_]+__/, '');
  const key = tool.toLowerCase();
  const input = stepInput(activity.detail);
  const path = input?.file_path ?? input?.filePath ?? input?.path ?? input?.notebook_path;
  const file = fileName(path);

  if (activity.type === 'commandExecution' || ['bash', 'shell', 'powershell'].includes(key)) {
    if (typeof input?.description === 'string' && input.description.trim()) return clip(input.description);
    const ran = command(input?.command ?? (activity.type === 'commandExecution' ? activity.title : undefined));
    return ran ? clip('Ran ' + ran) : undefined;
  }
  if (activity.type === 'fileChange') {
    const changes: any[] = Array.isArray(input?.changes) ? input.changes : [];
    const first = fileName(changes[0]?.path);
    if (!first) return 'Edited files';
    return clip(changes.length > 1 ? `Edited ${first} and ${changes.length - 1} more` : `Edited ${first}`);
  }
  if (['read', 'view', 'notebookread'].includes(key)) return file ? clip('Read ' + file) : undefined;
  if (['edit', 'multiedit', 'notebookedit', 'patch', 'apply_patch'].includes(key)) return file ? clip('Edited ' + file) : 'Edited files';
  if (['write', 'create'].includes(key)) return file ? clip('Wrote ' + file) : undefined;
  if (key === 'grep') return quoted(input?.pattern) ? clip('Searched for ' + quoted(input?.pattern)) : undefined;
  if (key === 'glob' || key === 'list' || key === 'ls')
    return typeof input?.pattern === 'string' ? clip('Found files matching ' + input.pattern) : file ? clip('Listed ' + file) : undefined;
  if (key === 'webfetch' || key === 'fetch') {
    try {
      return clip('Read ' + new URL(input?.url).hostname.replace(/^www\./, ''));
    } catch {
      return undefined;
    }
  }
  if (key === 'websearch' || activity.type === 'webSearch')
    return quoted(input?.query) ? clip('Searched the web for ' + quoted(input?.query)) : undefined;
  if (key === 'todowrite' || key === 'todoread') return 'Updated the plan';
  if (key === 'task' || key === 'agent')
    return typeof input?.description === 'string' ? clip('Delegated: ' + input.description) : undefined;
  return undefined;
}
