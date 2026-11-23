import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

// Disable native desktop registration as well as notification delivery in this
// fixture. The server below still explicitly listens only on 127.0.0.1.
process.env.WORKSPACE_HOST = '0.0.0.0';
// An installed app launched after an update passes this to child processes.
// This disposable workspace has no relationship to that maintenance job.
delete process.env.WORKSPACE_MAINTENANCE_JOB;
const dir = mkdtempSync(join(tmpdir(), 'abralo-briefing-ui-'));
const store = new Store(dir),
  owner = store.createOwner('Chris');
// A disposable database still shares the host's Windows notification channel.
// Disable delivery before creating the app or running any simulated employees.
store.set('notifications.' + owner.id, {
  enabled: false,
  sound: false,
  privatePreview: true,
});
store.set('workspace.onboarded', true);
const employees = Array.from({ length: 28 }, (_, i) =>
  store.createEmployee(owner.id, {
    name: ['Growth', 'Engineer', 'Customer success'][i] || `Employee ${i + 1}`,
    role:
      ['Customer acquisition', 'Product development', 'Customer onboarding'][i] ||
      'Research and operations',
    harness: 'codex',
    model: '',
    cwd: '',
    instructions: '',
  }),
);
store.addMessage(
  employees[0].dmId,
  owner.id,
  owner.name,
  'human',
  'Your current assignment is finding teams that need onboarding help.',
);
const { app, supervisor } = await createApp(store);
supervisor.adapters.codex = {
  info: async () => ({
    harness: 'codex',
    installed: true,
    authenticated: true,
    version: 'test',
    detail: '',
  }),
  run: async (input) => {
    const run = store.one('SELECT * FROM runs WHERE id=?', input.id);
    if (store.setting('briefing.message.' + run.message_id)) {
      expect(input.readOnly).toBe(true);
      const index = employees.findIndex((e) => e.id === run.employee_id);
      supervisor.briefings!.report(run, {
        understanding: 'Today we prioritise existing customers and onboarding.',
        question:
          index < 2
            ? [
                'Should I focus on existing customers first?',
                'Should I finish the onboarding fix before pausing polish?',
              ][index]
            : '',
        reason: 'This changes the next step on my current assignment.',
        priority: index === 0 ? 3 : 2,
        nextStep:
          index < 2
            ? [
                'Prepare the existing customer list for review.',
                'Finish the onboarding fix and record the checks.',
              ][index]
            : '',
      });
    }
    input.emit({ type: 'complete', data: { cancelled: false } });
  },
  dispose: async () => {},
};

