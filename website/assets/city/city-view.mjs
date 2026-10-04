// A paper city in world coordinates. The host owns the DPR transform and clock.
const W = 1100, H = 640;
const P = {
  paper: '#f2ead9', ink: '#414d43', grass: '#d4dbc0', tree: '#879a71',
  treeDark: '#697f61', river: '#a7c6c7', ripple: '#d5e5de', road: '#d5cbb8',
  edge: '#b9af99', roof: '#b97558', paleRoof: '#c89b65', slate: '#87958a',
};
const crossings = [{ id: 'north', y: 130 }, { id: 'central', y: 320 }, { id: 'south', y: 510 }];

function line(c, points, color, weight = 1) {
  c.beginPath();
  points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
  c.strokeStyle = color; c.lineWidth = weight; c.stroke();
}
function rect(c, x, y, w, h, color) { c.fillStyle = color; c.fillRect(x, y, w, h); }
function oval(c, x, y, rx, ry, color) {
  c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fillStyle = color; c.fill();
}
function text(c, value, x, y, size = 11, color = P.ink) {
  c.fillStyle = color; c.font = `${size}px Georgia, serif`; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillText(value, x, y);
}
function tree(c, x, y, size = 9) {
  oval(c, x + 4, y + 5, size, size * .65, '#697f611f');
  rect(c, x - 1, y, 2, size + 4, '#8b7960');
  oval(c, x, y, size, size * 1.08, P.treeDark);
  oval(c, x - 2, y - 2, size * .83, size * .86, P.tree);
}
function house(c, x, y, w, h, roof = P.roof) {
  rect(c, x + 6, y + 7, w, h, '#655c4320');
  rect(c, x, y + 5, w, h, '#e2d5bc');
  rect(c, x - 2, y - 2, w + 4, h, roof);
  line(c, [[x - 2, y + h / 2 - 2], [x + w + 2, y + h / 2 - 2]], '#67594e70', 1.5);
  line(c, [[x, y], [x + w, y]], '#fff7de60');
  for (let wx = x + 6; wx < x + w - 3; wx += 12) rect(c, wx, y + h, 4, 4, '#697b75');
  rect(c, x + w - 9, y + 3, 4, 7, '#e5cfb0');
}
function garden(c, x, y, w, h) {
  rect(c, x, y, w, h, '#d0d6b8');
  for (let i = 0; i < 3; i++) {
    line(c, [[x + 5, y + 5 + i * 7], [x + w - 5, y + 5 + i * 7]], '#9aa77f', 3);
  }
}

function grounds(c) {
  rect(c, 0, 0, W, H, P.paper);
  // Fixed arithmetic stippling: the paper never flickers between frames.
  c.fillStyle = '#a3957622';
  for (let i = 0; i < 220; i++) c.fillRect((i * 157 + 29) % W, (i * 89 + 17) % H, 1, 1);
  rect(c, 466, 0, 168, H, '#d7dbc4');
  rect(c, 480, 0, 140, H, P.river);
  line(c, [[479, 0], [479, H]], '#7faaa4', 2);
  line(c, [[621, 0], [621, H]], '#7faaa4', 2);
  for (let y = 22; y < H; y += 29) {
    for (let x = 494; x < 610; x += 37) {
      const shift = (y % 3) * 4;
      line(c, [[x + shift, y], [x + 11 + shift, y - 1], [x + 17 + shift, y]], P.ripple, 1);
    }
  }
  line(c, [[470, 0], [470, H]], '#f8f1dc', 4);
  line(c, [[630, 0], [630, H]], '#f8f1dc', 4);
  // A barge and three very unhurried ducks; these are static illustrations.
  c.save(); c.translate(578, 411); c.rotate(.08);
  oval(c, 0, 2, 10, 34, '#789d9840');
  oval(c, 0, 0, 8, 32, '#586f67');
  rect(c, -6, -21, 12, 42, '#b57a56'); rect(c, -5, 10, 10, 9, '#e6d6b4');
  line(c, [[-3, -15], [-3, 3]], '#d9b185', 2); c.restore();
  for (let i = 0; i < 3; i++) {
    oval(c, 519 + i * 10, 222 + i * 8, 3, 2, '#f7edcc');
    rect(c, 521 + i * 10, 220 + i * 8, 2, 1, '#bd8750');
  }
}

