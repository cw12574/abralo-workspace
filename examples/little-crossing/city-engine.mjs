const DT = 0.05;
const SPEED = 48;
const GAP = 18;
const LANE_OFFSET = 5;
const MAX_CARS = 120;
const JUNCTION_TICKS = 10;
const COLUMNS = [80, 260, 440, 660, 840, 1020];
const ROWS = [130, 320, 510];
const BRIDGES = [
  { id: 'north', name: 'Willow bridge', y: 130 },
  { id: 'central', name: 'Market bridge', y: 320 },
  { id: 'south', name: 'Foundry bridge', y: 510 },
];

export function createCity({ seed = 20261005 } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('seed must be an unsigned 32-bit integer');
  }
  const nodes = ROWS.flatMap((y, row) => COLUMNS.map((x, col) => ({
    id: `n${row}-${col}`, x, y,
  })));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const edges = [];
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  function connect(a, b, bridge = null) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const start = nodeById.get(from);
      const end = nodeById.get(to);
      const edge = {
        id: `${from}>${to}`, from, to, bridge, closed: false,
        length: Math.hypot(end.x - start.x, end.y - start.y),
      };
      edges.push(edge);
      outgoing.get(from).push(edge);
    }
  }
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      connect(`n${row}-${col}`, `n${row}-${col + 1}`, col === 2 ? BRIDGES[row].id : null);
    }
  }
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 6; col++) connect(`n${row}-${col}`, `n${row + 1}-${col}`);
  }
  const edgeById = new Map(edges.map(edge => [edge.id, edge]));
  let bridges, cars, demand, tick, remainder, randomState, nextId;
  let arrived, rerouted, spawned, spawnClock, nextJunction;

  function reset() {
    bridges = BRIDGES.map(bridge => ({ ...bridge, open: true }));
    edges.forEach(edge => { edge.closed = false; });
    cars = [];
    demand = 'calm';
    tick = remainder = arrived = rerouted = spawned = spawnClock = 0;
    randomState = seed;
    nextId = 1;
    nextJunction = new Map(nodes.map(node => [node.id, 0]));
  }

  function random() {
    randomState = (randomState + 0x6d2b79f5) >>> 0;
    let value = randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  // Dijkstra on road length. Stable node/edge order resolves equal-cost routes.
  function route(from, target) {
    const distance = new Map([[from, 0]]);
    const previous = new Map();
    const unvisited = new Set(nodes.map(node => node.id));
    while (unvisited.size) {
      let current = null;
      let best = Infinity;
      for (const id of unvisited) {
        if ((distance.get(id) ?? Infinity) < best) {
          current = id;
          best = distance.get(id);
        }
      }
      if (current === null) return null;
      if (current === target) {
        const path = [];
        while (current !== from) {
          const edge = previous.get(current);
          path.push(edge.id);
          current = edge.from;
        }
        return path.reverse();
      }
      unvisited.delete(current);
      for (const edge of outgoing.get(current)) {
        if (edge.closed || !unvisited.has(edge.to)) continue;
        const cost = best + edge.length;
        if (cost < (distance.get(edge.to) ?? Infinity)) {
          distance.set(edge.to, cost);
          previous.set(edge.to, edge);
        }
      }
    }
    return null;
  }

  function hasSpace(edgeId) {
    return cars.every(car => car.edgeId !== edgeId || car.progress >= GAP);
  }

  function spawn() {
    if (cars.length >= MAX_CARS) return;
    const left = random() < 0.5;
    const origin = `n${Math.floor(random() * 3)}-${left ? 0 : 5}`;
    const target = `n${Math.floor(random() * 3)}-${left ? 5 : 0}`;
    const path = route(origin, target);
    if (!path?.length || !hasSpace(path[0]) || nextJunction.get(origin) > tick) return;
    cars.push({
      id: `car-${nextId}`, order: nextId++, origin, target,
      edgeId: path[0], route: path.slice(1), progress: 0,
      waiting: false, reroutes: 0, nodeSince: null,
    });
    nextJunction.set(origin, tick + JUNCTION_TICKS);
    spawned++;
  }

  function advance() {
    tick++;
    // Oldest stopped arrival first; ties use creation order. One admission per
    // junction per half second, with outgoing headway required before turning.
    const atNodes = cars.filter(car => car.nodeSince !== null)
      .sort((a, b) => a.nodeSince - b.nodeSince || a.order - b.order);
    const finished = new Set();
    for (const car of atNodes) {
      const node = edgeById.get(car.edgeId).to;
      if (node === car.target) {
        finished.add(car.id);
        arrived++;
        continue;
      }
      if (nextJunction.get(node) > tick) continue;
      const path = route(node, car.target);
      if (!path?.length) continue;
      if (car.route.join('|') !== path.join('|')) {
        car.reroutes++;
        rerouted++;
        car.route = path;
      }
      if (!hasSpace(path[0])) continue;
      car.edgeId = path[0];
      car.route = path.slice(1);
      car.progress = 0;
      car.nodeSince = null;
      nextJunction.set(node, tick + JUNCTION_TICKS);
    }
    cars = cars.filter(car => !finished.has(car.id));

    // Front-to-back movement on each directed lane guarantees GAP spacing.
    for (const edge of edges) {
      const lane = cars.filter(car => car.edgeId === edge.id)
        .sort((a, b) => b.progress - a.progress);
      let limit = edge.length;
      for (const car of lane) {
        const before = car.progress;
        car.progress = Math.min(before + SPEED * DT, limit);
        car.waiting = car.progress - before < 1e-9;
        if (car.progress >= edge.length - 1e-9) {
          car.progress = edge.length;
          car.nodeSince ??= tick;
        }
        limit = car.progress - GAP;
      }
    }
    spawnClock++;
    const interval = demand === 'busy' ? 5 : 18;
    if (spawnClock >= interval) {
      spawnClock = 0;
      spawn();
    }
  }

  function step(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError('step seconds must be a finite nonnegative number');
    }
    remainder += Math.min(seconds, 0.25);
    while (remainder + 1e-10 >= DT) {
      remainder = Math.max(0, remainder - DT);
      advance();
    }
  }

  function setBridgeOpen(id, open) {
    const bridge = bridges.find(item => item.id === id);
    if (!bridge) throw new RangeError(`Unknown bridge: ${id}`);
    if (typeof open !== 'boolean') throw new TypeError('Bridge open must be boolean');
    bridge.open = open;
    edges.forEach(edge => { if (edge.bridge === id) edge.closed = !open; });
  }

  function setDemand(mode) {
    if (mode !== 'calm' && mode !== 'busy') throw new RangeError('Demand must be calm or busy');
    demand = mode;
  }

  function snapshot() {
    return {
      time: tick * DT, seed, demand,
      nodes: nodes.map(node => ({ ...node })),
      edges: edges.map(edge => ({ ...edge })),
      bridges: bridges.map(bridge => ({ ...bridge })),
      cars: cars.map(car => {
        const edge = edgeById.get(car.edgeId);
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        const dx = (to.x - from.x) / edge.length;
        const dy = (to.y - from.y) / edge.length;
        return {
          id: car.id, origin: car.origin, target: car.target,
          edgeId: car.edgeId, progress: car.progress, route: [...car.route],
          x: from.x + dx * car.progress - dy * LANE_OFFSET,
          y: from.y + dy * car.progress + dx * LANE_OFFSET,
          angle: Math.atan2(dy, dx), waiting: car.waiting, reroutes: car.reroutes,
        };
      }),
      stats: { arrived, active: cars.length, waiting: cars.filter(car => car.waiting).length, rerouted, spawned },
    };
  }

  reset();
  return { step, setBridgeOpen, setDemand, reset, snapshot };
}
