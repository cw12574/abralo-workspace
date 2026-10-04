import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCity } from '../city-engine.mjs';
import { drawCity, bridgeHitTest } from '../city-view.mjs';

const ids = ['north', 'central', 'south'];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
function run(city, seconds, dt = .05) {
  for (let i = 0; i < Math.round(seconds / dt); i++) city.step(dt);
  return city.snapshot();
}
function invariant(s, previous) {
  const nodes = new Map(s.nodes.map(n => [n.id, n]));
  const edges = new Map(s.edges.map(e => [e.id, e]));
  assert.ok(Number.isFinite(s.time));
  assert.equal(s.stats.active, s.cars.length);
  assert.ok(s.cars.length <= 120);
  assert.equal(new Set(s.cars.map(c => c.id)).size, s.cars.length);
  assert.equal(s.stats.spawned, s.stats.arrived + s.stats.active);
  assert.equal(s.stats.waiting, s.cars.filter(c => c.waiting).length);
  for (const v of Object.values(s.stats)) assert.ok(Number.isSafeInteger(v) && v >= 0);
  assert.ok(s.stats.rerouted >= s.cars.reduce((n, c) => n + c.reroutes, 0));
  for (const edge of s.edges) {
    assert.equal(edge.closed, edge.bridge ? !s.bridges.find(b => b.id === edge.bridge).open : false);
  }
  const old = new Map(previous?.cars.map(c => [c.id, c]) ?? []);
  let routeChanges = 0, admissions = new Set();
  for (const c of s.cars) {
    const e = edges.get(c.edgeId), a = nodes.get(e.from), b = nodes.get(e.to);
    for (const k of ['x', 'y', 'angle', 'progress']) assert.ok(Number.isFinite(c[k]));
    assert.ok(c.x >= 0 && c.x <= 1100 && c.y >= 0 && c.y <= 640);
    assert.ok(c.progress >= 0 && c.progress <= e.length);
    assert.ok(Number.isSafeInteger(c.reroutes) && c.reroutes >= 0);
    assert.equal(typeof c.waiting, 'boolean');
    assert.ok([80, 1020].includes(nodes.get(c.origin).x));
    assert.equal(nodes.get(c.origin).x + nodes.get(c.target).x, 1100);
    const dx = (b.x - a.x) / e.length, dy = (b.y - a.y) / e.length;
    near(c.x, a.x + dx * c.progress - dy * 5);
    near(c.y, a.y + dy * c.progress + dx * 5);
    near(c.angle, Math.atan2(dy, dx));
    let node = e.to;
    for (const id of c.route) {
      const next = edges.get(id);
      assert.ok(next); assert.equal(next.from, node); node = next.to;
    }
    assert.equal(node, c.target);
    if (!previous) continue;
    const p = old.get(c.id);
    routeChanges += c.reroutes - (p?.reroutes ?? 0);
    if (p) {
      assert.ok(c.reroutes >= p.reroutes);
      if (p.edgeId === c.edgeId) {
        assert.ok(c.progress >= p.progress);
        assert.ok(c.progress - p.progress <= 2.4 + 1e-7);
      } else {
        const oldEdge = edges.get(p.edgeId);
        near(p.progress, oldEdge.length);
        assert.equal(oldEdge.to, e.from);
        assert.ok(c.progress <= 2.4 + 1e-7);
      }
    }
    if (!p || p.edgeId !== c.edgeId) {
      assert.equal(e.closed, false, 'no new entry onto a closed bridge');
      assert.ok(!admissions.has(e.from), 'at most one admission per node per tick');
      admissions.add(e.from);
    }
  }
  for (const e of s.edges) {
    const lane = s.cars.filter(c => c.edgeId === e.id).sort((a, b) => a.progress - b.progress);
    for (let i = 1; i < lane.length; i++) assert.ok(lane[i].progress - lane[i - 1].progress >= 18 - 1e-7);
  }
  if (previous) {
    for (const key of ['arrived', 'spawned', 'rerouted']) assert.ok(s.stats[key] >= previous.stats[key]);
    assert.equal(s.stats.rerouted - previous.stats.rerouted, routeChanges);
    const disappeared = previous.cars.filter(c => !s.cars.some(n => n.id === c.id));
    assert.equal(s.stats.arrived - previous.stats.arrived, disappeared.length);
    for (const c of disappeared) {
      const e = edges.get(c.edgeId); assert.equal(e.to, c.target); near(c.progress, e.length);
    }
  }
}