await app.listen({ host: '127.0.0.1', port: 0 });
const timer = setInterval(() => void supervisor.dispatch(), 100);
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
// Test the transport lifecycle without microphone access or paid provider calls.
await page.addInitScript({
  content: `(() => {
  const w = window;
  w.__tracksStopped = 0; w.__voiceMessages = [];
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({
    getTracks: () => [{ stop: () => w.__tracksStopped++, enabled: true }],
    getAudioTracks: () => [{ stop: () => w.__tracksStopped++, enabled: true }],
  }) } });
  w.RTCPeerConnection = class {
    connectionState = 'connected'; channel;
    addTrack() {}
    createDataChannel() { this.channel = { readyState: 'connecting', send: (data) => w.__voiceMessages.push(JSON.parse(data)), close: () => {} }; w.__channel = this.channel; return this.channel; }
    async createOffer() { return { sdp: 'test-offer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.channel.readyState = 'open'; this.channel.onopen?.(); }
    close() { this.connectionState = 'closed'; }
  };
  w.__voiceEvent = (data) => w.__channel.onmessage({ data: JSON.stringify(data) });
})();`,
});
let failVoice = true;
await page.route('**/api/briefings/*/voice', (route) =>
  route.fulfill(
    failVoice
      ? { status: 502, json: { error: 'Voice connection timed out. Your brief is saved.' } }
      : { json: { sdp: 'test-answer', speaker: 'You' } },
  ),
);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
mkdirSync('evidence', { recursive: true });
async function screenshots(name: string) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 780 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.locator('.briefing-footer button.primary')).toBeInViewport();
      if (name.startsWith('setup')) {
        await page.getByRole('button', { name: 'Save voice connection' }).scrollIntoViewIfNeeded();
        await expect(page.getByRole('button', { name: 'Save voice connection' })).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `evidence/briefing-${name}-${viewport.width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}
async function event(data: any) {
  await page.evaluate((data) => (window as any).__voiceEvent(data), data);
}
async function say(id: string, transcript: string) {
  await event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: id,
    transcript,
  });
}
async function connected() {
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 10000 });
}
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Morning briefing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What matters today?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect voice to begin' })).toBeEnabled();
  await expect(page.locator('.briefing-roster')).not.toBeVisible();
  await screenshots('simple-home');
  await page.getByRole('button', { name: 'Connect voice to begin' }).click();
  expect(await page.evaluate(() => (window as any).__tracksStopped)).toBe(0);
  expect(supervisor.briefings!.list(owner.id)).toHaveLength(0);
  await screenshots('setup-initial');
  await page.getByLabel('OpenAI API key').fill('ui-fixture-key');
  await screenshots('setup-populated');
  await page.route('**/api/briefings/voice', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 503,
          json: { error: 'Voice settings could not be saved. Please retry.' },
        })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Save voice connection' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be saved');
  await screenshots('setup-error');
  await page.unroute('**/api/briefings/voice');
  await page.getByRole('button', { name: 'Save voice connection' }).click();
  await page.getByRole('button', { name: 'Start briefing', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('timed out', { timeout: 10000 });
  await expect.poll(() => page.evaluate(() => (window as any).__tracksStopped)).toBeGreaterThan(0);
  await screenshots('simple-voice-error');
  failVoice = false;
  await page.getByRole('button', { name: 'Resume voice' }).click();
  await connected();
  await say(
    'brief-turn',
    'Today, focus on existing customers. Finish the onboarding fix and pause website polish.',
  );
  await expect(page.getByRole('button', { name: 'Take questions', exact: true })).toBeEnabled();
  await expect(page.locator('.briefing-stage .briefing-subtitle')).toHaveCount(0);
  await expect(page.locator('.briefing-stage .briefing-caption')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).not.toBeVisible();
  await expect(page.locator('.briefing-footer button')).toHaveCount(2);
  const primaryBox = await page
    .getByRole('button', { name: 'Take questions', exact: true })
    .boundingBox();
  expect(primaryBox!.height).toBeGreaterThanOrEqual(56);
  expect(primaryBox!.width).toBeGreaterThanOrEqual(240);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await screenshots('simple-listening');
  await page.getByRole('button', { name: 'Take questions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Growth has a question.' })).toBeVisible({
    timeout: 30000,
  });
  await connected();
  await expect
    .poll(
      () =>
        supervisor
          .briefings!.get(supervisor.briefings!.list(owner.id)[0].id, owner.id)
          .participants.filter((p) => p.state === 'ready').length,
      { timeout: 30000 },
    )
    .toBe(28);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await screenshots('simple-question');
  await say('answer-1', 'Existing customers first. Prepare a list; do not contact anyone yet.');
  await event({
    type: 'response.function_call_arguments.done',
    name: 'next_question',
    call_id: 'next-1',
    arguments: JSON.stringify({
      answer: 'Existing customers first. Prepare a list; do not contact anyone yet.',
      defer: false,
    }),
  });
  await expect(page.getByRole('heading', { name: 'Engineer has a question.' })).toBeVisible();
  await connected();
  await say('answer-2', 'Finish onboarding before pausing polish.');
  await event({
    type: 'response.function_call_arguments.done',
    name: 'next_question',
    call_id: 'next-2',
    arguments: JSON.stringify({ answer: 'Finish onboarding before pausing polish.', defer: false }),
  });
  await expect(page.getByRole('heading', { name: 'Here’s what happens next.' })).toBeVisible({
    timeout: 10000,
  });
  await connected();
  await say('early-confirm', 'Go ahead.');
  await expect(page.getByRole('alert')).toContainText('full readback');
  expect(
    supervisor.briefings!.get(supervisor.briefings!.list(owner.id)[0].id, owner.id).phase,
  ).toBe('review');
  await say(
    'correction',
    'Only Growth should prepare the customer list. Do not contact anyone. Remove the engineering assignment.',
  );
  await event({
    type: 'response.function_call_arguments.done',
    name: 'revise_actions',
    call_id: 'revise-1',
    arguments: JSON.stringify({
      actions: [
        {
          employeeId: employees[0].id,
          text: 'Prepare the existing customer list. Do not contact anyone yet.',
          selected: true,
        },
      ],
    }),
  });
  await connected();
  await expect(page.locator('.briefing-recap')).toContainText('Do not contact anyone');
  await expect(page.locator('.briefing-recap')).not.toContainText('Engineer');
  await screenshots('simple-review');
  const beforeConcurrentEdit = supervisor.briefings!.get(
    supervisor.briefings!.list(owner.id)[0].id,
    owner.id,
  );
  supervisor.briefings!.saveActions(
    beforeConcurrentEdit.id,
    owner.id,
    beforeConcurrentEdit.version,
    beforeConcurrentEdit.actions.map((a) => ({ ...a, text: a.text + ' Keep the list internal.' })),
  );
  await page.getByRole('button', { name: 'Go ahead', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('proposed work changed');
  expect(supervisor.briefings!.get(beforeConcurrentEdit.id, owner.id).phase).toBe('review');
  await expect(page.locator('.briefing-recap')).toContainText('Keep the list internal');
  await page.reload();
  await page.getByText('Previous briefings', { exact: true }).click();
  await page.getByRole('button', { name: /28 employees.*Resume/ }).click();
  await expect(page.locator('.briefing-recap')).toContainText('Do not contact anyone');
  await page.getByRole('button', { name: 'Resume voice' }).click();
  await connected();
  await event({ type: 'response.created', response: { id: 'readback-1' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'readback-1' });
  await event({ type: 'output_audio_buffer.cleared', response_id: 'readback-1' });
  await event({ type: 'output_audio_buffer.stopped', response_id: 'readback-1' });
  await say('interrupted-confirm', 'Go ahead.');
  await expect(page.getByRole('alert')).toContainText('full readback');
  await page.getByLabel('Briefing options', { exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume voice' }).click();
  await connected();
  await event({ type: 'response.created', response: { id: 'readback-2' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'readback-2' });
  await event({ type: 'output_audio_buffer.stopped', response_id: 'readback-2' });
  await say('confirmed', 'Yes, go ahead.');
  await expect(page.getByRole('heading', { name: 'Everyone has the brief.' })).toBeVisible();
  await screenshots('simple-complete');
  const b = supervisor.briefings!.get(supervisor.briefings!.list(owner.id)[0].id, owner.id);
  expect(b.actions.filter((a) => a.selected)).toHaveLength(1);
  expect(store.one('SELECT text FROM messages WHERE id=?', b.actions[0].messageId).text).toContain(
    'Do not contact anyone yet',
  );
  expect(store.setting('notifications.' + owner.id).enabled).toBe(false);
  expect(store.setting('notifications.delivery.' + owner.id)).toBeNull();
  expect(errors).toEqual([]);
  console.log(
    '28 employees; hidden roster; setup before microphone; reconnect; automatic handoffs and readback; voice correction; interrupted/early confirmation blocked; reload; one confirmed assignment; laptop/mobile light/dark passed. Voice transport mocked; no live audio quality claim.',
  );
} catch (error) {
  console.error('Briefing UI failure:', errors, await page.locator('body').innerText());
  await page.screenshot({ path: 'evidence/briefing-ui-failure.png' });
  throw error;
} finally {
  clearInterval(timer);
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
