import type { Briefing } from '../../service/src/briefings';

// Commands must occupy the whole utterance: mentioning or qualifying approval is not approval.
export function briefingCommand(text: string) {
  const value = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[.!?,]/g, '')
    .trim();
  if (['thats everything', 'that is everything', 'take questions', 'any questions'].includes(value))
    return 'finish';
  if (['go ahead', 'yes go ahead', 'send the brief'].includes(value)) return 'confirm';
  if (['next question', 'move on', 'skip this question'].includes(value)) return 'next';
  return null;
}

export function briefBeforeFinish(text: string): string | null {
  if (briefingCommand(text) === 'finish') return '';
  const match = text.match(
    /^([\s\S]*[.!?])\s+(?:that[’']s everything|that is everything)[.!?]*\s*$/i,
  );
  return match ? match[1].trim() : null;
}

export function nextQuestion(b: Briefing) {
  return b.questions.filter((q) => q.state === 'queued').sort((a, c) => c.priority - a.priority)[0];
}

export function readback(b: Briefing) {
  const actions = b.actions.filter((a) => a.selected);
  const work = actions
    .map((a) => `${b.participants.find((p) => p.id === a.employeeId)?.name}: ${a.text}`)
    .join('\n');
  const missing = b.participants.filter((p) => p.state === 'unavailable').length;
  const deferred = b.questions.filter((q) => q.state === 'deferred').length;
  return [
    work || 'Share the brief for awareness. No new assignments.',
    missing ? `${missing} employees could not prepare in this session.` : '',
    deferred ? `${deferred} questions remain unresolved.` : '',
    'Say “Go ahead” to send this, or tell me what to change.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
