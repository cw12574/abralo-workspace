import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, uid, now } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const dir = mkdtempSync(join(tmpdir(), 'workspace-ui-'));
const store = new Store(dir);
const owner = store.createOwner('Chris');
store.set('workspace.onboarded', true);
store.set('workspace.name', 'Studio');
const chief = store.createEmployee(owner.id, {
  name: 'Chief of Staff',
  role: 'Organizes the team',
  harness: 'codex',
  model: '',
  cwd: '',
  instructions: '',
});
const ada = store.createEmployee(owner.id, {
  name: 'Ada',
  role: 'Engineering',
  harness: 'claude',
  model: '',
  cwd: '',
  instructions: '',
});
const growth = store.createEmployee(owner.id, {
  name: 'Growth Engineer',
  role: 'Growth experiments',
  harness: 'opencode',
  model: '',
  cwd: '',
  instructions: '',
});
const channel = uid();
store.run(
  'INSERT INTO conversations VALUES(?,?,?,?,?)',
  channel,
  'product',
  'channel',
  null,
  now(),
);
store.run('INSERT INTO members(conversation_id,user_id) VALUES(?,?)', channel, owner.id);
store.set('conversation.workingFolder.' + channel, dir);
const threadRoot = store.addMessage(
  channel,
  owner.id,
  'Chris',
  'human',
  'Let’s make the first experience feel effortless.',
);
store.addMessage(
  channel,
  growth.id,
  growth.name,
  'agent',
  'I found a promising group of early adopters to interview.',
  threadRoot.id,
);
store.addMessage(
  channel,
  chief.id,
  chief.name,
  'agent',
  'The foundation is ready for review.\n\n- Messages persist through a restart.\n- Employee identities stay separate from their model sessions.\n- Reviews happen here, in conversation.\n\n@Ada — please check the attachment flow next. Use #team to share the result; literal `@Ada #team` stays code.',
);
const adaReply = store.addMessage(
  channel,
  ada.id,
  ada.name,
  'agent',
  'I’ll check paste, drag-and-drop and retry behaviour. A failed upload should keep the draft intact.',
  null,
  [],
  'synthetic-stream',
);
const toolReply = store.addMessage(
  ada.dmId,
  ada.id,
  ada.name,
  'agent',
  'I reviewed the workspace and am checking the build.',
  null,
  [],
  'synthetic-toolchain',
);
const messageTextAt = new Date(Date.now() - 5000).toISOString();
store.run('UPDATE messages SET text_updated_at=? WHERE id=?', messageTextAt, toolReply.id);
for (const [index, activity] of [
  { id: 'smoke-read-files', title: 'Read project files', state: 'complete' },
  { id: 'smoke-checks', title: 'Run focused checks', state: 'running' },
].entries()) {
  const time = new Date(Date.now() - (2 - index) * 1000).toISOString();
  const id = `synthetic-toolchain:${activity.id}`;
  store.run(
    'INSERT INTO activities(id,run_id,data) VALUES(?,?,?)',
    id,
    'synthetic-toolchain',
    JSON.stringify({
      ...activity,
      id,
      type: 'tool',
      time,
      updatedAt: time,
      detail: activity.title,
    }),
  );
}
const { app } = await createApp(store);
// Persist synthetic run state so cache revalidation sees the same fixture as events.
for (const [runId, message, conversationId] of [
  ['synthetic-stream', adaReply, channel],
  ['synthetic-toolchain', toolReply, ada.dmId],
] as const) {
  store.run(
    'INSERT INTO runs(id,conversation_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
    runId,
    conversationId,
    owner.id,
    ada.id,
    message.id,
    message.id,
    'completed',
    now(),
    now(),
    runId,
  );
}