function village(c) {
  // Each block sits inside the real street grid, leaving the traffic unobscured.
  for (const x of [110, 290, 690, 870]) {
    house(c, x, 56, 42, 30, x < 500 ? P.roof : P.paleRoof);
    house(c, x + 67, 65, 44, 23, P.slate);
    garden(c, x + 10, 20, 32, 25);
    tree(c, x + 119, 74, 10);
    house(c, x + 4, 551, 45, 27, P.paleRoof);
    house(c, x + 70, 548, 39, 34, P.roof);
    tree(c, x + 121, 577, 10);
  }
  // Western terraces and kitchen gardens.
  for (const y of [175, 371]) {
    garden(c, 120, y, 102, 34);
    for (let i = 0; i < 3; i++) house(c, 119 + i * 36, y + 49, 27, 37, i === 1 ? P.paleRoof : P.roof);
    tree(c, 128, y + 109, 10); tree(c, 218, y + 112, 8);
  }
  // Willow common, with a path, a pond and a tiny bandstand.
  rect(c, 291, 166, 119, 124, P.grass);
  line(c, [[300, 278], [344, 227], [397, 179]], '#eee5cb', 8);
  oval(c, 321, 197, 19, 12, '#a9c6b9');
  tree(c, 385, 258, 15); tree(c, 306, 251, 11); tree(c, 380, 194, 10);
  oval(c, 351, 226, 13, 12, '#c5b893');
  c.beginPath(); c.moveTo(338, 221); c.lineTo(351, 211); c.lineTo(364, 221); c.closePath();
  c.fillStyle = P.slate; c.fill();
  // The market: paving, striped canvas awnings, and crates.
  rect(c, 289, 356, 122, 121, '#e5d9be');
  for (let i = 0; i < 7; i++) line(c, [[296 + i * 17, 361], [296 + i * 17, 472]], '#cabea438');
  for (const [x, y, color] of [[309, 372, P.roof], [369, 372, '#879972'], [309, 433, '#c5a05f'], [369, 433, P.roof]]) {
    rect(c, x - 3, y + 4, 33, 22, '#74664520');
    rect(c, x, y, 28, 21, color);
    for (let i = 0; i < 3; i++) rect(c, x + 3 + i * 9, y, 4, 21, '#f1e6cc');
    rect(c, x + 4, y + 23, 7, 5, '#aa8857');
  }
  oval(c, 352, 416, 12, 12, '#b6ad92'); oval(c, 352, 415, 9, 9, '#a8c6bd');
  // Clock court on the eastern bank.
  rect(c, 692, 175, 117, 113, '#e6dcc6');
  house(c, 699, 185, 84, 33, P.slate);
  rect(c, 738, 233, 29, 41, '#71634824');
  rect(c, 729, 223, 29, 41, '#d7be92');
  rect(c, 725, 218, 37, 13, P.roof);
  oval(c, 744, 239, 9, 9, '#f5ebd2');
  line(c, [[744, 233], [744, 239], [749, 242]], P.ink, 1.5);
  tree(c, 794, 252, 11); tree(c, 702, 263, 9);
  // A small foundry, loading yard, and decorative disconnected rails.
  house(c, 695, 363, 92, 45, P.roof);
  rect(c, 767, 349, 10, 31, '#8e6d55'); rect(c, 765, 346, 14, 5, '#b48a63');
  for (let y = 437; y <= 477; y += 20) {
    for (let x = 695; x < 804; x += 8) rect(c, x, y - 4, 2, 12, '#b9a98b');
    line(c, [[691, y - 2], [807, y - 2]], '#8c9283');
    line(c, [[691, y + 4], [807, y + 4]], '#8c9283');
  }
  rect(c, 715, 436, 29, 9, '#b48b61'); rect(c, 750, 456, 29, 9, P.slate);
  for (const y of [173, 365]) {
    house(c, 881, y, 38, 42, P.paleRoof);
    house(c, 952, y + 9, 36, 30, P.roof);
    garden(c, 948, y + 63, 39, 30);
    tree(c, 895, y + 89, 15); tree(c, 926, y + 119, 10);
  }
  for (const x of [39, 1062]) for (let y = 170; y < 500; y += 60) tree(c, x, y, 10);
  for (const x of [459, 641]) for (const y of [49, 192, 265, 382, 450, 574]) tree(c, x, y, 6);
}

