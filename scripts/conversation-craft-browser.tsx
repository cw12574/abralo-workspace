import React from 'react';
import { createRoot } from 'react-dom/client';
import { BriefingsView } from '../apps/web/src/chief-briefing-view';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '../apps/web/src/style.css';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'live';
document.documentElement.dataset.theme = params.get('theme') || 'light';
if (params.get('large')) document.documentElement.style.fontSize = '28px';
const style = document.createElement('style');
style.textContent =
  'html,body,#root{height:100%;width:100%;overflow:hidden}#root{display:flex}.preview-side{width:230px;flex-shrink:0;background:var(--side);padding:24px;color:var(--muted);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:24px}.preview-side strong{color:var(--ink);font-size:20px;font-weight:500}.preview-side span{font-size:14px}.preview-side b{padding:12px;background:var(--tint);color:var(--ink);border-radius:6px;font-weight:400}@media(max-width:720px){.preview-side{display:none}}';
document.head.append(style);
const people = [
  { id: 'chief', name: 'Chief of Staff', role: 'Chief of Staff' },
  { id: 'maya', name: 'Maya', role: 'Customer research' },
];
let b: any = {
  id: 'fixture',
  hostId: 'chief',
  ownerId: 'owner',
  mode: 'chief',
  version: 1,
  createdAt: new Date().toISOString(),
  phase: mode === 'recap' ? 'review' : mode === 'complete' ? 'complete' : 'brief',
  brief: '',
  participants: people,
  questions: [],
  actions: [],
  recap:
    'We agreed to learn where new customers get stuck. Maya will investigate onboarding and bring back the evidence. Pricing remains an open question.',
  executedActions:
    mode === 'recap' || mode === 'complete'
      ? [
          {
            title: 'Make onboarding easier',
            status: 'queued',
            name: 'Maya',
            employeeId: 'maya',
            goalId: 'goal',
            receiptMessageId: 'receipt',
            summary: 'Maya has the onboarding research goal. Work is queued.',
            task: 'Review the recent onboarding feedback.',
          },
        ]
      : [],
  turns: Array.from({ length: 14 }, (_, i) => ({
    id: 'turn' + i,
    speaker: i % 2 ? 'chief' : 'You',
    text:
      i % 2
        ? 'Let’s start with customer research. We can learn where people get stuck, then agree on the smallest useful change. Would you like Maya to investigate onboarding first?'
        : 'I want to understand the problem before we change anything. Please keep the findings grounded in real customer feedback.',
  })),
};
const realFetch = window.fetch.bind(window);
let failWrites = false;
let actionWrites = 0;
window.fetch = async (input: any, options?: RequestInit) => {
  const path = String(input);
  if (!path.startsWith('/api/')) return realFetch(input, options);
  const data = options?.body ? JSON.parse(String(options.body)) : {};
  let result: any = b,
    status = 200;
  if (path.endsWith('/roster')) result = people;
  else if (path === '/api/briefings/voice')
    result = { configured: true, model: 'fixture', hostId: 'chief' };
  else if (path.endsWith('/voice')) result = { sdp: 'fixture' };
  else if (path.endsWith('/voice-context')) result = { instructions: 'Fixture' };
  else if (path.endsWith('/turns')) {
    if (failWrites) {
      status = 503;
      result = { error: 'Temporary test failure' };
    } else {
      if (!b.turns.some((t: any) => t.id === data.id))
        b = { ...b, version: b.version + 1, turns: [...b.turns, data] };
      result = b;
    }
  } else if (path.endsWith('/playback')) {
    b = {
      ...b,
      version: b.version + 1,
      turns: b.turns.map((t: any) =>
        t.id === data.id ? { ...t, delivery: 'interrupted', heardText: data.heardText } : t,
      ),
    };
    result = b;
  } else if (path.endsWith('/brief')) {
    b = { ...b, version: b.version + 1, brief: data.brief };
    result = b;
  } else if (path.endsWith('/recap')) {
    b = {
      ...b,
      version: b.version + 1,
      phase: 'review',
      recap: data.summary,
      actions: data.actions,
    };
    result = b;
  } else if (path.endsWith('/dispatch')) {
    b = { ...b, version: b.version + 1, phase: 'complete' };
    result = b;
  } else if (path.endsWith('/act')) {
    actionWrites++;
    result = { briefing: b, result: {} };
  }
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json' },
  });
};
let channel: any;
const fakeTrack = { enabled: true, stop() {} };
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: {
    getUserMedia: async () => ({ getTracks: () => [fakeTrack], getAudioTracks: () => [fakeTrack] }),
  },
});
(window as any).Audio = class {
  autoplay = true;
  srcObject = null;
  play() {
    return Promise.resolve();
  }
  pause() {}
};
(window as any).RTCPeerConnection = class {
  addTrack() {}
  createDataChannel() {
    channel = { readyState: 'open', send() {}, close() {} };
    return channel;
  }
  async createOffer() {
    return { sdp: 'fixture' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    channel.onopen();
  }
  close() {}
};
// Avoid audio hardware in the fixture; production still uses its real meter.
(window as any).AudioContext = undefined;
createRoot(document.getElementById('root')!).render(
  <>
    <aside className="preview-side">
      <strong>abralo</strong>
      <span>Your workspace</span>
      <span>Goals</span>
      <b>Morning briefing</b>
      <span>Chief of Staff</span>
      <span>Maya</span>
    </aside>
    <BriefingsView
      initialBriefingId={mode === 'home' ? undefined : 'fixture'}
      onOpenVoiceSettings={() => {}}
    />
  </>,
);
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => unknown, message: string) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await wait();
  }
  throw Error(message);
}
const button = (name: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (el) => (el.getAttribute('aria-label') || el.textContent?.trim()) === name,
  )!;
