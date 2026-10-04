import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 8192;
const CHECK_LIMIT = 1000;
const INCIDENT_LIMIT = 100;
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Expected a JSON object.');
  if (Object.keys(input).some(key => !['name', 'url', 'intervalSeconds', 'timeoutMs'].includes(key))) throw new ApiError(400, 'Unknown monitor field.');
  const { name, url, intervalSeconds = 60, timeoutMs = 5000 } = input;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new ApiError(400, 'Name must contain 1–100 characters.');
  if (typeof url !== 'string' || url.length > 2048) throw new ApiError(400, 'URL must be an HTTP or HTTPS URL up to 2048 characters.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new ApiError(400, 'Invalid URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new ApiError(400, 'Use HTTP or HTTPS without credentials or a fragment.');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 86400) throw new ApiError(400, 'intervalSeconds must be an integer from 10 to 86400.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new ApiError(400, 'timeoutMs must be an integer from 100 to 30000.');
  return { name: name.trim(), url: parsed.href, intervalSeconds, timeoutMs };
}
async function readJson(req) {
  const mediaType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw new ApiError(415, 'Content-Type must be application/json.');
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw new ApiError(413, 'JSON body exceeds 8192 bytes.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'JSON body exceeds 8192 bytes.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Malformed JSON.'); }
}
function summary(monitor) {
  const last = monitor.checks.at(-1);
  return {
    id: monitor.id, name: monitor.name, url: monitor.url,
    intervalSeconds: monitor.intervalSeconds, timeoutMs: monitor.timeoutMs,
    createdAt: monitor.createdAt, status: last?.status ?? 'unknown',
    lastCheckedAt: last?.checkedAt ?? null, latencyMs: last?.latencyMs ?? null,
    statusCode: last?.statusCode ?? null, error: last?.error ?? null,
    uptimePercent: monitor.checks.length ? Math.round(monitor.checks.filter(c => c.status === 'up').length / monitor.checks.length * 10000) / 100 : null,
    checkCount: monitor.checks.length,
    activeIncident: monitor.incidents.find(i => i.resolvedAt === null) ?? null,
  };
}

/** Returns an unbound http.Server. Importing this module never listens. */
export async function createMonitorServer(options = {}) {
  const dataFile = resolve(options.dataFile ?? join(ROOT, 'data', 'beacon.json'));
  const scheduler = options.scheduler ?? true;
  const schedulerIntervalMs = options.schedulerIntervalMs ?? 1000;
  if (typeof scheduler !== 'boolean' || !Number.isInteger(schedulerIntervalMs) || schedulerIntervalMs < 10) throw new Error('Invalid scheduler options.');
  let state = { version: 1, monitors: [] };
  try {
    state = JSON.parse(await readFile(dataFile, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.monitors) || state.monitors.length > 500) throw new Error('Invalid data format.');
    const ids = new Set();
    for (const m of state.monitors) {
      validateInput({ name: m.name, url: m.url, intervalSeconds: m.intervalSeconds, timeoutMs: m.timeoutMs });
      if (typeof m.id !== 'string' || ids.has(m.id) || !Array.isArray(m.checks) || !Array.isArray(m.incidents) || m.checks.length > CHECK_LIMIT || m.incidents.length > INCIDENT_LIMIT) throw new Error('Invalid stored monitor.');
      ids.add(m.id);
      if (m.checks.some(c => !c || !['up', 'down'].includes(c.status) || !Number.isFinite(Date.parse(c.checkedAt)))) throw new Error('Invalid stored check.');
      if (m.incidents.some(i => !i || !Number.isFinite(Date.parse(i.startedAt)) || (i.resolvedAt !== null && !Number.isFinite(Date.parse(i.resolvedAt))))) throw new Error('Invalid stored incident.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot load monitor data: ${error.message}`, { cause: error });
  }
  let writes = Promise.resolve();
  function mutate(fn) {
    const work = writes.then(async () => {
      const next = structuredClone(state);
      const result = fn(next);
      await mkdir(dirname(dataFile), { recursive: true });
      const temporary = `${dataFile}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, dataFile);
      state = next;
      return result;
    });
    writes = work.catch(() => {});
    return work;
  }
  const inFlight = new Map();
  const controllers = new Set();
  let stopping = false;
  let timer;
  function find(id, source = state) {
    const monitor = source.monitors.find(m => m.id === id);
    if (!monitor) throw new ApiError(404, 'Monitor not found.');
    return monitor;
  }
  function runCheck(id) {
    if (stopping) return Promise.reject(new ApiError(503, 'Service is shutting down.'));
    if (inFlight.has(id)) return inFlight.get(id);
    const monitor = find(id);
    const work = (async () => {
      const controller = new AbortController();
      controllers.add(controller);
      const started = performance.now();
      const timeout = setTimeout(() => controller.abort(new Error('Request timed out.')), monitor.timeoutMs);
      let statusCode = null;
      let error = null;
      try {
        const response = await fetch(monitor.url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'Beacon-local/1.0' } });
        statusCode = response.status;
        // Never buffer a potentially unbounded endpoint response.
        if (response.body) void response.body.cancel().catch(() => {});
        if (statusCode < 200 || statusCode > 399) error = `HTTP ${statusCode}`;
      } catch (cause) {
        error = controller.signal.aborted ? 'Request timed out or was cancelled.' : `Request failed: ${cause.cause?.code ?? cause.message}`.slice(0, 300);
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
      if (stopping) throw new ApiError(503, 'Service is shutting down.');
      const check = { id: randomUUID(), checkedAt: new Date().toISOString(), status: error ? 'down' : 'up', statusCode, latencyMs: Math.round(performance.now() - started), error };
      return mutate(next => {
        const m = find(id, next);
        m.checks.push(check);
        m.checks = m.checks.slice(-CHECK_LIMIT);
        const active = m.incidents.find(i => i.resolvedAt === null);
        if (check.status === 'down') {
          if (active) { active.failureCount++; active.lastError = error; }
          else m.incidents.push({ id: randomUUID(), monitorId: id, startedAt: check.checkedAt, resolvedAt: null, durationMs: null, failureCount: 1, lastError: error });
        } else if (active) {
          active.resolvedAt = check.checkedAt;
          active.durationMs = Math.max(0, Date.parse(check.checkedAt) - Date.parse(active.startedAt));
        }
        m.incidents = m.incidents.slice(-INCIDENT_LIMIT);
        return { monitor: summary(m), check };
      });
    })();
    inFlight.set(id, work);
    void work.finally(() => inFlight.delete(id)).catch(() => {});
    return work;
  }
  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
      if (pathname === '/api/monitors') {
        if (req.method === 'GET') return json(res, 200, { monitors: state.monitors.map(summary) });
        if (req.method === 'POST') {
          const input = validateInput(await readJson(req));
          const monitor = await mutate(next => {
            if (next.monitors.length >= 500) throw new ApiError(409, 'Maximum of 500 monitors reached.');
            const m = { id: randomUUID(), ...input, createdAt: new Date().toISOString(), checks: [], incidents: [] };
            next.monitors.push(m);
            return summary(m);
          });
          return json(res, 201, { monitor });
        }
        throw new ApiError(405, 'Method not allowed.');
      }
      const match = /^\/api\/monitors\/([a-zA-Z0-9-]+)(\/check)?$/.exec(pathname);
      if (match) {
        const [, id, checkPath] = match;
        if (checkPath && req.method === 'POST') return json(res, 200, await runCheck(id));
        if (!checkPath && req.method === 'GET') {
          const m = find(id);
          return json(res, 200, { monitor: summary(m), checks: [...m.checks].reverse(), incidents: [...m.incidents].reverse() });
        }
        if (!checkPath && req.method === 'DELETE') {
          await mutate(next => { find(id, next); next.monitors = next.monitors.filter(m => m.id !== id); });
          return json(res, 204);
        }
        throw new ApiError(405, 'Method not allowed.');
      }
      if (pathname.startsWith('/api/')) throw new ApiError(404, 'API route not found.');
      const asset = STATIC.get(pathname);
      if (!asset) throw new ApiError(404, 'File not found.');
      if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'Method not allowed.');
      let bytes;
      try { bytes = await readFile(join(ROOT, 'public', asset[0])); }
      catch (error) { if (error.code === 'ENOENT') throw new ApiError(404, 'Dashboard asset not available.'); throw error; }
      res.writeHead(200, { 'content-type': asset[1], 'content-length': bytes.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      req.resume();
      if (!error.status) console.error('Beacon request failed:', error.message);
      if (!res.headersSent && !res.destroyed) json(res, error.status ?? 500, { error: error.status ? error.message : 'Internal error. Check server logs and data-file permissions.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 35000;
  server.on('listening', () => {
    if (!scheduler) return;
    timer = setInterval(() => {
      for (const m of state.monitors) {
        const last = m.checks.at(-1);
        if (!last || Date.now() - Date.parse(last.checkedAt) >= m.intervalSeconds * 1000) {
          void runCheck(m.id).catch(error => { if (error.status !== 404 && !stopping) console.error('Scheduled check failed:', error.message); });
        }
      }
    }, schedulerIntervalMs);
    timer.unref();
  });
  function stop() {
    stopping = true;
    clearInterval(timer);
    for (const controller of controllers) controller.abort();
  }
  const close = server.close.bind(server);
  server.close = function (callback) { stop(); return close(callback); };
  server.shutdown = async function () {
    stop();
    await Promise.allSettled([...inFlight.values()]);
    await writes;
    if (server.listening) await new Promise((resolveClose, reject) => close(error => error ? reject(error) : resolveClose()));
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
    const server = await createMonitorServer({ dataFile: process.env.DATA_FILE });
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Beacon listening on http://${process.env.HOST ?? '127.0.0.1'}:${server.address().port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.shutdown().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
