import { mkdirSync, writeFileSync } from 'node:fs';
import { Store, uid } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const store = new Store(join(tmpdir(), `workspace-proposal-preview-${uid()}`));
const user = store.createOwner('Morgan');
const chief = store.createEmployee(user.id, {
  name: 'Chief of Staff',
  harness: 'codex',
  role: 'Coordinates both projects',
  model: '',
  cwd: '',
  instructions: '',
});
const proposals = [
  {
    id: uid(),
    version: 1,
    conversationId: chief.dmId,
    chiefId: chief.id,
    purpose: 'Grow PollyTalks and launch Abralo with separate project teams.',
    approved: false,
    employees: [
      { name: 'Growth Lead', role: 'Customer research and revenue growth', harness: 'codex' },
      {
        name: 'Product Engineer',
        role: 'Builds and improves product experiences',
        harness: 'codex',
      },
      {
        name: 'Developer Advocate',
        role: 'Developer adoption and open source community',
        harness: 'codex',
      },
    ],
    rooms: [
      {
        name: 'PollyTalks',
        purpose: 'Grow school adoption and recurring revenue.',
        employeeIndexes: [0, 1],
      },
      {
        name: 'Abralo',
        purpose: 'Build developer adoption, feedback and launch readiness.',
        employeeIndexes: [1, 2],
      },
    ],
  },
];
store.set('proposals.' + user.id, proposals);
store.addMessage(
  chief.dmId,
  user.id,
  user.name,
  'human',
  'I want to grow PollyTalks and launch Abralo.',
);
const { app, supervisor } = await createApp(store);
supervisor.infos = async () => [];
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
mkdirSync('evidence', { recursive: true });
writeFileSync(
  'evidence/team-proposal-preview.json',
  JSON.stringify({ url: origin + '/#setup=' + store.bootstrapToken }),
);
console.log(origin);
process.on('SIGINT', () => void app.close());
