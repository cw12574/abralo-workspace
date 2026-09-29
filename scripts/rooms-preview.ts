import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// Disposable visual fixture: no real accounts, files, schedules or model calls.
const s = new Store(mkdtempSync(join(tmpdir(), 'workspace-rooms-preview-')));
const owner = s.createOwner('Alex');
s.set('workspace.name', 'Atelier');
s.set('workspace.onboarded', true);
const agents = ['Chief of Staff', 'Growth Lead', 'Product Engineer'].map((name) =>
  s.createEmployee(owner.id, {
    name,
    harness: 'codex',
    role: '',
    instructions: '',
    cwd: '',
    model: '',
  }),
);
const { app, supervisor } = await createApp(s);
supervisor.infos = async () => [];
const room = s.setting('workspace.team');
s.run('UPDATE conversations SET name=? WHERE id=?', 'Launch', room);
s.set('channel.purpose.' + room, 'A thoughtful launch, built together.');
s.addMessage(
  room,
  owner.id,
  owner.name,
  'human',
  '@Chief of Staff, let’s plan a small launch for our first customers.',
);
const initial = {
  title: 'A considered first launch',
  body: '## The outcome\nFind our first ten customers through one small, measurable experiment.\n\n## The approach\nStart with the people who already understand the problem. Learn what resonates before investing in a broader campaign.\n\n1. Speak with five prospective customers about their current workflow.\n2. Shape a simple invitation around what we learn.\n3. Share a small landing page and measure replies, sign-ups and first use.\n\n## Our boundaries\nKeep the first experiment under £500. Prepare drafts for review before sending outreach. We will revisit the approach together if the interviews suggest a different audience.',
  responsibilities: agents.map((e, i) => ({
    employeeId: e.id,
    responsibility: [
      'Coordinate the approach, gather feedback and bring the result back here.',
      'Research the audience and draft the invitation.',
      'Prepare the landing page and a simple way to measure sign-ups.',
    ][i],
  })),
};
const plan = s.addMessage(
  room,
  agents[0].id,
  agents[0].name,
  'agent',
  initial.title + '\n\n' + initial.body,
);
s.addMessage(
  room,
  owner.id,
  owner.name,
  'human',
  'Start with existing customers and keep the first version small.',
  plan.id,
);
const runId = uid();
const request = s.addMessage(
  room,
  owner.id,
  owner.name,
  'human',
  '@Growth Lead, review the audience assumptions in this plan.',
  plan.id,
);
const response = s.addMessage(
  room,
  agents[1].id,
  agents[1].name,
  'agent',
  'I’m comparing the audience assumptions with what we already know.',
  plan.id,
  [],
  runId,
);
s.run(
  'INSERT INTO runs(id,conversation_id,thread_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  runId,
  room,
  plan.id,
  owner.id,
  agents[1].id,
  request.id,
  response.id,
  'running',
  now(),
  now(),
  uid(),
);
s.set('run.quiet.' + runId, true);
s.run(
  'INSERT INTO activities VALUES(?,?,?)',
  uid(),
  runId,
  JSON.stringify({
    id: uid(),
    title: 'Reading customer notes',
    type: 'tool',
    detail: 'Comparing feedback from our first five conversations.',
    state: 'complete',
    time: now(),
  }),
);
s.run(
  'INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?)',
  uid(),
  owner.id,
  room,
  agents[1].id,
  'Review audience feedback',
  '2099-01-01T09:00:00.000Z',
  null,
  1,
);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
mkdirSync('evidence', { recursive: true });
writeFileSync(
  'evidence/rooms-preview.json',
  JSON.stringify({
    origin,
    url: origin + '/#setup=' + s.bootstrapToken,
    messageId: plan.id,
    room,
    agents: agents.map((e) => ({ id: e.id, name: e.name, dmId: e.dmId })),
  }),
);
console.log('Disposable Rooms preview ready at ' + origin);
process.on('SIGINT', () => void app.close());