test('world topology, bridge IDs and bidirectional geometry match the contract', () => {
  const s = createCity().snapshot();
  assert.equal(s.nodes.length, 18); assert.equal(s.edges.length, 54);
  assert.deepEqual(s.bridges, [
    { id: 'north', name: 'Willow bridge', y: 130, open: true },
    { id: 'central', name: 'Market bridge', y: 320, open: true },
    { id: 'south', name: 'Foundry bridge', y: 510, open: true },
  ]);
  const nodes = new Map(s.nodes.map(n => [n.id, n]));
  assert.equal(nodes.size, 18); assert.equal(new Set(s.edges.map(e => e.id)).size, 54);
  s.nodes.forEach(n => { assert.ok([80,260,440,660,840,1020].includes(n.x)); assert.ok([130,320,510].includes(n.y)); });
  for (const e of s.edges) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    assert.ok(a.x === b.x || a.y === b.y);
    near(e.length, Math.hypot(a.x - b.x, a.y - b.y));
    const reverse = s.edges.find(r => r.from === e.to && r.to === e.from);
    assert.ok(reverse); assert.equal(reverse.bridge, e.bridge);
    if (e.bridge) { assert.deepEqual([a.x,b.x].sort((x,y) => x-y), [440,660]); assert.equal(a.y,b.y); }
  }
});

test('seed replay, instance independence, reset and frame chunking with commands', () => {
  for (const seed of [0, 20261005, 0xffffffff]) {
    const cities = [.05, .1, .25, 1/60].map(() => createCity({seed}));
    const initial = cities[0].snapshot();
    const replay = city => {
      run(city, 10); city.setDemand('busy'); city.setBridgeOpen('central', false);
      run(city, 20); city.setBridgeOpen('central', true); run(city, 10);
    };
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i], dt = [.05,.1,.25,1/60][i];
      run(city, 10, dt); city.setDemand('busy'); city.setBridgeOpen('central', false);
      run(city, 20, dt); city.setBridgeOpen('central', true); run(city, 10, dt);
    }
    cities.forEach(c => assert.deepEqual(c.snapshot(), cities[0].snapshot()));
    const final = cities[0].snapshot();
    cities[0].step(.013); cities[0].setBridgeOpen('north', false);
    assert.deepEqual(cities[1].snapshot(), final);
    assert.equal(cities[0].reset(), undefined); assert.deepEqual(cities[0].snapshot(), initial);
    replay(cities[0]); assert.deepEqual(cities[0].snapshot(), final);
  }
  assert.notDeepEqual(run(createCity({seed:1}), 10).cars, run(createCity({seed:2}), 10).cars);
});

test('input errors are clear and atomic; fractional stepping and clamp are respected', () => {
  for (const seed of [-1, 1.5, 2**32, NaN, Infinity, '1', null]) assert.throws(() => createCity({seed}), TypeError);
  const city = createCity(); run(city, 4); city.step(.02);
  const before = city.snapshot();
  for (const value of [-1, NaN, Infinity, -Infinity, '1', null, undefined, {}, true]) {
    assert.throws(() => city.step(value), TypeError); assert.deepEqual(city.snapshot(), before);
  }
  for (const value of ['missing', '', null, undefined, 1]) assert.throws(() => city.setBridgeOpen(value, true), RangeError);
  for (const value of [0, 1, 'true', null, undefined, {}]) assert.throws(() => city.setBridgeOpen('north', value), TypeError);
  for (const value of ['fast', '', null, 1, undefined]) assert.throws(() => city.setDemand(value), RangeError);
  assert.deepEqual(city.snapshot(), before);
  assert.equal(city.step(0), undefined); city.step(.03); near(city.snapshot().time, before.time + .05);
  const a = createCity(), b = createCity(); a.step(1000); b.step(.25); assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.setDemand('busy'), undefined); assert.equal(a.setBridgeOpen('north', false), undefined);
});

