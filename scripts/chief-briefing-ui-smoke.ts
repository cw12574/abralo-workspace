import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    canDelegate: i === 0,
    name: ['Chief of Staff', 'Engineer', 'Customer success'][i] || `Employee ${i + 1}`,
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
const { app, supervisor } = await createApp(store, {
  staticRoot: process.env.BRIEFING_STATIC_ROOT
    ? resolve(process.env.BRIEFING_STATIC_ROOT)
    : undefined,
});
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
    if (input.prompt.includes('Prepare an experiment shortlist'))
      input.emit({
        type: 'text',
        text: 'The experiment shortlist is ready. No outreach was sent.',
      });
    input.emit({ type: 'complete', data: { cancelled: false } });
  },
  dispose: async () => {},
};

await app.listen({ host: '127.0.0.1', port: 0 });
const timer = setInterval(() => void supervisor.dispatch(), 100);
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
// Test the transport lifecycle without microphone access or paid provider calls.
await page.addInitScript({
  content: `(() => {
  const w = window;
  w.__connections = 0; w.__tracksStopped = 0; w.__voiceMessages = [];
  w.Audio = class { autoplay = false; srcObject = null; async play() {} pause() {} };
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
    const context = new AudioContext(); await context.resume();
    const input = context.createMediaStreamDestination(), output = context.createMediaStreamDestination();
    const oscillator = context.createOscillator(); oscillator.frequency.value = 160;
    const inputGain = context.createGain(), outputGain = context.createGain();
    inputGain.gain.value = 0; outputGain.gain.value = 0;
    oscillator.connect(inputGain).connect(input); oscillator.connect(outputGain).connect(output); oscillator.start();
    w.__inputGain = inputGain; w.__outputGain = outputGain; w.__outputStream = output.stream;
    for (const track of input.stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => { w.__tracksStopped++; stop(); if (context.state !== 'closed') void context.close(); };
    }
    return input.stream;
  } } });
  w.RTCPeerConnection = class {
    connectionState = 'connected'; channel;
    addTrack() {}
    createDataChannel() { w.__connections++; this.channel = { readyState: 'connecting', send: (data) => w.__voiceMessages.push(JSON.parse(data)), close: () => {} }; w.__channel = this.channel; return this.channel; }
    async createOffer() { return { sdp: 'test-offer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.ontrack?.({ streams: [w.__outputStream] }); this.channel.readyState = 'open'; this.channel.onopen?.(); }
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
      const primary = page.locator('.chief-controls > .primary');
      if (await primary.count()) {
        await primary.scrollIntoViewIfNeeded();
        await expect(primary).toBeInViewport();
        const button = (await primary.boundingBox())!,
          stage = (await page.locator('.briefing-stage').boundingBox())!;
        expect(Math.abs(button.x + button.width / 2 - stage.x - stage.width / 2)).toBeLessThan(2);
      }
      if (name.startsWith('setup')) {
        await page.getByRole('button', { name: 'Save voice settings' }).scrollIntoViewIfNeeded();
        await expect(page.getByRole('button', { name: 'Save voice settings' })).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `evidence/chief-briefing-${name}-${viewport.width}-${theme}.png`,
      });
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
  await expect(page.locator('.briefing-stage > span[role=status]')).toHaveText('Listening', {
    timeout: 10000,
  });
}
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('button', { name: 'Morning briefing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What good shall we do this day?', exact: true })).toBeVisible();
  await expect(page.locator('.briefing-roster')).toHaveCount(0);
  await expect(page.locator('.conversation-header, .briefing-footer')).toHaveCount(0);
  await expect(page.locator('.chief-call button')).toHaveCount(2);
  await screenshots('home');
  await page.getByRole('button', { name: /Let.s talk/ }).click();
  expect(await page.evaluate(() => (window as any).__connections)).toBe(0);
  await screenshots('setup-initial');
  await page.getByLabel('OpenAI API key').fill('ui-fixture-key');
  await screenshots('setup-populated');
  await page.route('**/api/briefings/voice', async (route) => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 503, json: { error: 'Could not save voice settings. Please try again.' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save voice settings.');
  await screenshots('setup-error');
  await page.unroute('**/api/briefings/voice');
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect(page.getByText('Voice settings saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: /Let.s talk/ }).click();
  await expect(page.getByRole('alert')).toContainText('timed out');
  await screenshots('voice-error');
  failVoice = false;
  await page.getByRole('button', { name: 'Resume voice' }).click();
  await connected();
  const wave = page.locator('.chief-wave rect').nth(12);
  await page.evaluate(() => {
    (window as any).__inputGain.gain.value = 0.16;
  });
  await expect.poll(async () => Number(await wave.getAttribute('height'))).toBeGreaterThan(15);
  await event({ type: 'output_audio_buffer.started' });
  await event({
    type: 'response.output_audio_transcript.delta',
    delta: 'What good shall we do this day?',
  });
  // Text arrives ahead of the audio. Nothing is captioned until it is audible.
  await page.waitForTimeout(600);
  await expect(page.locator('.chief-caption')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__outputGain.gain.value = 0.18;
  });
  const growth: string[] = [];
  await expect
    .poll(async () => {
      const text = (await page.locator('.chief-caption').last().textContent()) || '';
      if (text && growth[growth.length - 1] !== text) growth.push(text);
      return text;
    }, { intervals: [60] })
    // The final word is held until the transcript confirms it is complete.
    .toBe('What good shall we do this');
  // Revealed progressively in whole words, each extending the last.
  expect(growth.length).toBeGreaterThan(2);
  for (const [i, text] of growth.entries()) {
    expect('What good shall we do this day?'.startsWith(text)).toBe(true);
    if (i) expect(text.length).toBeGreaterThan(growth[i - 1].length);
  }
  await expect
    .poll(() =>
      page
        .locator('.chief-portrait')
        .evaluate((el) => Number((el as HTMLElement).style.getPropertyValue('--voice-energy'))),
    )
    .toBeGreaterThan(0.3);
  await screenshots('speaking');
  await event({ type: 'input_audio_buffer.speech_started' });
  await event({ type: 'output_audio_buffer.cleared' });
  await expect(page.locator('.briefing-stage > span[role=status]')).toContainText('Listening');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => wave.evaluate((el) => getComputedStyle(el).height)).toBe('3px');
  await expect(page.locator('.chief-halo')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await event({ type: 'input_audio_buffer.speech_stopped' });
  await page.evaluate(() => {
    (window as any).__inputGain.gain.value = 0;
    (window as any).__outputGain.gain.value = 0;
  });
  await expect.poll(async () => Number(await wave.getAttribute('height'))).toBeLessThan(3.5);
  const connections = await page.evaluate(() => (window as any).__connections);
  await say(
    'brief-1',
    'I am thinking about pricing, but no decision yet. Engineer should fix onboarding.',
  );
  await event({
    type: 'response.output_audio_transcript.done',
    item_id: 'chief-1',
    transcript: 'Is the onboarding fix the priority over website polish?',
  });
  await say('brief-2', 'Yes. Fix onboarding first. Do not publish anything.');
  await expect
    .poll(
      () =>
        supervisor.briefings!.get(supervisor.briefings!.list(owner.id)[0].id, owner.id).turns
          .length,
    )
    .toBe(3);
  expect(store.all('SELECT * FROM outbox')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'End conversation' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Take questions' })).toHaveCount(0);
  await expect(page.locator('.chief-call button')).toHaveCount(2);
  await expect(page.getByText('Conversation options')).toHaveCount(0);
  await screenshots('conversation');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  // Ending saves the recap and sends the agreed work at once. No second approval.
  const recap = {
    type: 'response.function_call_arguments.done',
    name: 'save_recap',
    call_id: 'recap-1',
    arguments: JSON.stringify({
      summary: 'Prioritise onboarding. Pricing is undecided.',
      actions: [
        { employeeId: employees[1].id, text: 'Fix onboarding first. Do not publish anything.' },
      ],
    }),
  };
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await event(recap);
  await event(recap);
  await expect(page.getByRole('heading', { name: 'Your brief is saved.' })).toBeVisible();
  await expect(page.locator('.briefing-recap')).toContainText('Do not publish');
  await expect(page.getByRole('button', { name: /Go ahead/ })).toHaveCount(0);
  await expect(page.locator('.chief-call textarea')).toHaveCount(0);
  await expect(page.locator('.chief-call button')).toHaveCount(1);
  await screenshots('complete');
  const b = supervisor.briefings!.get(supervisor.briefings!.list(owner.id)[0].id, owner.id);
  expect(b.hostId).toBe(employees[0].id);
  expect(b.turns.find((t) => t.id === 'chief-1')?.speaker).toBe(employees[0].id);
  expect(b.phase).toBe('complete');
  expect(b.actions).toHaveLength(1);
  expect(store.one('SELECT text FROM messages WHERE id=?', b.actions[0].messageId).text).toContain(
    'Do not publish',
  );
  expect(
    store.one('SELECT text FROM messages WHERE id=?', b.actions[0].messageId).text,
  ).not.toContain('Pricing');
  expect(
    store.one('SELECT conversation_id FROM messages WHERE id=?', b.recapMessageId).conversation_id,
  ).toBe(employees[0].dmId);
  expect(
    store.all('SELECT * FROM messages WHERE conversation_id=?', employees[2].dmId),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: /Let.s talk/ }).click();
  await connected();
  const request =
    'Create Maya as a growth researcher and ask her to prepare an experiment shortlist. No outreach.';
  await event({ type: 'input_audio_buffer.speech_started', item_id: 'hire-request' });
  await event({ type: 'input_audio_buffer.speech_stopped', item_id: 'hire-request' });
  await event({ type: 'response.created', response: { id: 'hire-action' } });
  const hiring = {
    type: 'response.function_call_arguments.done',
    name: 'create_employee',
    response_id: 'hire-action',
    call_id: 'hire-call',
    arguments: JSON.stringify({
      name: 'Maya',
      role: 'Growth researcher',
      task: 'Prepare an experiment shortlist. No outreach.',
    }),
  };
  let lostTurnAck = false, lostActionAck = false;
  await page.route('**/api/briefings/*/turns', async (route) => {
    if (route.request().postDataJSON()?.id === 'hire-request' && !lostTurnAck) {
      lostTurnAck = true;
      await route.fetch(); // Commit, then lose the acknowledgement.
      await route.fulfill({ status: 503, json: { error: 'Simulated lost turn acknowledgement' } });
    } else await route.continue();
  });
  await page.route('**/api/briefings/*/act', async (route) => {
    if (route.request().postDataJSON()?.callId === 'hire-call' && !lostActionAck) {
      lostActionAck = true;
      await route.fetch();
      await route.fulfill({ status: 503, json: { error: 'Simulated lost action acknowledgement' } });
    } else await route.continue();
  });
  await event(hiring);
  await event(hiring);
  // The old implementation gave up after four seconds. Keep this action pending
  // until the independent transcription stream finally arrives.
  await page.waitForTimeout(4500);
  expect(store.all('SELECT * FROM employees')).toHaveLength(28);
  await say('hire-request', request);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.chief-plan')).toContainText('Maya');
  const hiredMeeting = supervisor.briefings!.get(
    supervisor.briefings!.list(owner.id)[0].id,
    owner.id,
  );
  const hired = hiredMeeting.executedActions![0];
  expect(hiredMeeting.executedActions).toHaveLength(1);
  expect(lostTurnAck && lostActionAck).toBe(true);
  await page.unroute('**/api/briefings/*/turns');
  await page.unroute('**/api/briefings/*/act');
  expect(store.all('SELECT * FROM employees')).toHaveLength(29);
  await expect
    .poll(() => store.setting(`delegation.returned.${hired.messageId}.${hired.employeeId}`), {
      timeout: 15000,
    })
    .toBeTruthy();
  const returnedId = store.setting(`delegation.returned.${hired.messageId}.${hired.employeeId}`);
  expect(
    store.one('SELECT conversation_id,thread_id FROM messages WHERE id=?', returnedId),
  ).toEqual({ conversation_id: employees[0].dmId, thread_id: hired.receiptMessageId });
  await event({ type: 'response.created', response: { id: 'hire-reply' } });
  await event({ type: 'output_audio_buffer.started', response_id: 'hire-reply' });
  await event({
    type: 'response.output_audio_transcript.done',
    item_id: 'hire-reply',
    transcript: 'Maya has joined the team. I have sent her the brief, with no outreach.',
  });
  await page.evaluate(() => {
    (window as any).__outputGain.gain.value = 0.18;
  });
  await expect(page.locator('.chief-caption').last()).toContainText('Maya has joined');
  await page.evaluate(() => {
    (window as any).__outputGain.gain.value = 0;
  });
  await event({ type: 'response.done', response: { id: 'hire-reply' } });
  await event({ type: 'output_audio_buffer.stopped', response_id: 'hire-reply' });
  await screenshots('live-action');
  await say('delegate-request', 'Ask Engineer to review the onboarding checklist. No changes yet.');
  await event({ type: 'response.created', response: { id: 'delegate-action' } });
  const delegation = {
    type: 'response.function_call_arguments.done',
    name: 'delegate_task',
    response_id: 'delegate-action',
    call_id: 'delegate-call',
    arguments: JSON.stringify({
      employeeId: employees[1].id,
      task: 'Review the onboarding checklist. No changes yet.',
    }),
  };
  await event(delegation);
  await expect(page.locator('.chief-plan')).toContainText('Engineer');
  const latest = supervisor.briefings!.get(hiredMeeting.id, owner.id);
  expect(latest.executedActions).toHaveLength(2);
  await page.reload();
  await page.locator('.employee-row').filter({ hasText: 'Chief of Staff' }).click();
  await page.getByRole('button', { name: 'Morning briefings', exact: true }).click();
  await page
    .getByRole('button', { name: /Resume/ })
    .first()
    .click();
  await expect(page.locator('.chief-plan')).toContainText('Engineer');
  await page.getByRole('button', { name: 'Resume voice' }).click();
  await connected();
  // A fresh provider connection cannot replay an old response. Retry the saved
  // HTTP request instead, as when its acknowledgement was lost across reconnect.
  const retried = await page.evaluate(async ({ briefingId, delegation }) => {
    const response = await fetch(`/api/briefings/${briefingId}/act`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-request': '1' }, body: JSON.stringify({ name: delegation.name, callId: delegation.call_id, args: JSON.parse(delegation.arguments), sourceTurnId: 'delegate-request' }) });
    return response.json();
  }, { briefingId: hiredMeeting.id, delegation });
  expect(retried.result.messageId).toBe(latest.executedActions![1].messageId);
  await expect
    .poll(() => supervisor.briefings!.get(hiredMeeting.id, owner.id).executedActions?.length)
    .toBe(2);
  expect(
    store.all('SELECT * FROM outbox WHERE message_id=?', latest.executedActions![1].messageId),
  ).toHaveLength(1);
  supervisor.goals!.enabled = false; // Observe queued goal without autonomous test loops.
  await say(
    'durable-request',
    'Give Maya a durable goal to validate demand. Start now. No outreach.',
  );
  await event({
    type: 'response.function_call_arguments.done',
    name: 'read_goals',
    call_id: 'read-goals',
    arguments: '{}',
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__voiceMessages.some((e: any) => e.item?.call_id === 'read-goals'),
      ),
    )
    .toBe(true);
  await event({ type: 'response.created', response: { id: 'goal-action' } });
  const goalCall = {
    type: 'response.function_call_arguments.done',
    name: 'delegate_goal',
    response_id: 'goal-action',
    call_id: 'goal-call',
    arguments: JSON.stringify({
      employeeId: hired.employeeId,
      goalId: '',
      version: 0,
      title: 'Validate demand',
      success: 'Evidence-backed demand assessment without outreach.',
      nextStep: 'Review available evidence and record gaps. No outreach.',
      start: true,
    }),
  };
  await event(goalCall);
  await event(goalCall);
  await expect(page.locator('.chief-plan')).toContainText('Validate demand');
  const assignedGoal = store.one('SELECT * FROM goals WHERE title=?', 'Validate demand');
  expect(assignedGoal.lead_agent_id).toBe(hired.employeeId);
  expect(store.all('SELECT * FROM goals WHERE title=?', 'Validate demand')).toHaveLength(1);
  expect(supervisor.goals!.policy(assignedGoal.id).state).toBe('queued');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await screenshots('durable-goal');
  // A spoken plan becomes every goal at once: independent work starts, the rest waits its turn.
  await say(
    'plan-request',
    'Then we want a cloud version for companies, then a ChatGPT ads experiment, then a demo video.',
  );
  await event({ type: 'response.created', response: { id: 'plan-action' } });
  const planCall = {
    type: 'response.function_call_arguments.done',
    name: 'set_plan',
    response_id: 'plan-action',
    call_id: 'plan-call',
    arguments: JSON.stringify({
      goals: [
        { title: 'Launch a cloud version for companies', success: 'Companies can use the core features hosted.', nextStep: 'Agree the minimum scope with Chris.', after: '', employeeId: '' },
        { title: 'Run a ChatGPT ads experiment', success: 'Measured sign-ups from tech companies.', nextStep: 'Draft the experiment for approval before spending.', after: 'Launch a cloud version for companies', employeeId: '' },
        { title: 'Record the morning meeting demo', success: 'Demo video ready to publish.', nextStep: 'Storyboard the demo.', after: 'Run a ChatGPT ads experiment', employeeId: '' },
      ],
    }),
  };
  await event(planCall);
  await event(planCall);
  const plan = page.locator('.chief-plan-item');
  const planItem = (title: string) =>
    plan.filter({ has: page.locator('strong', { hasText: title }) });
  // One list: Maya's hiring, Engineer's task and the four goals.
  await expect(plan).toHaveCount(6);
  await expect(planItem('Run a ChatGPT ads experiment')).toContainText(
    'Starts after “Launch a cloud version for companies” is complete.',
  );
  await expect(planItem('Record the morning meeting demo')).toContainText('Up next');
  expect(store.all("SELECT * FROM goals WHERE title LIKE 'Run a ChatGPT%'")).toHaveLength(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__voiceMessages.find((e: any) => e.item?.call_id === 'plan-call')?.item.output,
      ),
    )
    .toContain('3 goals set.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await screenshots('plan');
  await expect(planItem('Run a ChatGPT ads experiment').locator('.chief-plan-mark')).toHaveCount(1);
  await expect(page.locator('.chief-plan button')).toHaveCount(0);
  await say('drop-request', 'Actually, drop the ads experiment.');
  await event({ type: 'response.created', response: { id: 'drop-action' } });
  const adsGoal = store.one("SELECT id FROM goals WHERE title='Run a ChatGPT ads experiment'");
  await event({
    type: 'response.function_call_arguments.done',
    name: 'remove_goal',
    response_id: 'drop-action',
    call_id: 'drop-call',
    arguments: JSON.stringify({ goalId: adsGoal.id }),
  });
  await expect(plan).toHaveCount(5);
  await expect(planItem('Record the morning meeting demo')).toContainText(
    'Starts after “Launch a cloud version for companies” is complete.',
  );
  expect(store.all("SELECT * FROM goals WHERE title LIKE 'Run a ChatGPT%'")).toHaveLength(0);
  await screenshots('plan-undo');
  // Long replies remain readable; scrolling back must not be pulled to live text.
  const spokenReplies = [
    'Let’s start with customer research. I suggest reviewing the interviews before planning outreach.',
    'Maya can lead that goal. Her first step would be to gather the evidence we already have.',
    'We should make success concrete. A clear account of the strongest needs and the gaps would help us decide.',
    'The onboarding review is a separate piece of work. Our engineer can check where customers get stuck.',
    'That gives each goal one owner. They can bring back evidence when a decision is needed.',
    'We will keep your constraint on outreach. Reviewing existing material can begin without contacting anyone.',
    'The agreed work is queued with its owners. I will report actual progress rather than assume it is finished.',
    'You can read back through our conversation at your own pace. The earlier sentences will stay here.',
  ];
  for (const [i, transcript] of spokenReplies.entries()) {
    await event({ type: 'response.created', response: { id: 'captions-' + i } });
    await event({ type: 'output_audio_buffer.started', response_id: 'captions-' + i });
    await event({ type: 'response.output_audio_transcript.done', response_id: 'captions-' + i, item_id: 'captions-' + i,
      transcript });
    await event({ type: 'output_audio_buffer.stopped', response_id: 'captions-' + i });
    await event({ type: 'response.done', response: { id: 'captions-' + i } });
  }
  await expect(page.locator('.chief-caption')).toHaveCount(2);
  await expect(page.locator('.chief-caption').last()).toContainText('The earlier sentences will stay here.');
  await expect(page.getByRole('button', { name: /Previous thought|Next thought|Conversation/ })).toHaveCount(0);
  await screenshots('caption-live');
  const stoppedBefore = await page.evaluate(() => (window as any).__tracksStopped);
  await page.getByRole('button', { name: 'End conversation', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__tracksStopped))
    .toBeGreaterThan(stoppedBefore);
  await expect(page.locator('.briefing-stage > span[role=status]')).toContainText(
    'Saving your recap',
  );
  expect(
    await page.evaluate(() =>
      (window as any).__voiceMessages.some((e: any) =>
        e.response?.instructions?.includes('pressed End conversation'),
      ),
    ),
  ).toBe(true);
  await event({
    ...recap,
    call_id: 'ending-recap',
    arguments: JSON.stringify({ summary: 'Maya is validating demand. No outreach.', actions: [] }),
  });
  await expect(page.getByRole('heading', { name: 'Your brief is saved.' })).toBeVisible();
  await expect(page.locator('.chief-presence')).toHaveClass(/off/);
  // The full conversation stays with the recap, readable at the human's own pace.
  await page.getByText('Conversation', { exact: true }).click();
  const captions = page.getByRole('region', { name: 'Conversation transcript' });
  await expect(captions).toContainText('Let’s start with customer research.');
  await expect(captions).toContainText('The earlier sentences will stay here.');
  await screenshots('caption-scrollback');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Type instead', exact: true }).click();
  await page
    .getByLabel('Your briefing')
    .fill('Keep today clear for customer research. No new assignments.');
  await screenshots('typed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.briefing-recap')).toContainText('customer research');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole('button', { name: 'Open workspace navigation' }).click();
  await expect(page.getByText('Previous briefings', { exact: true })).toHaveCount(0);
  await page.locator('.employee-row').filter({ hasText: 'Chief of Staff' }).click();
  await page.getByRole('button', { name: 'Morning briefings', exact: true }).click();
  await page.getByRole('button', { name: /View recap/ }).first().click();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await expect(page.locator('.briefing-recap')).toContainText('customer research');
  const olderTeam = supervisor.briefings!.create(owner.id, [employees[1].id]);
  supervisor.briefings!.saveBrief(olderTeam.id, owner.id, 'Earlier team briefing retained for review.');
  await page.getByRole('button', { name: 'Open workspace navigation' }).click();
  await page.locator('.employee-row').filter({ hasText: 'Chief of Staff' }).click();
  await page.getByRole('button', { name: 'Morning briefings', exact: true }).click();
  await screenshots('history');
  await page.getByRole('button', { name: /Resume conversation/ }).first().click();
  await expect(page.getByLabel('Your briefing')).toHaveValue('Earlier team briefing retained for review.');
  expect(store.setting('notifications.' + owner.id).enabled).toBe(false);
  expect(store.setting('notifications.delivery.' + owner.id)).toBeNull();
  expect(errors).toEqual([]);
  console.log(
    'Chief of Staff: 28 existing employees; no preparation runs; same connection for discussion, recap and correction; captions follow audible output word by word; two live controls; spoken plan with leads, sequencing and voice undo; ending saves recap and sends agreed work without a second approval; desktop/mobile light/dark passed. Voice transport mocked.',
  );
} catch (error) {
  console.error('Chief briefing UI failure:', errors, await page.locator('body').innerText());
  await page.screenshot({ path: 'evidence/chief-briefing-ui-failure.png' });
  throw error;
} finally {
  clearInterval(timer);
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
