// Run in a real browser via the local verification fixture; no provider calls.
import { IndexedConversationStorage, type StoredView } from '../apps/web/src/conversation-storage';
import { ConversationCache } from '../apps/web/src/conversation-cache';

const report = document.querySelector('pre')!;
const checks: string[] = [];
const check = (condition: unknown, label: string) => {
  if (!condition) throw new Error(label);
  checks.push(label); report.textContent = checks.map(s => 'PASS ' + s).join('\n');
};
const row = (id: string, text = 'Cached answer', updatedAt = Date.now()): StoredView => ({
  view: { id, employeeId: 'agent' }, updatedAt, expanded: ['["message","tool"]'],
  viewport: { following: false, offset: 300, width: 900, height: 600, measurements: [] },
  data: { messages: [{ id: 'message', text, conversationId: id, threadId: null, runId: null, authorId: 'agent', authorName: 'Assistant', kind: 'agent', attachments: [], createdAt: new Date().toISOString(), seq: 1 }], runs: [], decisions: [], attachments: [] },
});
async function run() {
  const disk = new IndexedConversationStorage();
  const scope = 'storage-browser-check';
  await disk.purge(scope);
  await disk.save(scope, row('first'));
  const second = new IndexedConversationStorage();
  let saved = await second.load(scope);
  check(saved.views[0]?.data.messages[0].text === 'Cached answer', 'IndexedDB survives a new storage instance');
  check(saved.views[0]?.viewport?.offset === 300 && saved.views[0]?.expanded.length === 1, 'Reading position and expanded activity survive');
  for (let i = 0; i < 12; i++) await disk.save(scope, row('row-' + i, 'x'.repeat(1800000), Date.now() + i));
  saved = await disk.load(scope);
  check(saved.views.length === 8 && !saved.views.some(r => r.view.id === 'first'), 'Only eight recent views survive LRU eviction');
  check(new TextEncoder().encode(JSON.stringify(saved.views)).length < 16 * 1024 * 1024, 'Total stored payload remains under sixteen MiB');
  await disk.save(scope, row('oversized', 'x'.repeat(3 * 1024 * 1024)));
  check(!(await disk.load(scope)).views.some(r => r.view.id === 'oversized'), 'Oversized snapshots are discarded');
  await disk.save(scope, row('expired', 'old', Date.now() - 8 * 86400000));
  check(!(await disk.load(scope)).views.some(r => r.view.id === 'expired'), 'Expired snapshots are discarded');
  await disk.draft(scope, { id: 'draft-only', employeeId: 'agent' }, { view: { id: 'draft-only', employeeId: 'agent' }, draft: 'Unsent typing', files: [] });
  await disk.purge(scope, ['draft-only'], ['agent']);
  saved = await disk.load(scope);
  check(saved.views.length === 0 && saved.drafts[0]?.draft === 'Unsent typing', 'Draft survives snapshot eviction and permission pruning');
  await disk.purge(scope, ['draft-only'], []);
  check((await disk.load(scope)).drafts.length === 0, 'Revoked employee drafts are removed');
  await disk.save(scope, row('restore'));
  let answer!: (value: any) => void;
  const pending = new Promise(resolve => { answer = resolve; });
  const cache = new ConversationCache((() => pending) as any, 8, 16 * 1024 * 1024, disk);
  cache.setScope(scope, ['restore'], ['agent']); await cache.ready();
  check(cache.read({ id: 'restore' }).data?.messages[0].text === 'Cached answer', 'Conversation hydrates before its network response');
  const loading = cache.load({ id: 'restore' });
  check(cache.read({ id: 'restore' }).status === 'ready', 'Background refresh keeps the current conversation visible');
  answer(row('restore', 'Fresh answer').data); await loading;
  check(cache.read({ id: 'restore' }).data?.messages[0].text === 'Fresh answer', 'Background response reconciles the snapshot');
  cache.clear(); await disk.purge(scope);
  report.textContent += '\nALL CHECKS PASSED';
  await fetch('/verification-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passed: checks }) });
}
run().catch(async error => {
  report.textContent += '\nFAIL ' + error.stack;
  await fetch('/verification-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passed: checks, error: String(error.stack) }) });
});