test('snapshots deeply isolate mutable engine data', () => {
  const city = createCity(); run(city, 10); const baseline = city.snapshot(), edited = city.snapshot();
  edited.nodes[0].x = -100; edited.edges[0].closed = true; edited.bridges[0].open = false;
  edited.cars[0].route.push('bad'); edited.cars[0].x = Infinity; edited.stats.spawned = -2;
  edited.nodes.push({}); edited.cars.length = 0; edited.demand = 'bad';
  assert.deepEqual(city.snapshot(), baseline);
});

test('busy demand increases admitted trips; initial plans are shortest open paths', () => {
  const calm = run(createCity(), 60), busyCity = createCity(); busyCity.setDemand('busy');
  assert.ok(run(busyCity, 60).stats.spawned > calm.stats.spawned);
  const city = createCity(); city.setBridgeOpen('central', false); city.setDemand('busy');
  const seen = new Set();
  for (let i = 0; i < 1200; i++) {
    city.step(.05); const s = city.snapshot(), edges = new Map(s.edges.map(e => [e.id,e]));
    for (const c of s.cars) if (!seen.has(c.id)) {
      seen.add(c.id);
      // Independent Bellman-Ford distance oracle, not the engine's Dijkstra traversal.
      const distance = new Map(s.nodes.map(n => [n.id, Infinity])); distance.set(c.origin, 0);
      for (let pass = 0; pass < s.nodes.length - 1; pass++) for (const e of s.edges) {
        if (!e.closed) distance.set(e.to, Math.min(distance.get(e.to), distance.get(e.from) + e.length));
      }
      const path = [c.edgeId, ...c.route].map(id => edges.get(id));
      assert.ok(path.every(e => !e.closed)); near(path.reduce((n,e) => n+e.length,0), distance.get(c.target));
    }
  }
  assert.ok(seen.size > 20);
});

test('each bridge drains incumbent cars, rejects entries and induces real reroutes', () => {
  for (const id of ids) {
    const city = createCity(); city.setDemand('busy');
    let s = run(city, 30), occupants;
    for (let i = 0; i < 1200; i++) {
      const bridgeEdges = new Set(s.edges.filter(e => e.bridge === id).map(e => e.id));
      occupants = s.cars.filter(c => bridgeEdges.has(c.edgeId));
      if (occupants.length) break;
      city.step(.05); s = city.snapshot();
    }
    assert.ok(occupants.length, `exercise occupied ${id}`);
    const beforeRerouted = s.stats.rerouted;
    city.setBridgeOpen(id, false);
    assert.ok(city.snapshot().edges.filter(e => e.bridge === id).every(e => e.closed));
    for (let i = 0; i < 1200; i++) { city.step(.05); const n = city.snapshot(); invariant(n,s); s=n; }
    assert.ok(s.stats.rerouted > beforeRerouted);
    assert.ok(occupants.every(c => !s.cars.some(n => n.id === c.id && n.edgeId === c.edgeId)));
    const beforeArrived = s.stats.arrived; city.setBridgeOpen(id, true);
    assert.ok(run(city, 40).stats.arrived > beforeArrived);
  }
});

test('all bridges closed: no spawning, safe queues, then every stranded trip recovers', () => {
  const city = createCity(); city.setDemand('busy'); run(city, 40);
  ids.forEach(id => city.setBridgeOpen(id, false));
  let s = city.snapshot(); const admitted = s.stats.spawned;
  for (let i = 0; i < 1600; i++) { city.step(.05); const n=city.snapshot(); invariant(n,s); s=n; assert.equal(s.stats.spawned, admitted); }
  assert.ok(s.cars.length > 0); assert.equal(s.stats.waiting, s.stats.active);
  const stranded = new Set(s.cars.map(c => c.id)); const before = s.stats.arrived;
  const stoppedCars = s.cars; run(city, 10); assert.deepEqual(city.snapshot().cars, stoppedCars);
  city.setBridgeOpen('central', true); s=city.snapshot();
  for (let i = 0; i < 3600; i++) { city.step(.05); const n=city.snapshot(); invariant(n,s); s=n; }
  assert.ok(s.stats.arrived >= before + stranded.size);
  assert.ok(s.cars.every(c => !stranded.has(c.id)));
  const empty = createCity(); ids.forEach(id => empty.setBridgeOpen(id,false));
  assert.equal(run(empty,60).stats.spawned,0); empty.setBridgeOpen('south',true);
  assert.ok(run(empty,60).stats.arrived > 0);
});