function roads(c, snapshot) {
  const nodes = new Map(snapshot.nodes.map(n => [n.id, n]));
  const seen = new Set();
  const segments = snapshot.edges.filter(e => {
    const key = [e.from, e.to].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  c.lineCap = 'round';
  for (const [color, weight] of [[P.edge, 26], ['#ece2cd', 24], [P.road, 19]]) {
    for (const e of segments) {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      line(c, [[a.x, a.y], [b.x, b.y]], color, weight);
    }
  }
  c.lineCap = 'butt'; c.setLineDash([4, 8]);
  for (const e of segments) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    line(c, [[a.x, a.y], [b.x, b.y]], '#f4ecd9', 1);
  }
  c.setLineDash([]);
  for (const b of snapshot.bridges) {
    // Parapets follow the exact crossing centerline, from x440 to x660.
    for (const offset of [-15, 15]) {
      line(c, [[475, b.y + offset], [625, b.y + offset]], '#938f79', 3);
      for (let x = 477; x < 626; x += 18) rect(c, x, b.y + offset - 2, 4, 4, '#e9dfc6');
    }
  }
}

function closures(c, snapshot, sx, sy) {
  for (const b of snapshot.bridges) {
    if (b.open) continue;
    for (const x of [451, 649]) {
      rect(c, x - 3, b.y - 12, 6, 24, '#f9efd9');
      for (let dy = -12; dy < 12; dy += 8) rect(c, x - 3, b.y + dy, 6, 4, '#a95440');
      oval(c, x, b.y - 14, 3, 3, '#9b4d3d');
    }
    // A persistent X sits above the deck, never hiding a car finishing its trip.
    c.save(); c.translate(550, b.y - 29); c.scale(1 / sx, 1 / sy);
    oval(c, 0, 0, 7, 7, '#f5e6cd');
    line(c, [[-3, -3], [3, 3]], '#994c3b', 2);
    line(c, [[3, -3], [-3, 3]], '#994c3b', 2); c.restore();
  }
}

function cars(c, snapshot, sx, sy) {
  const colors = ['#ae543e', '#486c69', '#ba8c36', '#667450', '#687c90', '#f4e2bc'];
  for (const car of snapshot.cars) {
    // Heading and minimum size are resolved in CSS pixels, including tall mobile maps.
    const angle = Math.atan2(Math.sin(car.angle) * sy, Math.cos(car.angle) * sx);
    const along = Math.hypot(Math.cos(car.angle) * sx, Math.sin(car.angle) * sy);
    const across = Math.hypot(Math.sin(car.angle) * sx, Math.cos(car.angle) * sy);
    const length = Math.max(4.5, 10 * along), breadth = Math.max(2.3, 5 * across);
    c.save(); c.translate(car.x * sx, car.y * sy); c.rotate(angle);
    rect(c, -length / 2 + .7, -breadth / 2 + .8, length, breadth, '#38463838');
    const id = Number(String(car.id).replace(/\D/g, '')) || 0;
    rect(c, -length / 2, -breadth / 2, length, breadth, colors[id % colors.length]);
    rect(c, length * .12, -breadth * .37, Math.max(.7, length * .19), breadth * .74, '#e8ede0');
    rect(c, -length * .29, -breadth * .35, length * .13, breadth * .7, '#344c4880');
    if (car.waiting) {
      rect(c, -length / 2, -breadth / 2, Math.max(.7, length * .1), breadth * .3, '#812f25');
      rect(c, -length / 2, breadth * .2, Math.max(.7, length * .1), breadth * .3, '#812f25');
    }
    c.restore();
  }
}

// Website integration polish: cache the static map; redraw only closures and cars.
// OffscreenCanvas is optional. Other hosts use the original immediate drawing path.
const mapLayers = new WeakMap();
function staticMap(context, snapshot, width, height) {
  context.save();
  try {
    context.scale(width / W, height / H);
    grounds(context); village(context); roads(context, snapshot);
    if (width >= 560) {
      text(context, 'WILLOW COMMON', 351, 157, 9);
      text(context, 'SATURDAY MARKET', 351, 491, 9);
      text(context, 'CLOCK COURT', 751, 302, 9);
      text(context, 'THE SMALL WORKS', 751, 495, 9);
      text(context, 'No hurry, ducks crossing.', 550, 254, 9, '#4a7270');
      for (const b of snapshot.bridges) text(context, b.name, 550, b.y + 37, 11);
      text(context, 'WEST BANK', 171, 613, 11, '#8e8d74');
      text(context, 'EAST BANK', 929, 613, 11, '#8e8d74');
    }
  } finally { context.restore(); }
}
/** CSS pixel dimensions; retain the caller's transform (including pixelRatio). */
export function drawCity(context, snapshot, { width = W, height = H, pixelRatio = 1 } = {}) {
  if (![width, height, pixelRatio].every(v => Number.isFinite(v) && v > 0)) return;
  const sx = width / W, sy = height / H;
  context.save();
  try {
    context.beginPath(); context.rect(0, 0, width, height); context.clip();
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    context.setLineDash([]); context.shadowBlur = 0; context.shadowOffsetX = 0; context.shadowOffsetY = 0;
    if (typeof OffscreenCanvas !== 'undefined') {
      const key = JSON.stringify([width, height, pixelRatio, snapshot.nodes, snapshot.edges.map(e => [e.from,e.to]), snapshot.bridges.map(b => [b.id,b.name,b.y])]);
      let layer = mapLayers.get(context);
      if (!layer || layer.key !== key) {
        const canvas = new OffscreenCanvas(Math.ceil(width * pixelRatio), Math.ceil(height * pixelRatio));
        const painter = canvas.getContext('2d');
        if (painter) {
          painter.scale(pixelRatio, pixelRatio);
          staticMap(painter, snapshot, width, height);
          layer = {key, canvas}; mapLayers.set(context, layer);
        }
      }
      if (layer?.key === key) context.drawImage(layer.canvas, 0, 0, width, height);
      else staticMap(context, snapshot, width, height);
    } else staticMap(context, snapshot, width, height);
    context.save();
    try { context.scale(sx, sy); closures(context, snapshot, sx, sy); }
    finally { context.restore(); }
    cars(context, snapshot, sx, sy);
  } finally { context.restore(); }
}

/** Same proportional projection as drawCity; targets are at least 44 CSS px tall. */
export function bridgeHitTest(x, y, width, height) {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (x < 0 || x > width || y < 0 || y > height) return null;
  const centerX = 550 * width / W;
  const halfWidth = Math.max(22, 110 * width / W);
  const halfHeight = Math.max(22, 25 * height / H);
  if (Math.abs(x - centerX) > halfWidth) return null;
  const nearest = crossings.reduce((a, b) => Math.abs(y - a.y * height / H) <= Math.abs(y - b.y * height / H) ? a : b);
  return Math.abs(y - nearest.y * height / H) <= halfHeight ? nearest.id : null;
}
