import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, uid } from '../apps/service/src/store.js';
import { Goals } from '../apps/service/src/goals.js';
import { Work } from '../apps/service/src/work.js';
import { createApp } from '../apps/service/src/app.js';

// A separate local workspace for trying the new experience. It never opens the
// user's live database, and it retains changes when this preview is restarted.
const dir = process.env.WORKSPACE_DATA_DIR || join(tmpdir(), 'abralo-reimagined-preview');
const store = new Store(dir);
if (!store.one("SELECT 1 FROM humans WHERE role='owner'")) {
  const owner = store.createOwner('Chris');
  store.set('workspace.onboarded', true);
  store.set('workspace.name', 'Abralo preview');
  const agent = store.createEmployee(owner.id, {
    name: 'Chief of Staff',
    harness: 'codex',
    model: '',
    cwd: join(dir, 'work'),
    role: 'Helps turn goals into useful next steps',
    instructions: '',
  });
  const goals = new Goals(store);
  const goal = goals.create(owner.id, {
    conversationId: agent.dmId,
    title: 'Turn PollyTalks into a $10K MRR business',
    success: 'Monthly recurring revenue reaches $10,000',
    nextStep: 'Establish current revenue and the customer mix',
  });
  goals.addStep(goal.id, owner.id, {
    title: 'Establish the starting point',
    doneWhen: 'Monthly revenue and paying customer counts are recorded',
  });
  const work = new Work(store);
  const example = work.start(
    {
      id: uid(),
      user_id: owner.id,
      employee_id: agent.id,
      conversation_id: agent.dmId,
      message_id: uid(),
    },
    {
      title: 'Make a useful first plan',
      goalId: goal.id,
      doneWhen: ['The current position and next experiment are clear'],
      proofPlan: ['Check the starting numbers with the founder'],
    },
  );
  work.change(example.id, owner.id, agent.dmId, {
    status: 'waiting',
    summary: 'Ready to establish the starting numbers together.',
  });
}
const previewOwner = store.one("SELECT id FROM humans WHERE role='owner' LIMIT 1");
if (
  previewOwner &&
  !store
    .all('SELECT data FROM employees WHERE owner_id=?', previewOwner.id)
    .some((row: any) => JSON.parse(row.data).name === 'Growth agent')
) {
  store.createEmployee(previewOwner.id, {
    name: 'Growth agent',
    harness: 'codex',
    model: '',
    cwd: join(dir, 'work'),
    role: 'Helps investigate customers and growth experiments',
    instructions: '',
  });
}
const { app, supervisor } = await createApp(store);
const port = Number(process.env.WORKSPACE_PORT || 4392);
const address = await app.listen({ host: '127.0.0.1', port });
supervisor.origin = address;
void supervisor.dispatch();
console.log(`Abralo preview: ${address}`);
const close = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
