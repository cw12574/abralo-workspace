import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createMonitorServer } from '../server.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
async function until(predicate, message, timeout = 3000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await predicate()) return; await delay(10); }
  assert.fail(message);
}
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(ROOT, '.fixture-'));
  const dataFile = join(dir, 'state.json');
  const services = []; const fixtures = [];
  t.after(async () => {
    for (const s of services) await s.shutdown();
    for (const s of fixtures) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
    // dir is created beneath tests/ by mkdtemp and never derived from request input.
    await rm(dir, { recursive: true, force: true });
  });
  async function start(extra = {}) {
    const server = await createMonitorServer({ dataFile, scheduler: false, ...options, ...extra });
    assert.equal(server.listening, false, 'factory returns an unbound server');
    services.push(server);
    const base = await listen(server);
    const api = async (path = '/api/monitors', method = 'GET', body) => {
      const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
    };
    return { server, base, api };
  }
  const service = await start();
  return { ...service, dataFile, dir, start, async fixture(handler) {
    const server = http.createServer(handler); fixtures.push(server); return { server, url: await listen(server) };
  } };
}
async function create(ctx, url, extra = {}) {
  const result = await ctx.api('/api/monitors', 'POST', { name: ' Test endpoint ', url, ...extra });
  assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.monitor;
}
const detail = (ctx, id) => ctx.api(`/api/monitors/${id}`);
const check = (ctx, id) => ctx.api(`/api/monitors/${id}/check`, 'POST');
async function raw(base, body, headers = {}, chunked = false) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/api/monitors', { method: 'POST', headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('test request timeout'))); req.on('error', reject);
    if (chunked) { req.write(body.slice(0, 4000)); req.write(body.slice(4000)); req.end(); }
    else req.end(body);
  });
}

test('CRUD defaults, normalization, JSON errors, and persisted deletion', async t => {
  const ctx = await setup(t); const fixture = await ctx.fixture((req, res) => res.end('ok'));
  assert.deepEqual((await ctx.api('/api/health')).body, { status: 'ok' });
  assert.deepEqual((await ctx.api()).body, { monitors: [] });
  const m = await create(ctx, fixture.url);
  assert.equal(m.name, 'Test endpoint'); assert.equal(m.url, fixture.url + '/');
  assert.equal(m.intervalSeconds, 60); assert.equal(m.timeoutMs, 5000);
  assert.equal(m.status, 'unknown'); assert.equal(m.checkCount, 0);
  for (const key of ['lastCheckedAt', 'latencyMs', 'statusCode', 'error', 'uptimePercent', 'activeIncident']) assert.equal(m[key], null);
  assert.equal((await ctx.api()).body.monitors[0].id, m.id);
  assert.deepEqual((await detail(ctx, m.id)).body.checks, []);
  for (const [path, method, code] of [['/api/missing','GET',404], ['/api/monitors/missing','GET',404], ['/api/monitors/missing','DELETE',404], ['/api/monitors/missing/check','POST',404], ['/api/monitors','PATCH',405], [`/api/monitors/${m.id}/check`,'GET',405], [`/api/monitors/${m.id}`,'PUT',405]]) {
    const r = await ctx.api(path, method); assert.equal(r.status, code); assert.equal(typeof r.body.error, 'string');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  const removed = await ctx.api(`/api/monitors/${m.id}`, 'DELETE'); assert.equal(removed.status, 204); assert.equal(removed.body, null);
  await ctx.server.shutdown(); const restarted = await ctx.start();
  assert.deepEqual((await restarted.api()).body, { monitors: [] });
});

test('validation rejects invalid shapes, URLs, fields and numeric boundaries without mutation', async t => {
  const ctx = await setup(t); const valid = { name: 'A', url: 'http://127.0.0.1:1' };
  const invalid = [null, [], 'text', {}, {...valid, extra: 1}, ...['', '  ', 'a'.repeat(101), 7].map(name => ({...valid,name})),
    ...['bad','ftp://127.0.0.1','http://user:pass@127.0.0.1','http://127.0.0.1/#fragment','http://127.0.0.1/'+'a'.repeat(2048),null].map(url => ({...valid,url})),
    ...[9,86401,10.5,'60',null].map(intervalSeconds => ({...valid,intervalSeconds})),
    ...[99,30001,100.5,'100',null].map(timeoutMs => ({...valid,timeoutMs}))];
  for (const body of invalid) { const r = await ctx.api('/api/monitors','POST',body); assert.equal(r.status,400,JSON.stringify(body)); assert.equal(typeof r.body.error,'string'); }
  assert.deepEqual((await ctx.api()).body.monitors, []);
  await create(ctx, valid.url, {name:'x'.repeat(100),intervalSeconds:10,timeoutMs:100});
  await create(ctx, valid.url, {intervalSeconds:86400,timeoutMs:30000});
});

test('JSON parser rejects malformed/content-type errors and enforces byte limit with length or chunking', async t => {
  const ctx = await setup(t);
  for (const body of ['', '{oops']) assert.equal((await raw(ctx.base,body,{'Content-Type':'application/json'})).status,400);
  assert.equal((await raw(ctx.base,'{}',{'Content-Type':'text/plain'})).status,415);
  const json = JSON.stringify({name:'bounded',url:'http://127.0.0.1:1'});
  const exact = json.padEnd(8192, ' ');
  assert.equal((await raw(ctx.base,exact,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(exact)})).status,201);
  for (const chunked of [false,true]) {
    const over = exact + ' ';
    const r = await raw(ctx.base,over,{'Content-Type':'application/json',...(chunked?{}:{'Content-Length':Buffer.byteLength(over)})},chunked);
    assert.equal(r.status,413); assert.match(r.body.error,/8192/);
  }
  const unicode = JSON.stringify({name:'é'.repeat(4100),url:'http://127.0.0.1:1'});
  assert.ok(unicode.length < 8192); assert.equal((await raw(ctx.base,unicode,{'Content-Type':'application/json'},true)).status,413);
});