const address = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const failures: string[] = [];
page.on('pageerror', (e) => failures.push(e.message));
const bootstrap = await page.request.post(address + '/api/bootstrap', {
  data: { token: store.bootstrapToken },
  headers: { 'x-workspace-request': '1' },
});
if (!bootstrap.ok()) throw new Error(await bootstrap.text());
await page.goto(address);
await page.getByRole('button', { name: 'product', exact: false }).first().click();
const focusedComposer = page.getByRole('textbox', { name: 'Message', exact: true });
await focusedComposer.fill('Keep this draft focused');
await focusedComposer.focus();
const accessRunId = uid();
const accessDecisionId = uid();
store.run(
  'INSERT INTO runs(id,conversation_id,thread_id,user_id,employee_id,message_id,response_id,state,created_at,updated_at,context_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  accessRunId,
  channel,
  null,
  owner.id,
  ada.id,
  threadRoot.id,
  uid(),
  'waiting',
  now(),
  now(),
  `smoke:${accessRunId}`,
);
store.run(
  'INSERT INTO decisions(id,run_id,user_id,state,data) VALUES(?,?,?,?,?)',
  accessDecisionId,
  accessRunId,
  owner.id,
  'pending',
  JSON.stringify({
    kind: 'workspace_access',
    title: 'Ada requests a GitHub repository',
    detail: { type: 'github', reason: 'Review the repository.' },
  }),
);
await page.evaluate((conversationId) => {
  window.dispatchEvent(
    new CustomEvent('workspace-event', {
      detail: { conversationId, type: 'decision.created', payload: { id: 'new-access-request' } },
    }),
  );
}, channel);
await page.getByRole('textbox', { name: 'Approved GitHub repository' }).waitFor();
const accessCard = page
  .locator('.decision')
  .filter({ hasText: 'Ada requests a GitHub repository' });
await accessCard.waitFor();
if (!(await focusedComposer.evaluate((el) => el === document.activeElement)))
  throw new Error(
    'Focus moved to: ' +
      (await page.evaluate(() => (document.activeElement as HTMLElement)?.outerHTML)),
  );
await page.keyboard.type(' still goes to the composer');
if ((await focusedComposer.inputValue()) !== 'Keep this draft focused still goes to the composer')
  throw new Error('Typing after an access request did not stay in the composer');
await focusedComposer.fill('');
await page.getByRole('button', { name: 'product', exact: false }).first().click();
await page.locator('.entity-mention').getByText('@Ada', { exact: true }).waitFor();
await page.locator('.entity-channel').getByText('#team', { exact: true }).click();
await page.getByRole('heading', { name: 'Team', exact: true }).waitFor();
if (!(await page.getByRole('button', { name: '#product', exact: false }).first().isVisible()))
  throw new Error('Room names in the sidebar do not show their # reference');