async function click(name: string) {
  await until(() => button(name), 'Missing button: ' + name);
  button(name).click();
  await wait();
}
function event(data: any) {
  channel.onmessage({ data: JSON.stringify(data) });
}
async function reply(id: string, text: string) {
  event({ type: 'response.created', response: { id } });
  event({ type: 'output_audio_buffer.started', response_id: id });
  event({
    type: 'response.output_audio_transcript.done',
    response_id: id,
    item_id: id,
    transcript: text,
  });
  event({ type: 'output_audio_buffer.stopped', response_id: id });
  event({ type: 'response.done', response: { id } });
  await wait();
}
const checks: { label: string; passed: boolean }[] = [];
function check(label: string, yes: boolean) {
  checks.push({ label, passed: yes });
  if (!yes) throw Error(label);
}
async function run() {
  await until(() => document.querySelector('h1'), 'No component');
  if (['home', 'recap', 'complete'].includes(mode)) return;
  await click('Resume voice');
  await until(() => document.body.textContent?.includes('Listening'), 'No connected state');
  await reply(
    'new',
    'We can make this simpler. Start with what customers are trying to do, then look at the moment they get stuck. Maya can bring back the evidence before we change anything.',
  );
  if (mode === 'error') {
    failWrites = true;
    event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'failed',
      transcript: 'Keep my exact words so I do not have to repeat them.',
    });
    await until(() => button('Retry saving'), 'No recovery action');
    return;
  }
  if (mode !== 'tests') return;
  check(
    'Live thought is not individually scrollable',
    getComputedStyle(document.querySelector('.chief-caption')!).overflowY === 'visible',
  );
  const live = document.querySelector('.chief-caption')!;
  check('Live thought is a short complete phrase group', live.textContent!.length <= 180);
  await click('Previous thought');
  const reading = live.textContent;
  await reply('later', 'A new thought arrives while you are reading back.');
  check('Reading back holds the chosen thought', live.textContent === reading);
  await click('Back to live');
  check('Back to live shows the current thought', live.textContent!.includes('A new thought'));
  await click('Conversation');
  const transcript = document.querySelector('.chief-transcript-scroll')! as HTMLElement;
  check(
    'Transcript contains both speakers',
    transcript.textContent!.includes('You') && transcript.textContent!.includes('Chief of Staff'),
  );
  transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  transcript.scrollTop = 0;
  transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
  await wait();
  await reply('latest', 'Another reply should not move your reading position.');
  check('Transcript scrollback stays in place', transcript.scrollTop === 0);
  await click('Back to latest');
  check(
    'Transcript follows only on request',
    transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 8,
  );
  await click('Hide conversation');
  await click('Mute microphone');
  check('Mute takes effect immediately', !fakeTrack.enabled);
  await click('Unmute');
  check('Unmute restores the microphone', fakeTrack.enabled);
  await click('Type instead');
  const textarea = document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    textarea,
    'Keep this typed brief when I resume.',
  );
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await wait();
  await click('Continue by voice');
  check(
    'Switching to voice persists typed words',
    b.brief === 'Keep this typed brief when I resume.',
  );
  failWrites = true;
  event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'retry',
    transcript: 'Please retain these exact words.',
  });
  await until(() => button('Retry saving'), 'No recovery action');
  failWrites = false;
  await click('Retry saving');
  await until(() => !document.querySelector('[role=alert]'), 'Recovery did not clear');
  check(
    'Recovery saves the retained request once',
    b.turns.filter((t: any) => t.id === 'retry').length === 1,
  );
  check('Saving a request never replays an action', actionWrites === 0);
  event({ type: 'response.created', response: { id: 'interrupted' } });
  event({ type: 'output_audio_buffer.started', response_id: 'interrupted' });
  event({
    type: 'response.output_audio_transcript.delta',
    response_id: 'interrupted',
    item_id: 'interrupted',
    delta: 'This was shown. This part was never played.',
  });
  event({ type: 'input_audio_buffer.speech_started', item_id: 'interrupting-human' });
  event({
    type: 'response.output_audio_transcript.done',
    response_id: 'interrupted',
    item_id: 'interrupted',
    transcript: 'This was shown. This part was never played.',
  });
  await until(
    () => b.turns.find((t: any) => t.id === 'interrupted')?.delivery === 'interrupted',
    'Interruption not saved',
  );
  check(
    'Interrupted transcript records the revealed portion',
    b.turns.find((t: any) => t.id === 'interrupted').heardText === 'This was shown.',
  );
  await click('Conversation');
  check(
    'Unspoken continuation is collapsed separately',
    document.querySelector('.chief-transcript details')?.textContent?.includes('full text') ||
      false,
  );
  check('No horizontal page overflow', document.documentElement.scrollWidth <= innerWidth);
}
void run()
  .then(async () => {
    await wait(100);
    check('Layout has no horizontal overflow', document.documentElement.scrollWidth <= innerWidth);
    const primary = document.querySelector('.chief-controls > .primary') as HTMLElement;
    if (primary) {
      primary.scrollIntoView({ block: 'nearest' });
      await wait();
      const bounds = primary.getBoundingClientRect();
      check('Primary action remains reachable', bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.right <= innerWidth);
    }
    const caption = document.querySelector('.chief-caption');
    if (caption) check('Enlarged captions are never clipped', getComputedStyle(caption).overflowY === 'visible' && caption.clientHeight >= caption.scrollHeight - 1);
    await realFetch('/result?layout=' + encodeURIComponent(`${mode}-${document.documentElement.dataset.theme}-${innerWidth}-${params.get('large') ? 'large' : 'normal'}`), {
      method: 'POST', body: JSON.stringify({ passed: true, checks }, null, 2),
    });
    if (mode === 'tests') {
      document.title = 'PASS: conversation checks';
      await realFetch('/result', {
        method: 'POST',
        body: JSON.stringify({ passed: true, checks }, null, 2),
      });
    }
  })
  .catch(async (error) => {
    document.title = 'FAIL: ' + error.message;
    const message = document.createElement('pre');
    message.textContent = 'Verification failed: ' + error.stack;
    document.body.append(message);
    await realFetch('/result', {
      method: 'POST',
      body: JSON.stringify({ passed: false, error: error.message, checks }, null, 2),
    });
  });