test('JSON content type accepts parameters but rejects a different media type with a matching prefix', async t => {
  const ctx=await setup(t); const body=JSON.stringify({name:'media type',url:'http://127.0.0.1:1'});
  assert.equal((await raw(ctx.base,body,{'Content-Type':'Application/JSON; charset=utf-8'})).status,201);
  const response=await raw(ctx.base,body,{'Content-Type':'application/jsonp'});
  assert.equal(response.status,415,'application/jsonp is not the documented application/json media type');
});

test('HTTP status boundaries 200 through 399 are up; 400 and above are down', async t => {
  const ctx=await setup(t); let code=200;
  const fixture=await ctx.fixture((req,res)=>{res.writeHead(code);res.end();}); const m=await create(ctx,fixture.url);
  for (const status of [200,299,300,399,400,599]) {
    code=status; const r=await check(ctx,m.id); assert.equal(r.status,200); assert.equal(r.body.check.statusCode,status);
    assert.equal(r.body.check.status,status<400?'up':'down');
  }
});

test('real HTTP checks classify status, group failures, recover, order history and survive restart', async t => {
  const ctx = await setup(t); let status = 503;
  const fixture = await ctx.fixture((req,res) => { res.writeHead(status); res.end(); });
  const m = await create(ctx,fixture.url); const results = [];
  for (const code of [503,500,204,404]) { status=code; const r=await check(ctx,m.id); assert.equal(r.status,200); results.push(r.body); await delay(5); }
  assert.equal(results[0].check.error,'HTTP 503'); assert.equal(results[1].monitor.activeIncident.failureCount,2);
  assert.equal(results[1].monitor.activeIncident.id,results[0].monitor.activeIncident.id);
  assert.equal(results[2].check.status,'up'); assert.equal(results[2].monitor.activeIncident,null);
  assert.equal(results[2].monitor.uptimePercent,33.33); assert.equal(results[3].monitor.uptimePercent,25);
  const before=(await detail(ctx,m.id)).body;
  assert.deepEqual(before.checks.map(c=>c.statusCode),[404,204,500,503]); assert.equal(before.incidents.length,2);
  assert.equal(before.incidents[0].resolvedAt,null); assert.equal(before.incidents[1].failureCount,2);
  assert.equal(before.incidents[1].resolvedAt,results[2].check.checkedAt);
  assert.equal(before.incidents[1].durationMs,Date.parse(results[2].check.checkedAt)-Date.parse(results[0].check.checkedAt));
  assert.equal(before.incidents[1].lastError,'HTTP 500');
  const disk=JSON.parse(await readFile(ctx.dataFile,'utf8')); assert.equal(disk.monitors[0].checks.length,4);
  await ctx.server.shutdown(); const restarted=await ctx.start();
  assert.deepEqual((await detail(restarted,m.id)).body,before);
  status=200; const recovered=await check(restarted,m.id); assert.equal(recovered.body.monitor.activeIncident,null);
});

test('redirects count as up without following and streaming bodies are cancelled', async t => {
  const ctx=await setup(t); let followed=0; let closed=false;
  const fixture=await ctx.fixture((req,res)=> {
    if(req.url==='/redirect') {res.writeHead(302,{Location:'/destination'});res.end();}
    else if(req.url==='/destination') {followed++;res.end();}
    else {res.writeHead(200);res.write('stream begins');res.on('close',()=>{closed=true;});}
  });
  const redirect=await create(ctx,fixture.url+'/redirect'); const r=await check(ctx,redirect.id);
  assert.equal(r.body.check.status,'up'); assert.equal(r.body.check.statusCode,302); assert.equal(followed,0);
  const stream=await create(ctx,fixture.url+'/stream'); assert.equal((await check(ctx,stream.id)).body.check.status,'up');
  await until(()=>closed,'upstream streaming response should be closed after headers');
});