const roomComposer = page.getByRole('textbox', { name: 'Message', exact: true });
await roomComposer.fill('#pro');
await page.getByRole('listbox', { name: 'Choose a room' }).waitFor();
await page.getByRole('option', { name: /#product/ }).waitFor();
if ((await page.getByRole('option').count()) !== 1)
  throw new Error('Room suggestions did not filter to the matching room');
await page.screenshot({ path: 'evidence/room-suggestions.png' });
await roomComposer.press('Enter');
if ((await roomComposer.inputValue()) !== '#product ')
  throw new Error('Selecting a room did not insert its # reference');
await roomComposer.fill('');
await page.getByRole('button', { name: 'product', exact: false }).first().click();
const literalCode = page.locator('.prose code').getByText('@Ada #team', { exact: true });
if ((await literalCode.count()) !== 1)
  throw new Error(
    `Inline code content was transformed as a mention or channel reference: ${JSON.stringify(await page.locator('.prose code').allTextContents())}`,
  );
await page
  .getByRole('textbox', { name: 'Message', exact: true })
  .fill('Draft retained across conversations');
await page.waitForTimeout(650);
await page.getByRole('button', { name: 'Chief of Staff', exact: false }).first().click();
await page.getByRole('button', { name: 'product', exact: false }).first().click();
await page.waitForTimeout(500);
if (
  (await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue()) !==
  'Draft retained across conversations'
)
  throw new Error('Draft lost');
await page.getByRole('button', { name: 'Send message', exact: true }).click();
await page.getByText('Draft retained across conversations', { exact: true }).waitFor();
await page.setViewportSize({ width: 1280, height: 640 });
const folderContext = page.locator('.composer-folder-chip');
await folderContext.waitFor();
await page.mouse.move(0, 0);
const folderStyle = await folderContext.evaluate((el) => {
  const clear = el.querySelector('.composer-folder-clear')!;
  return {
    background: getComputedStyle(el).backgroundColor,
    border: getComputedStyle(el).borderTopColor,
    clearVisibility: getComputedStyle(clear).visibility,
  };
});
if (
  folderStyle.background !== 'rgba(0, 0, 0, 0)' ||
  folderStyle.border !== 'rgba(0, 0, 0, 0)' ||
  folderStyle.clearVisibility !== 'hidden'
)
  throw new Error(
    `Working folder should read as quiet environment context: ${JSON.stringify(folderStyle)}`,
  );
await folderContext.hover();
if (
  (await folderContext
    .getByRole('button', { name: 'Clear working folder' })
    .evaluate((el) => getComputedStyle(el).visibility)) !== 'visible'
)
  throw new Error('The working folder clear control should appear on hover');
await page.mouse.move(0, 0);
await page.screenshot({ path: 'evidence/working-folder-context.png' });
await page
  .getByText('Draft retained across conversations', { exact: true })
  .scrollIntoViewIfNeeded();
const messageToEdit = page.locator('.message').filter({
  hasText: 'Draft retained across conversations',
});
await messageToEdit.hover();
await messageToEdit.getByRole('button', { name: 'Edit message' }).click();
await page.getByRole('textbox', { name: 'Edit message' }).fill('A clearer message after editing.');
await page.screenshot({ path: 'evidence/message-edit-light.png' });
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByText('A clearer message after editing.', { exact: true }).waitFor();
const messageToDelete = page
  .locator('.message')
  .filter({ hasText: 'A clearer message after editing.' });
await messageToDelete.hover();
await messageToDelete.getByRole('button', { name: 'Delete message' }).click();
const deleteMessageDialog = page.locator('dialog.confirm-workspace-action');
await page.screenshot({ path: 'evidence/message-delete-confirm-light.png' });
await deleteMessageDialog.getByRole('button', { name: 'Delete message', exact: true }).click();
await page.waitForTimeout(500);
const renderedMessages = await page.locator('.message').allTextContents();
if (!renderedMessages.some((text) => text.includes('Message deleted')))
  throw new Error(
    `Deleted message did not render its placeholder: ${JSON.stringify(renderedMessages.slice(-4))}`,
  );
store.run("UPDATE runs SET state='running' WHERE id='synthetic-stream'");
await page.evaluate(
  ({ conversationId, messageId, offset, messageTextAt, run }) => {
    window.dispatchEvent(
      new CustomEvent('workspace-event', {
        detail: {
          conversationId,
          type: 'run.changed',
          payload: run,
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('workspace-event', {
        detail: {
          conversationId,
          createdAt: messageTextAt,
          type: 'message.updated',
          payload: { id: messageId, offset, delta: ' First.', textUpdatedAt: messageTextAt },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('workspace-event', {
        detail: {
          conversationId,
          createdAt: messageTextAt,
          type: 'message.updated',
          payload: {
            id: messageId,
            offset: offset + ' First.'.length,
            delta: ' Second.',
            textUpdatedAt: messageTextAt,
          },
        },
      }),
    );
  },
  {
    conversationId: channel,
    messageId: adaReply.id,
    run: store.one("SELECT * FROM runs WHERE id='synthetic-stream'"),
    offset: adaReply.text.length,
    messageTextAt,
  },
);
const streamingText = page.locator('.prose-streaming');
await streamingText.getByText(/First\. Second\./).waitFor();
await expect(streamingText.locator('.text-reveal')).toHaveCount(0);
if (
  await streamingText
    .locator('p:last-child')
    .evaluate((el) => getComputedStyle(el, '::after').content !== 'none')
)
  throw new Error('Streaming text unexpectedly shows a blinking caret');
await page.screenshot({ path: 'evidence/streaming-live.png' });
await page.getByRole('button', { name: 'Reply in thread' }).first().click();
const threadComposer = page
  .locator('.thread')
  .getByRole('textbox', { name: 'Message', exact: true });
await threadComposer.fill('@grow');
await page.getByRole('option', { name: /Growth Engineer/ }).waitFor();
mkdirSync('evidence', { recursive: true });
await page.screenshot({ path: 'evidence/thread-mention-suggestions.png' });
await threadComposer.press('Enter');
if ((await threadComposer.inputValue()) !== '@Growth Engineer ')
  throw new Error('Selecting a mention did not insert the employee name');
await threadComposer.fill('Thread reply with the conversation folder selected');
await page.locator('.thread').getByRole('button', { name: 'Send message', exact: true }).click();
await page
  .locator('.thread')
  .getByText('Thread reply with the conversation folder selected', { exact: true })
  .waitFor();
await page.getByRole('button', { name: 'Close thread' }).click();
await page.getByRole('button', { name: 'Ada', exact: false }).first().click();
await page
  .getByText('I reviewed the workspace and am checking the build.', { exact: true })
  .waitFor();
await page.evaluate(() => {
  window.dispatchEvent(
    new CustomEvent('workspace-event', {
      detail: {
        type: 'run.changed',
        payload: { id: 'synthetic-toolchain', employee_id: 'ada', state: 'running' },
      },
    }),
  );
});
const toolMessage = page
  .locator('.message')
  .filter({ hasText: 'I reviewed the workspace and am checking the build.' });
const activityTrail = toolMessage.locator('.tool-group');
await activityTrail.waitFor();
if (
  !(await toolMessage.evaluate((el) => {
    const text = el.querySelector('.prose');
    const trail = el.querySelector('.tool-group');
    return !!(
      text &&
      trail &&
      text.compareDocumentPosition(trail) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  }))
)
  throw new Error('Activity trail should follow the message when its latest update is more recent');
if (await toolMessage.locator('.run-status').count())
  throw new Error('An active toolchain should replace the duplicate Working status');
await activityTrail.getByRole('button', { name: /Show 2 activity steps/ }).click();
const timelineSteps = activityTrail.locator('.toolchain-step');
const timelineText = (await timelineSteps.allTextContents()).join('|');
if (timelineText.indexOf('Read project files') > timelineText.indexOf('Run focused checks'))
  throw new Error('Toolchain steps are not shown in chronological order');
await page.screenshot({ path: 'evidence/agent-toolchain.png' });
await page.getByRole('button', { name: 'product', exact: false }).first().click();
const team = store.one("SELECT id FROM conversations WHERE lower(name)='team'");
store.emit(
  'notification.message',
  team.id,
  { id: threadRoot.id, authorName: growth.name, text: 'A useful update arrived.', threadId: null },
  owner.id,
);
const dismissToast = page.getByRole('button', {
  name: 'Dismiss notification from Growth Engineer',
});
await dismissToast.waitFor();
await dismissToast.click();
await page.locator('.toast').waitFor({ state: 'detached' });
const notificationButton = page.getByRole('button', { name: /Notifications/ });
await notificationButton.click();
const notificationPanel = page.getByRole('dialog', { name: 'Notifications' });
await notificationPanel.waitFor();
const panelBounds = await notificationPanel.boundingBox();
const buttonBounds = await notificationButton.boundingBox();
if (
  !panelBounds ||
  !buttonBounds ||
  panelBounds.width < 600 ||
  panelBounds.y < buttonBounds.y + buttonBounds.height
)
  throw new Error('Notification panel is too narrow or is not anchored below its trigger');
await page.screenshot({ path: 'evidence/notifications-popover.png' });
await page.keyboard.press('Escape');
await notificationPanel.waitFor({ state: 'detached' });
if (!(await notificationButton.evaluate((el) => el === document.activeElement)))
  throw new Error('Closing the notification panel did not return focus to its trigger');
await page.screenshot({ path: 'evidence/workspace-desktop.png', fullPage: true });
await page.getByRole('button', { name: 'Toggle theme' }).click();
const darkConfirmMessage = store.addMessage(
  channel,
  owner.id,
  owner.name,
  'human',
  'Delete confirmation in dark mode',
);
await page.getByText('Delete confirmation in dark mode', { exact: true }).waitFor();
const darkConfirmRow = page
  .locator('.message')
  .filter({ hasText: 'Delete confirmation in dark mode' });
await darkConfirmRow.hover();
await darkConfirmRow.getByRole('button', { name: 'Delete message' }).click();
const darkConfirmDialog = page.locator('dialog.confirm-workspace-action');
await page.screenshot({ path: 'evidence/message-delete-confirm-dark.png' });
await darkConfirmDialog.getByRole('button', { name: 'Keep message' }).click();
await darkConfirmRow.getByRole('button', { name: 'Edit message' }).click();
await page.screenshot({ path: 'evidence/message-edit-dark.png' });
await page.getByRole('button', { name: 'Cancel', exact: true }).click();
await page.screenshot({ path: 'evidence/workspace-dark.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await notificationButton.click();
await notificationPanel.waitFor();
const mobilePanel = await notificationPanel.boundingBox();
if (!mobilePanel || mobilePanel.x < 0 || mobilePanel.x + mobilePanel.width > 390)
  throw new Error('Notification panel does not fit the mobile viewport');
await page.screenshot({ path: 'evidence/notifications-mobile.png' });
await page.keyboard.press('Escape');
await notificationPanel.waitFor({ state: 'detached' });
await page.screenshot({ path: 'evidence/workspace-mobile.png', fullPage: true });
await darkConfirmRow.getByRole('button', { name: 'Delete message' }).click();
await page.screenshot({ path: 'evidence/message-delete-confirm-mobile.png' });
await page
  .locator('dialog.confirm-workspace-action')
  .getByRole('button', { name: 'Keep message' })
  .click();
await darkConfirmRow.getByRole('button', { name: 'Edit message' }).click();
await page.screenshot({ path: 'evidence/message-edit-mobile.png' });
await page.getByRole('button', { name: 'Cancel', exact: true }).click();
await page.setViewportSize({ width: 1033, height: 768 });
const planMessage = store.addMessage(
  channel,
  chief.id,
  chief.name,
  'agent',
  'A concise plan for the next workstream: review the work and report back.',
);
await page.evaluate((conversationId) => {
  window.dispatchEvent(
    new CustomEvent('workspace-event', {
      detail: { conversationId, type: 'artifact.created', payload: {} },
    }),
  );
}, channel);
const planCover = page
  .locator('.message')
  .filter({ hasText: 'A concise plan for the next workstream:' })
  .last();
await planCover.waitFor();
const accessBounds = await accessCard.boundingBox();
const planBounds = await planCover.boundingBox();
if (!planBounds || !accessBounds || accessBounds.y < planBounds.y + planBounds.height)
  throw new Error('The access request overlaps the message above it');
const messageRows = await page.locator('.message-scroll [data-index]').evaluateAll((rows) =>
  rows.map((row) => {
    const box = row.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      message: row.querySelector('.message')?.textContent?.slice(-70),
    };
  }),
);
for (let i = 1; i < messageRows.length; i++) {
  if (messageRows[i].top < messageRows[i - 1].bottom - 1)
    throw new Error(`Virtualized messages overlap: ${JSON.stringify(messageRows)}`);
}
await page.screenshot({ path: 'evidence/plan-access-spacing.png' });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
if (overflow) throw new Error('Horizontal overflow');
if (failures.length) throw new Error(failures.join('\n'));
console.log(
  JSON.stringify({
    status: 'passed',
    checks: [
      'persistent conversation draft',
      'real message send',
      'edit and confirmed deletion of own messages',
      'edit and delete layouts at 1280×640, in both themes, and on mobile',
      'batched streaming updates without a blinking caret',
      'thread open/close',
      'thread mention suggestions and keyboard selection',
      'sidebar # room labels and filtered composer room suggestions',
      'incoming access requests keep composer focus',
      'messages and following access requests have no overlap',
      'dismissible bottom-right notification toast',
      'wide notification popover anchored to its button, with keyboard dismissal and mobile sizing',
      'desktop/dark/mobile',
      'no page errors',
      'no horizontal overflow',
    ],
    fixture: 'isolated test database; no provider run claimed',
  }),
);
await browser.close();
await app.close();