test('finite bounded traffic, following gaps, conservation and continuous transitions under repeated closures', () => {
  for (const seed of [0, 91, 0xffffffff]) {
    const city = createCity({seed}); city.setDemand('busy'); let previous = city.snapshot();
    for (let tick = 0; tick < 6000; tick++) {
      if (tick % 400 === 0) { const phase = Math.floor(tick / 400); ids.forEach((id,i) => city.setBridgeOpen(id, (phase+i)%4 === 0)); }
      if (tick % 1700 === 0) city.setDemand(tick % 3400 === 0 ? 'busy' : 'calm');
      city.step(.05); const s = city.snapshot(); invariant(s, previous); previous = s;
    }
    assert.ok(previous.stats.spawned > 30); assert.ok(previous.stats.arrived > 10);
  }
});

// A strict recording context checks geometry/state without claiming browser pixels.
function recordingContext() {
  const calls = [], stack = [];
  let state = { transform:[2,0,0,2,7,11], dash:[3,9], globalAlpha:.4, lineWidth:7, fillStyle:'pink', strokeStyle:'red' };
  const multiply = m => {
    const [a,b,c,d,e,f]=state.transform, [g,h,i,j,k,l]=m;
    state.transform=[a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f];
  };
  const api = {
    save() { stack.push(structuredClone(state)); },
    restore() { assert.ok(stack.length); state=stack.pop(); },
    scale(x,y) { multiply([x,0,0,y,0,0]); },
    translate(x,y) { multiply([1,0,0,1,x,y]); },
    rotate(a) { multiply([Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),0,0]); },
    setTransform(...m) { state.transform=m; },
    setLineDash(d) { state.dash=[...d]; },
  };
  for (const method of ['beginPath','closePath','rect','clip','moveTo','lineTo','stroke','fill','fillRect','ellipse','fillText']) api[method]=()=>{};
  const context = new Proxy(api, {
    get(target,key) {
      if (!(key in target)) return state[key];
      return (...args) => {
        const values=args.flat(); values.filter(v=>typeof v==='number').forEach(v=>assert.ok(Number.isFinite(v),`${key} finite`));
        calls.push({method:key,args:structuredClone(args),state:structuredClone(state)});
        return target[key](...args);
      };
    },
    set(target,key,value) { state[key]=value; return true; },
  });
  return {context,calls,state:()=>structuredClone(state), depth:()=>stack.length};
}
function deepFreeze(value) { if(value && typeof value==='object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }

test('renderer is deterministic, finite, snapshot-pure and restores caller state at responsive sizes/DPR', () => {
  const city=createCity(); run(city,20); city.setBridgeOpen('central',false); const snapshot=deepFreeze(city.snapshot());
  for (const [width,height] of [[320,320/1.45],[720,720*640/1100],[1440,1440*640/1100]]) for (const pixelRatio of [1,2]) {
    const a=recordingContext(), b=recordingContext(); const before=a.state();
    drawCity(a.context,snapshot,{width,height,pixelRatio}); drawCity(b.context,snapshot,{width,height,pixelRatio});
    assert.deepEqual(a.calls,b.calls); assert.deepEqual(a.state(),before); assert.equal(a.depth(),0);
    const translations=a.calls.filter(c=>c.method==='translate');
    for (const car of snapshot.cars) assert.ok(translations.some(c=>Math.abs(c.args[0]-car.x*width/1100)<1e-7 && Math.abs(c.args[1]-car.y*height/640)<1e-7));
    const bodies=a.calls.filter(c=>c.method==='fillRect' && ['#ae543e','#486c69','#ba8c36','#667450','#687c90','#f4e2bc'].includes(c.state.fillStyle));
    assert.equal(bodies.length,snapshot.cars.length);
    bodies.forEach(c=>{assert.ok(c.args[2]>=4.5); assert.ok(c.args[3]>=2.3);});
  }
});

test('renderer paints each engine road once per layer at exact nodes and shows closure markers', () => {
  const city=createCity(), s=city.snapshot(), a=recordingContext(); drawCity(a.context,s);
  const roadStrokes=a.calls.filter(c=>c.method==='stroke' && c.state.strokeStyle==='#d5cbb8');
  assert.equal(roadStrokes.length,27);
  const actual=[];
  for(let i=0;i<a.calls.length;i++) if(a.calls[i].method==='stroke' && a.calls[i].state.strokeStyle==='#d5cbb8') {
    assert.equal(a.calls[i-2].method,'moveTo'); assert.equal(a.calls[i-1].method,'lineTo');
    actual.push([a.calls[i-2].args,a.calls[i-1].args].map(p=>p.join(',')).sort().join('|'));
  }
  const nodes=new Map(s.nodes.map(n=>[n.id,n]));
  const expected=new Set(s.edges.map(e=>[nodes.get(e.from),nodes.get(e.to)].map(n=>`${n.x},${n.y}`).sort().join('|')));
  assert.deepEqual(new Set(actual),expected);
  ids.forEach(id=>city.setBridgeOpen(id,false)); const b=recordingContext(); drawCity(b.context,city.snapshot());
  assert.equal(b.calls.filter(c=>c.method==='stroke' && c.state.strokeStyle==='#994c3b').length,6);
  assert.equal(a.calls.filter(c=>c.method==='stroke' && c.state.strokeStyle==='#994c3b').length,0);
});

test('hit targets agree with bridge projection and include minimum 44px targets; invalid sizes are safe', () => {
  for(const width of [320,720,1440]) {
    const height=width<560?width/1.45:width*640/1100;
    for(const b of createCity().snapshot().bridges) {
      const x=width/2,y=b.y*height/640;
      for(const [dx,dy] of [[0,0],[21.9,0],[-21.9,0],[0,21.9],[0,-21.9]]) assert.equal(bridgeHitTest(x+dx,y+dy,width,height),b.id);
    }
    assert.equal(bridgeHitTest(0,0,width,height),null);
    assert.equal(bridgeHitTest(-1,height/2,width,height),null);
    assert.equal(bridgeHitTest(width+1,height/2,width,height),null);
  }
  for(const bad of [0,-1,NaN,Infinity,'320',null]) {
    assert.equal(bridgeHitTest(100,100,bad,640),null);
    assert.equal(bridgeHitTest(100,100,1100,bad),null);
    const c=recordingContext(); drawCity(c.context,createCity().snapshot(),{width:bad,height:640}); assert.equal(c.calls.length,0);
  }
  assert.equal(bridgeHitTest(NaN,100,1100,640),null);
});

test('source contracts: module exports, test command, local imports and no engine/view browser clock dependency', () => {
  const engine=readFileSync(new URL('../city-engine.mjs',import.meta.url),'utf8');
  const view=readFileSync(new URL('../city-view.mjs',import.meta.url),'utf8');
  const html=readFileSync(new URL('../preview.html',import.meta.url),'utf8');
  for(const source of [engine,view]) assert.doesNotMatch(source,/\b(?:Math\.random|Date\.now|document|window|requestAnimationFrame|setInterval|setTimeout|fetch)\s*[.(]/);
  assert.equal(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).scripts.test,'node --test tests/*.mjs');
  assert.match(html,/import \{ createCity \} from '\.\/city-engine\.mjs'/);
  assert.match(html,/import \{ drawCity, bridgeHitTest \} from '\.\/city-view\.mjs'/);
  assert.doesNotMatch(html,/(?:src|href)=["']https?:\/\//);
  for(const id of ids) assert.match(html,new RegExp(`<button[^>]+data-bridge="${id}"[^>]+aria-pressed="false"[^>]+aria-label=`));
  assert.match(html,/role="status" aria-live="polite"/); assert.match(html,/<label>[\s\S]*?<select id="demand">/);
  assert.match(html,/:focus-visible/);
});

function hostHarness(reducedMotion=false) {
  const html=readFileSync(new URL('../preview.html',import.meta.url),'utf8');
  const source=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import[^;]+;/gm,'');
  function element(dataset={}) {
    return {dataset,style:{},attrs:{},listeners:{},textContent:'',value:'',
      setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.listeners[k]=fn;},
      getBoundingClientRect(){return {left:10,top:20,width:320,height:320/1.45};}};
  }
  const elements=Object.fromEntries(['city','pause','demand','announcement','active','waiting','arrived','rerouted','reset'].map(id=>[id,element()]));
  const buttons=ids.map(id=>element({bridge:id})); const context=recordingContext(); elements.city.getContext=()=>context.context;
  const document={hidden:false,listeners:{},querySelector:q=>elements[q.slice(1)],querySelectorAll:()=>buttons,getElementById:id=>elements[id],addEventListener(k,f){this.listeners[k]=f;}};
  let city, scheduled, draws=0;
  const globals={document,window:{addEventListener(){}},devicePixelRatio:2,matchMedia:()=>({matches:reducedMotion}),
    ResizeObserver:class {observe(){}},requestAnimationFrame:fn=>{scheduled=fn;},
    createCity:()=>{city=createCity();return city;},bridgeHitTest,drawCity:()=>{draws++;}};
  new vm.Script(source,{filename:'preview-inline-module.js'}).runInNewContext(globals);
  return {elements,buttons,document,city:()=>city,draws:()=>draws,frame:now=>scheduled(now)};
}

test('preview wires bridge buttons/map coordinates, demand, reset and live statistics to the engine', () => {
  const h=hostHarness(); h.buttons.forEach(b=>b.listeners.click());
  assert.ok(h.city().snapshot().bridges.every(b=>!b.open));
  h.buttons.forEach(b=>assert.equal(b.attrs['aria-pressed'],'true'));
  assert.match(h.elements.announcement.textContent,/All crossings are closed/);
  const bounds=h.elements.city.getBoundingClientRect();
  h.elements.city.listeners.click({clientX:bounds.left+160,clientY:bounds.top+320*bounds.height/640});
  assert.equal(h.city().snapshot().bridges.find(b=>b.id==='central').open,true);
  h.elements.demand.value='busy'; h.elements.demand.listeners.change(); assert.equal(h.city().snapshot().demand,'busy');
  h.frame(0); for(let i=1;i<=240;i++)h.frame(i*250);
  for(const key of ['active','waiting','arrived','rerouted']) assert.equal(h.elements[key].textContent,String(h.city().snapshot().stats[key]));
  assert.ok(h.city().snapshot().stats.arrived>0);
  h.elements.reset.listeners.click(); assert.deepEqual(h.city().snapshot(),createCity().snapshot());
  assert.equal(h.elements.demand.value,'calm'); h.buttons.forEach(b=>assert.equal(b.attrs['aria-pressed'],'false'));
});

test('preview pause and reduced-motion freeze simulation; hidden-tab resume does not jump', () => {
  const h=hostHarness(true); h.frame(0); h.frame(1000); assert.equal(h.city().snapshot().time,0);
  assert.equal(h.elements.pause.textContent,'Play'); assert.match(h.elements.announcement.textContent,/reduced motion/);
  h.elements.pause.listeners.click(); h.frame(2000); h.frame(2100); near(h.city().snapshot().time,.1);
  h.elements.pause.listeners.click(); const before=h.city().snapshot(), draws=h.draws(); h.frame(5000); h.frame(6000);
  assert.deepEqual(h.city().snapshot(),before); assert.equal(h.draws(),draws);
  h.elements.pause.listeners.click(); h.frame(7000); h.frame(7100);
  h.document.hidden=true; h.document.listeners.visibilitychange(); h.frame(8000);
  h.document.hidden=false; h.document.listeners.visibilitychange(); const time=h.city().snapshot().time; h.frame(100000);
  near(h.city().snapshot().time,time); h.frame(100100); near(h.city().snapshot().time,time+.1);
});