test('unresponsive endpoint times out within a bound and connection failure becomes a down check', async t => {
  const ctx=await setup(t); const hanging=await ctx.fixture(()=>{});
  const m=await create(ctx,hanging.url,{timeoutMs:100}); const start=performance.now(); const r=await check(ctx,m.id); const elapsed=performance.now()-start;
  assert.equal(r.status,200); assert.equal(r.body.check.status,'down'); assert.equal(r.body.check.statusCode,null); assert.match(r.body.check.error,/timed out/);
  assert.ok(elapsed>=75 && elapsed<2000,`100 ms timeout took ${elapsed} ms`);
  const closed=await ctx.fixture((req,res)=>res.end()); const address=closed.url; await new Promise(resolve=>closed.server.close(resolve));
  const unavailable=await create(ctx,address,{timeoutMs:100}); const failure=await check(ctx,unavailable.id);
  assert.equal(failure.body.check.status,'down'); assert.match(failure.body.check.error,/Request failed/);
});

test('overlapping manual checks share one request and one persisted result', async t => {
  const ctx=await setup(t); let hits=0; let release;
  const fixture=await ctx.fixture((req,res)=>{hits++;release=()=>res.end('ok');}); const m=await create(ctx,fixture.url);
  const requests=Array.from({length:8},()=>check(ctx,m.id));
  await until(()=>hits===1,'fixture was not reached'); await delay(100); assert.equal(hits,1); release();
  const results=await Promise.all(requests); assert.ok(results.every(r=>r.status===200));
  assert.equal(new Set(results.map(r=>r.body.check.id)).size,1); assert.equal((await detail(ctx,m.id)).body.checks.length,1);
});

test('delete during a pending check returns 404 and cannot resurrect history', async t => {
  const ctx=await setup(t); let release;
  const fixture=await ctx.fixture((req,res)=>{release=()=>res.end();}); const m=await create(ctx,fixture.url);
  const pending=check(ctx,m.id); await until(()=>release,'fixture was not reached');
  assert.equal((await ctx.api(`/api/monitors/${m.id}`,'DELETE')).status,204); release();
  assert.equal((await pending).status,404); assert.deepEqual((await ctx.api()).body.monitors,[]);
  assert.deepEqual(JSON.parse(await readFile(ctx.dataFile,'utf8')).monitors,[]);
});

test('scheduler checks new/due monitors, shares manual work and leaves recent checks alone', async t => {
  const ctx=await setup(t,{scheduler:true,schedulerIntervalMs:20}); let hits=0; let release;
  const fixture=await ctx.fixture((req,res)=>{hits++;release=()=>res.end();}); const m=await create(ctx,fixture.url,{intervalSeconds:10});
  await until(()=>hits===1,'scheduler did not run initial check'); const manual=check(ctx,m.id);
  await delay(100); assert.equal(hits,1); release(); assert.equal((await manual).status,200);
  await delay(100); assert.equal(hits,1); assert.equal((await detail(ctx,m.id)).body.checks.length,1);
  await ctx.server.shutdown(); const stored=JSON.parse(await readFile(ctx.dataFile,'utf8'));
  stored.monitors[0].checks[0].checkedAt=new Date(Date.now()-11000).toISOString(); await writeFile(ctx.dataFile,JSON.stringify(stored));
  const restarted=await ctx.start(); await until(()=>hits===2,'scheduler did not check overdue persisted monitor'); release();
  await until(async()=>(await detail(restarted,m.id)).body.checks.length===2,'scheduled result was not persisted');
});

test('retention evicts oldest checks/incidents and uptime uses only retained checks', async t => {
  const ctx=await setup(t); const fixture=await ctx.fixture((req,res)=>{res.writeHead(503);res.end();}); const m=await create(ctx,fixture.url);
  await ctx.server.shutdown(); const stored=JSON.parse(await readFile(ctx.dataFile,'utf8')); const monitor=stored.monitors[0];
  // Seed the documented on-disk boundary, then cross it through a real HTTP check.
  monitor.checks=Array.from({length:1000},(_,i)=>({id:`old-${i}`,checkedAt:new Date(1700000000000+i*1000).toISOString(),status:i<500?'up':'down',statusCode:i<500?200:503,latencyMs:1,error:i<500?null:'HTTP 503'}));
  monitor.incidents=Array.from({length:100},(_,i)=>({id:`incident-${i}`,monitorId:m.id,startedAt:new Date(1700000000000+i*2000).toISOString(),resolvedAt:new Date(1700000001000+i*2000).toISOString(),durationMs:1000,failureCount:1,lastError:'HTTP 503'}));
  await writeFile(ctx.dataFile,JSON.stringify(stored)); const restarted=await ctx.start(); const r=await check(restarted,m.id);
  assert.equal(r.body.monitor.checkCount,1000); assert.equal(r.body.monitor.uptimePercent,49.9);
  const history=(await detail(restarted,m.id)).body; assert.equal(history.checks.length,1000); assert.equal(history.incidents.length,100);
  assert.equal(history.checks.at(-1).id,'old-1'); assert.equal(history.incidents.at(-1).id,'incident-1');
  assert.equal(history.incidents[0].resolvedAt,null); assert.equal(history.incidents[0].failureCount,1);
  const disk=JSON.parse(await readFile(ctx.dataFile,'utf8')).monitors[0]; assert.equal(disk.checks.length,1000); assert.equal(disk.incidents.length,100);
});

