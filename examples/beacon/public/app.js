'use strict';

const $ = id => document.getElementById(id);
const state = { monitors: [], selected: null, pending: new Set(), listVersion: 0, detailVersion: 0, deleting: null, creating: false, removing: false };
const labels = { up: 'Operational', down: 'Down', unknown: 'Awaiting check' };
const stamp = value => value ? new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never checked';
const latency = value => value === null ? '—' : `${value.toLocaleString()} ms`;
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function message(id, text) { $(id).textContent = text; $(id).hidden = !text; }
function badge(node, status) { node.className = `badge ${status}`; node.textContent = labels[status] ?? status; }
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, signal: AbortSignal.timeout(40000), headers: options.body ? { 'Content-Type': 'application/json' } : undefined });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'Request timed out. Refresh to verify the result before retrying.' : 'Cannot reach Beacon. Check that the local server is running.');
  }
  if (response.status === 204) return null;
  let body;
  try { body = await response.json(); } catch { throw new Error(`Unexpected server response (${response.status}).`); }
  if (!response.ok) { const error = new Error(body.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
  return body;
}
function makeRow(monitor) {
  const row = el('tr'); row.dataset.id = monitor.id;
  const endpoint = el('td'); endpoint.append(el('span', 'endpoint-name'), el('span', 'endpoint-url'));
  const status = el('td'); status.append(el('span', 'badge'), el('span', 'cell-sub'));
  const timing = el('td');
  const uptime = el('td'); uptime.append(el('span'), el('span', 'cell-sub'));
  const checked = el('td'); checked.append(el('time'));
  const actions = el('td'); const group = el('div', 'actions');
  for (const [action, label] of [['history', 'History'], ['check', 'Check now'], ['remove', 'Remove']]) {
    const button = el('button', action === 'remove' ? 'remove' : '', label);
    button.type = 'button'; button.dataset.action = action;
    button.setAttribute('aria-label', `${label}: ${monitor.name}`);
    group.append(button);
  }
  actions.append(group); row.append(endpoint, status, timing, uptime, checked, actions);
  return row;
}
function renderList() {
  $('total').textContent = state.monitors.length;
  $('monitor-count').textContent = state.monitors.length;
  for (const status of ['up', 'down', 'unknown']) $(status).textContent = state.monitors.filter(m => m.status === status).length;
  $('empty').hidden = state.monitors.length !== 0;
  $('monitor-table-wrap').hidden = state.monitors.length === 0;
  const rows = $('monitor-rows');
  const existing = new Map([...rows.children].map(row => [row.dataset.id, row]));
  for (const m of state.monitors) {
    let row = existing.get(m.id);
    if (!row) { row = makeRow(m); rows.append(row); }
    existing.delete(m.id);
    row.classList.toggle('selected', state.selected === m.id);
    const cells = row.children;
    cells[0].children[0].textContent = m.name;
    cells[0].children[1].textContent = m.url;
    badge(cells[1].children[0], m.status);
    cells[1].children[1].textContent = m.error ?? (m.statusCode ? `HTTP ${m.statusCode}` : 'First check pending');
    cells[2].textContent = latency(m.latencyMs);
    cells[3].children[0].textContent = m.uptimePercent === null ? '—' : `${m.uptimePercent.toFixed(2)}%`;
    cells[3].children[1].textContent = `${m.checkCount.toLocaleString()} retained checks`;
    cells[4].firstChild.textContent = stamp(m.lastCheckedAt);
    if (m.lastCheckedAt) cells[4].firstChild.dateTime = m.lastCheckedAt;
    const buttons = cells[5].querySelectorAll('button');
    buttons[0].setAttribute('aria-pressed', String(state.selected === m.id));
    buttons[1].disabled = state.pending.has(m.id);
    buttons[1].textContent = state.pending.has(m.id) ? 'Checking…' : 'Check now';
    buttons[2].disabled = state.pending.has(m.id) || (state.removing && state.deleting?.id === m.id);
  }
  for (const row of existing.values()) row.remove();
}
async function refresh() {
  const version = ++state.listVersion;
  try {
    const data = await api('/api/monitors');
    if (version !== state.listVersion) return;
    state.monitors = data.monitors;
    renderList();
    message('list-error', '');
    $('sync-status').textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    if (state.selected && !state.monitors.some(m => m.id === state.selected)) closeHistory();
    if (state.selected) await loadHistory();
  } catch (error) {
    if (version !== state.listVersion) return;
    message('list-error', `${error.message} Displayed values may be out of date. Use Refresh to retry.`);
    $('sync-status').textContent = 'Refresh failed · data may be stale';
  } finally { if (version === state.listVersion) $('loading').hidden = true; }
}
function closeHistory() {
  state.selected = null; state.detailVersion++;
  $('history-content').hidden = true; $('history-placeholder').hidden = false; $('close-history').hidden = true;
  renderList();
}
async function loadHistory(initial = false) {
  const id = state.selected;
  if (!id) return;
  const version = ++state.detailVersion;
  if (initial) { $('history-loading').hidden = false; $('history-data').hidden = true; message('history-error', ''); }
  try {
    const data = await api(`/api/monitors/${encodeURIComponent(id)}`);
    if (version !== state.detailVersion || id !== state.selected) return;
    $('history-name').textContent = data.monitor.name;
    $('history-url').textContent = data.monitor.url;
    $('history-config').textContent = `Every ${data.monitor.intervalSeconds}s · Timeout ${data.monitor.timeoutMs.toLocaleString()} ms · ${data.monitor.checkCount} retained checks`;
    badge($('history-status'), data.monitor.status);
    $('incident-count').textContent = data.incidents.length;
    const incidents = data.incidents.map(incident => {
      const open = incident.resolvedAt === null;
      const card = el('article', `incident${open ? ' open' : ''}`);
      const top = el('div', 'incident-top');
      top.append(el('strong', '', open ? 'Ongoing outage' : 'Recovered'), el('span', 'subtle', duration(open ? Date.now() - Date.parse(incident.startedAt) : incident.durationMs)));
      card.append(top, el('p', '', `Started ${stamp(incident.startedAt)}`), el('p', '', open ? 'Awaiting recovery' : `Recovered ${stamp(incident.resolvedAt)}`), el('p', '', `${incident.failureCount} failed ${incident.failureCount === 1 ? 'check' : 'checks'}`), el('p', 'incident-error', incident.lastError));
      return card;
    });
    $('incidents').replaceChildren(...(incidents.length ? incidents : [el('p', 'empty compact', data.checks.length ? 'No outages in retained history.' : 'No incidents yet. Waiting for the first check.')]));
    const checkList = el('div', 'check-list');
    for (const check of data.checks.slice(0, 20)) {
      const row = el('div', 'check'); const status = el('span'); badge(status, check.status);
      const info = el('div'); const time = el('time', '', stamp(check.checkedAt)); time.dateTime = check.checkedAt;
      info.append(time, el('p', '', check.error || `HTTP ${check.statusCode}`));
      row.append(status, info, el('span', 'mono', latency(check.latencyMs))); checkList.append(row);
    }
    $('checks').replaceChildren(data.checks.length ? checkList : el('p', 'empty compact', 'No checks recorded yet. Use Check now to run one.'));
    message('history-error', ''); $('history-data').hidden = false;
  } catch (error) {
    if (version === state.detailVersion && id === state.selected) message('history-error', `${error.message} History may be out of date. Use Refresh to retry.`);
  } finally { if (version === state.detailVersion) $('history-loading').hidden = true; }
}
function openHistory(monitor) {
  state.selected = monitor.id;
  $('history-content').hidden = false; $('history-placeholder').hidden = true; $('close-history').hidden = false;
  $('history-name').textContent = monitor.name; $('history-url').textContent = monitor.url; $('history-config').textContent = '';
  badge($('history-status'), monitor.status); renderList(); void loadHistory(true);
  $('history-heading').tabIndex = -1; $('history-heading').focus({ preventScroll: true }); $('history').scrollIntoView({ block: 'nearest' });
}
async function checkNow(monitor) {
  if (state.pending.has(monitor.id)) return;
  state.pending.add(monitor.id); renderList(); message('action-error', ''); message('notice', `Checking ${monitor.name}…`);
  try {
    const data = await api(`/api/monitors/${encodeURIComponent(monitor.id)}/check`, { method: 'POST' });
    message('notice', `${monitor.name}: ${labels[data.check.status]}. ${data.check.error || `HTTP ${data.check.statusCode}`} · ${latency(data.check.latencyMs)}.`);
  } catch (error) { message('notice', ''); message('action-error', `Check failed for ${monitor.name}: ${error.message}`); }
  finally { state.pending.delete(monitor.id); renderList(); }
  await refresh();
}
$('monitor-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const monitor = state.monitors.find(m => m.id === button.closest('tr').dataset.id); if (!monitor) return;
  if (button.dataset.action === 'history') openHistory(monitor);
  if (button.dataset.action === 'check') void checkNow(monitor);
  if (button.dataset.action === 'remove') {
    state.deleting = monitor; message('delete-error', ''); $('delete-description').textContent = monitor.name;
    $('delete-dialog').showModal();
  }
});
function openCreate() { message('create-error', ''); $('create-dialog').showModal(); $('name').focus(); }
for (const id of ['add-monitor', 'add-first']) $(id).addEventListener('click', openCreate);
for (const id of ['close-create', 'cancel-create']) $(id).addEventListener('click', () => { if (!state.creating) $('create-dialog').close(); });
$('create-dialog').addEventListener('cancel', event => { if (state.creating) event.preventDefault(); });
$('create-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.creating) return;
  const input = { name: $('name').value.trim(), url: $('url').value.trim(), intervalSeconds: Number($('interval').value), timeoutMs: Number($('timeout').value) };
  if (!input.name) { message('create-error', 'Enter a name containing at least one non-space character.'); $('name').focus(); return; }
  let url;
  try { url = new URL(input.url); } catch { message('create-error', 'Enter a valid HTTP or HTTPS URL.'); $('url').focus(); return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) { message('create-error', 'Use HTTP or HTTPS without credentials or a fragment.'); $('url').focus(); return; }
  state.creating = true; message('create-error', '');
  for (const control of $('create-form').elements) control.disabled = true;
  $('save-monitor').textContent = 'Creating…';
  try {
    const { monitor } = await api('/api/monitors', { method: 'POST', body: JSON.stringify(input) });
    $('create-dialog').close(); $('create-form').reset(); message('action-error', ''); message('notice', `${monitor.name} added. Its first scheduled check will run shortly.`);
    await refresh();
  } catch (error) { message('create-error', error.message); }
  finally { state.creating = false; for (const control of $('create-form').elements) control.disabled = false; $('save-monitor').textContent = 'Create monitor'; }
});
$('cancel-delete').addEventListener('click', () => { if (!state.removing) $('delete-dialog').close(); });
$('delete-dialog').addEventListener('cancel', event => { if (state.removing) event.preventDefault(); });
$('delete-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.removing || !state.deleting) return;
  const monitor = state.deleting; state.removing = true; message('delete-error', '');
  $('confirm-delete').disabled = true; $('cancel-delete').disabled = true; $('confirm-delete').textContent = 'Removing…';
  try {
    await api(`/api/monitors/${encodeURIComponent(monitor.id)}`, { method: 'DELETE' });
    $('delete-dialog').close(); if (state.selected === monitor.id) closeHistory();
    state.monitors = state.monitors.filter(m => m.id !== monitor.id); renderList();
    message('action-error', ''); message('notice', `${monitor.name} and its history removed.`); await refresh(); $('add-monitor').focus();
  } catch (error) { message('delete-error', error.message); }
  finally { state.removing = false; $('confirm-delete').disabled = false; $('cancel-delete').disabled = false; $('confirm-delete').textContent = 'Remove monitor'; }
});
$('close-history').addEventListener('click', () => {
  const id = state.selected; closeHistory();
  [...$('monitor-rows').children].find(row => row.dataset.id === id)?.querySelector('button').focus();
});
$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true; $('refresh').textContent = 'Refreshing…';
  await refresh(); $('refresh').disabled = false; $('refresh').textContent = 'Refresh';
});
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
