import type { Activity } from '../../../packages/contracts/src/index';

export type ReplyTimelineItem =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'steps'; steps: Activity[] };

/**
 * Lays out an agent reply in the order it happened: text the agent wrote and the
 * steps it took, interleaved. Each step records how much text existed when it began
 * (`textOffset`). Back-to-back steps form one group; text between them splits groups.
 * Steps without an offset (older replies) stay where the timeline currently is, so a
 * reply saved before offsets existed shows its steps once, above its text.
 */
export function buildReplyTimeline(text: string, activities: Activity[]) {
  const textLength = text.length;
  const steps = [...activities].sort(
    (a, b) => Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id),
  );
  const items: ReplyTimelineItem[] = [];
  let cursor = 0;
  for (const step of steps) {
    const offset = Math.min(
      textLength,
      Number.isFinite(step.textOffset) ? (step.textOffset as number) : cursor,
    );
    if (offset > cursor) {
      // Whitespace between two steps does not split them into separate groups.
      if (text.slice(cursor, offset).trim()) items.push({ kind: 'text', start: cursor, end: offset });
      cursor = offset;
    }
    const last = items.at(-1);
    if (last?.kind === 'steps') last.steps.push(step);
    else items.push({ kind: 'steps', steps: [step] });
  }
  if (text.slice(cursor).trim()) items.push({ kind: 'text', start: cursor, end: textLength });
  return items;
}