test('500-monitor cap returns 409 without mutation', async t => {
  const ctx=await setup(t); const m=await create(ctx,'http://127.0.0.1:1'); await ctx.server.shutdown();
  const stored=JSON.parse(await readFile(ctx.dataFile,'utf8')); const seed=stored.monitors[0];
  stored.monitors=Array.from({length:500},(_,i)=>({...seed,id:`monitor-${i}`})); await writeFile(ctx.dataFile,JSON.stringify(stored));
  const restarted=await ctx.start(); const r=await restarted.api('/api/monitors','POST',{name:'overflow',url:m.url});
  assert.equal(r.status,409); assert.match(r.body.error,/500/); assert.equal((await restarted.api()).body.monitors.length,500);
});

test('invalid persisted JSON refuses startup without overwriting and invalid options reject', async t => {
  const ctx=await setup(t); await ctx.server.shutdown(); await writeFile(ctx.dataFile,'{broken');
  await assert.rejects(()=>createMonitorServer({dataFile:ctx.dataFile,scheduler:false}),/Cannot load monitor data/);
  assert.equal(await readFile(ctx.dataFile,'utf8'),'{broken');
  for (const options of [{scheduler:'yes'},{schedulerIntervalMs:9},{schedulerIntervalMs:10.5}]) await assert.rejects(()=>createMonitorServer({dataFile:ctx.dataFile,...options}),/Invalid scheduler options/);
});

test('persistence failure produces useful 500 and rolls back in-memory mutation', async t => {
  const ctx=await setup(t);
  // A directory at the temporary file path forces a portable write failure.
  await mkdir(ctx.dataFile+'.tmp');
  const r=await ctx.api('/api/monitors','POST',{name:'cannot save',url:'http://127.0.0.1:1'});
  assert.equal(r.status,500); assert.match(r.body.error,/Internal error.*data-file permissions/); assert.deepEqual((await ctx.api()).body.monitors,[]);
});

test('shutdown aborts an active check with 503 and does not persist a cancelled check', async t => {
  const ctx=await setup(t); let reached=false; const fixture=await ctx.fixture(()=>{reached=true;}); const m=await create(ctx,fixture.url);
  const pending=check(ctx,m.id); await until(()=>reached,'fixture was not reached'); const shutdown=ctx.server.shutdown();
  const r=await pending; assert.equal(r.status,503); await shutdown;
  assert.equal(JSON.parse(await readFile(ctx.dataFile,'utf8')).monitors[0].checks.length,0);
});

test('only allowlisted assets are served with same-origin CSP, correct types and HEAD behavior', async t => {
  const ctx=await setup(t);
  for (const [path,type] of [['/','text/html'],['/index.html','text/html'],['/app.js','text/javascript'],['/styles.css','text/css'],['/favicon.svg','image/svg+xml']]) {
    const r=await fetch(ctx.base+path); assert.equal(r.status,200); assert.ok(r.headers.get('content-type').startsWith(type));
    const csp=r.headers.get('content-security-policy'); for(const directive of ["default-src 'self'","script-src 'self'","style-src 'self'","connect-src 'self'","frame-ancestors 'none'","base-uri 'none'"]) assert.ok(csp.includes(directive));
    assert.equal(r.headers.get('x-content-type-options'),'nosniff'); const body=await r.text(); assert.ok(body.length>0);
    const head=await fetch(ctx.base+path,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),''); assert.equal(head.headers.get('content-length'),r.headers.get('content-length'));
  }
  for (const path of ['/server.mjs','/API.md','/BRIEF.md','/data/beacon.json','/.git/config','/public/app.js','/%2e%2e/server.mjs','/favicon.ico']) {const r=await ctx.api(path);assert.equal(r.status,404,path);assert.equal(typeof r.body.error,'string');}
  assert.equal((await ctx.api('/app.js','POST')).status,405);
});
