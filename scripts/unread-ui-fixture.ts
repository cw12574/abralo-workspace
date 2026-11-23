import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// Isolated manual UI fixture. No provider work or desktop alerts are started.
const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-unread-ui-')));
const user = store.createOwner('Tester');
store.createOwner('Other test member'); // Disable native desktop registration in this fixture.
store.set('workspace.name', 'Abralo');
store.set('workspace.onboarded', true);
store.set('notifications.' + user.id, { enabled: false, sound: false, privatePreview: false });
const chief = store.createEmployee(user.id, { name: 'Chief of Staff', harness: 'codex' });
const engineer = store.createEmployee(user.id, { name: 'Engineer', harness: 'codex' });
store.addMessage(chief.dmId, user.id, user.name, 'human', 'A quiet place to start.');
for (let i = 0; i < 2; i++) store.addMessage(engineer.dmId, engineer.id, engineer.name, 'agent', `Update ${i + 1} is ready to read.`);
const { app } = await createApp(store, { staticRoot: resolve('artifacts/notification-simplification-web') });
app.post('/__fixture/add', async () => store.addMessage(engineer.dmId, engineer.id, engineer.name, 'agent', 'Another update is ready.'));
app.post('/__fixture/read', async () => {
  const seq = store.one('SELECT MAX(seq) seq FROM messages WHERE conversation_id=?', engineer.dmId).seq;
  const result = await app.inject({ method: 'POST', url: `/api/conversations/${engineer.dmId}/read`, headers: { cookie: 'workspace=' + store.newSession(user.id), 'x-workspace-request': '1' }, payload: { seq } });
  return { status: result.statusCode };
});
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
writeFileSync('artifacts/unread-ui-fixture.json', JSON.stringify({ origin, url: `${origin}/?conversation=${chief.dmId}#setup=${store.bootstrapToken}` }));
console.log('Unread UI fixture ready:', origin);
