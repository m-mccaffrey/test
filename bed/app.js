import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (s) => document.querySelector(s);

// Actual dimensions of dimensional lumber (thickness x width, inches)
const LUMBER = {
  '2x4': { t: 1.5, w: 3.5 }, '2x6': { t: 1.5, w: 5.5 }, '2x8': { t: 1.5, w: 7.25 },
  '2x10': { t: 1.5, w: 9.25 }, '4x4': { t: 3.5, w: 3.5 },
  '1x4': { t: 0.75, w: 3.5 }, '1x6': { t: 0.75, w: 5.5 }, '1x8': { t: 0.75, w: 7.25 },
};
const LIP_BOARDS = ['1x4', '1x6', '1x8'];
const LIP_OVERLAP = 2; // how much of the lip board must lap onto the rail for screws
const STEP_GAP = 0.25; // gap between the step and the bed
const STOCK_LENGTHS = { '2x4': [96, 120, 144], '4x4': [96, 120, 144], default: [96, 120, 144, 192] };
const KERF = 0.125;
const SHEET = { w: 48, l: 96 };
const QUEEN = { w: 60, l: 80 };

const COLORS = {
  A: '#c7874a', B: '#d49a5c', C: '#9c5a26', D: '#b06d34', E: '#e2b46e', F: '#6e4020',
  G: '#e9d2a2', H: '#dcc08a', M: '#c9d4e0',
  L: '#7d5234', P: '#8c5f3c', S: '#c89f6c', T: '#b48a58', U: '#a07a4c',
};
const GROUP_OF = { H: 'G', P: 'L', T: 'S', U: 'S' };
// build step (stage) each part is installed in
const STAGE_OF = { A: 1, B: 1, C: 2, D: 2, F: 3, E: 4, G: 5, H: 5, L: 6, P: 6, M: 7, S: 8, T: 8, U: 8 };
const FASTENER_TYPES = {
  struct: { color: '#e8b400', r: 0.17, head: 0.5, label: '3″ structural screw' },
  hanger: { color: '#9aa6b1', label: 'Joist hanger' },
  deck: { color: '#2f7de1', r: 0.12, head: 0.36, label: '1⅝″ deck screw' },
  trim: { color: '#18a999', r: 0.11, head: 0.3, label: '1⅝″ trim-head screw' },
  step: { color: '#a557d6', r: 0.11, head: 0.32, label: '1⅝″ step screw' },
};
const GROUP_LABELS = [
  ['A', 'Head/foot rails'], ['B', 'Side rails'], ['C', 'Center spine'], ['D', 'Mid beam'],
  ['E', 'Joists'], ['F', 'Legs'], ['G', 'Plywood'], ['L', 'Lip'], ['S', 'Dog step'], ['M', 'Mattresses'],
];
const DEFAULT_PRICES = { // rough per-linear-foot / per-unit placeholders
  '2x4': 0.55, '2x6': 0.85, '2x8': 1.1, '2x10': 1.55, '4x4': 1.6, '1x4': 0.9, '1x6': 1.4, '1x8': 1.9,
  'ply0.75': 62, 'ply0.625': 52,
  screw3: 0.25, hanger24: 1.4, hangerBig: 2.6, sd9: 0.12, deck: 0.06, pad: 0.75,
  trim: 0.1, stepScrew: 0.05, glue: 6, tread: 14, stepPad: 0.5,
};

// ---------- formatting ----------
function fmt(x) {
  const s = Math.round(x * 16) / 16;
  let whole = Math.floor(s + 1e-9);
  let frac = Math.round((s - whole) * 16);
  if (frac === 16) { whole++; frac = 0; }
  if (!frac) return `${whole}″`;
  let n = frac, d = 16;
  while (n % 2 === 0) { n /= 2; d /= 2; }
  return `${whole ? whole + '-' : ''}${n}/${d}″`;
}
const ftIn = (x) => {
  const ft = Math.floor(x / 12), inch = x - ft * 12;
  return inch < 1 / 32 ? `${ft}′` : `${ft}′ ${fmt(inch)}`;
};
const money = (x) => `$${x.toFixed(2)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- design model ----------
function readParams() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return {
    mattT: num('#mattT', 11), target: num('#target', 24), clear: Math.max(0, num('#clear', 0.5)),
    rail: $('#rail').value, spacing: parseFloat($('#spacing').value), ply: parseFloat($('#ply').value),
    lip: Math.max(0, num('#lip', 2)),
    step: $('#stepOn').checked, stepH: num('#stepH', 12), stepW: num('#stepW', 36), stepD: num('#stepD', 14),
    stepLoc: $('#stepLoc').value,
  };
}

function between(a, b, s) {
  const n = Math.ceil((b - a) / s - 1e-9);
  const out = [];
  for (let i = 1; i < n; i++) out.push(a + (i * (b - a)) / n);
  return out;
}

function design(p) {
  const t = 1.5;
  const W = 2 * QUEEN.w + 2 * p.clear, L = QUEEN.l + 2 * p.clear;
  const H = W / 2, Lh = L / 2;
  const D = p.target - p.mattT; // deck top
  const F = D - p.ply; // frame top
  const rh = LUMBER[p.rail].w, jh = 3.5, lg = 3.5;
  const warnings = [];
  if (D < 4) warnings.push('That mattress is too thick for a platform at this height. Lower the mattress thickness or raise the target.');
  if (rh > F) warnings.push(`A ${p.rail} rail (${fmt(rh)}) is taller than the ${fmt(F)} frame height, so the rails would sit on the floor. Choose a smaller rail size.`);
  const yR0 = Math.max(0, F - rh);

  const defs = {};
  const def = (mark, name, stock, len, note, extra = {}) =>
    (defs[mark] = { mark, name, stock, len, note, pieces: [], ...extra });
  const box = (x0, x1, y0, y1, z0, z1) => ({ x: [x0, x1], y: [y0, y1], z: [z0, z1] });
  const put = (mark, b, ex, meta = {}) => defs[mark].pieces.push({ box: b, ex, ...meta });

  // fasteners: every screw is an entry point + direction; hangers are a stirrup + flange plate.
  // joints[key] describes one kind of connection for the build steps and the hover tooltip.
  const fast = [], hangers = [], joints = {};
  const joint = (key, stage, type, title, where) => (joints[key] = { key, stage, type, title, where, count: 0 });
  const screw = (key, p0, dir, len) => {
    const j = joints[key];
    fast.push({ key, type: j.type, stage: j.stage, p: p0, dir, len, info: `${FASTENER_TYPES[j.type].label} · ${j.title}` });
    j.count++;
  };
  const hanger = (key, axis, pos, sgn, a0, a1, y0, hh) => {
    // axis: horizontal axis normal to the carrying face; the carried member runs from pos in direction sgn
    const g = 0.06, seat = 1.75, fl = 1.1, j = joints[key];
    const mk = (n, c, yy) => (axis === 'x' ? box(n[0], n[1], yy[0], yy[1], c[0], c[1]) : box(c[0], c[1], yy[0], yy[1], n[0], n[1]));
    const stir = sgn > 0 ? [pos, pos + seat] : [pos - seat, pos];
    const plate = sgn > 0 ? [pos, pos + g] : [pos - g, pos];
    hangers.push({ key, stage: j.stage, info: `${j.title}`, axis, sgn, face: pos, span: [a0 - fl, a1 + fl], y: [y0, y0 + hh],
      boxes: [mk(stir, [a0 - g, a1 + g], [y0 - g, y0 + hh]), mk(plate, [a0 - fl, a1 + fl], [y0, y0 + hh])] });
    j.count++;
  };
  const onPlate = (ax, face, o, y) => hangers.some((h) => h.axis === ax && Math.abs(h.face - face) < 0.01
    && o > h.span[0] - 0.3 && o < h.span[1] + 0.3 && y > h.y[0] - 0.3 && y < h.y[1] + 0.3);

  // A — head & foot rails run full width; everything else butts between them
  def('A', 'Head / foot rail', p.rail, W, 'Full width. The side rails and spine butt into these.');
  put('A', box(0, W, yR0, F, 0, t), 1);
  put('A', box(0, W, yR0, F, L - t, L), 1);
  // B — side rails
  def('B', 'Side rail', p.rail, L - 2 * t, 'Fits between the head and foot rails.');
  put('B', box(0, t, yR0, F, t, L - t), 1);
  put('B', box(W - t, W, yR0, F, t, L - t), 1);
  // C — center spine under the mattress seam
  def('C', 'Center spine', p.rail, L - 2 * t, 'Centered under the seam between the mattresses.');
  put('C', box(H - t / 2, H + t / 2, yR0, F, t, L - t), 2);
  // D — mid cross-beam, two halves
  def('D', 'Mid beam (half)', p.rail, H - t - t / 2, 'Spans from the side rail to the spine at mid-length.');
  put('D', box(t, H - t / 2, yR0, F, Lh - t / 2, Lh + t / 2), 2);
  put('D', box(H + t / 2, W - t, yR0, F, Lh - t / 2, Lh + t / 2), 2);

  // E — joists run head-to-foot so the plywood seams land on them
  const seam = SHEET.w;
  const leftX = H > seam + 3
    ? [...between(t / 2, seam, p.spacing), seam, ...between(seam, H, p.spacing)]
    : between(t / 2, H, p.spacing);
  const joistX = [...leftX, ...leftX.map((x) => W - x).reverse()];
  const jLen = Lh - t / 2 - t;
  def('E', 'Joist', '2x4', jLen, 'On edge, in 2×4 hangers. Top flush with the rails.');
  for (const x of joistX) {
    put('E', box(x - t / 2, x + t / 2, F - jh, F, t, Lh - t / 2), 3, { cx: x });
    put('E', box(x - t / 2, x + t / 2, F - jh, F, Lh + t / 2, L - t), 3, { cx: x });
  }

  // F — 4x4 legs, full height, screwed to the faces of the frame members
  def('F', 'Leg', '4x4', F, 'Floor to frame top. Screwed to the faces of the rails and beams.');
  const leg = (x0, z0, faces, where) => put('F', box(x0, x0 + lg, 0, F, z0, z0 + lg), 0, { faces, where });
  leg(t, t, 2, 'corner'); leg(W - t - lg, t, 2, 'corner');
  leg(t, L - t - lg, 2, 'corner'); leg(W - t - lg, L - t - lg, 2, 'corner');
  leg(H + t / 2, t, 2, 'head rail, beside spine');
  leg(H - t / 2 - lg, L - t - lg, 2, 'foot rail, beside spine');
  leg(t, Lh + t / 2, 2, 'left side rail, beside mid beam');
  leg(W - t - lg, Lh - t / 2 - lg, 2, 'right side rail, beside mid beam');
  leg(H + t / 2, Lh + t / 2, 2, 'center, spine × mid beam');
  // mid-beam legs: center them in the joist gap nearest the middle of each half
  const sup = [t / 2, ...leftX, H];
  let gx = H / 2;
  for (let i = 0; i < sup.length - 1; i++) if (H / 2 >= sup[i] && H / 2 <= sup[i + 1]) gx = (sup[i] + sup[i + 1]) / 2;
  leg(gx - lg / 2, Lh - t / 2 - lg, 1, 'left mid beam');
  leg(W - gx - lg / 2, Lh + t / 2, 1, 'right mid beam');

  // ---- frame fasteners ----
  const rb = (f) => yR0 + (F - yR0) * f; // height on a rail, as a fraction up from its bottom edge
  const r3 = [0.2, 0.5, 0.8];
  const r3txt = r3.map((f) => fmt((F - yR0) * (1 - f))).reverse().join(', ');
  const fromTop = 'down from the top edge (the edge on the floor while the frame is upside down)';
  const R = p.rail.replace('x', '×');
  joint('corner', 1, 'struct', 'Head/foot rail (A) into side rail (B)',
    `3 per corner, driven through the outside face of A into the end of B: ${fmt(t / 2)} in from the end of A, at ${r3txt} ${fromTop}.`);
  for (const x of [t / 2, W - t / 2]) for (const f of r3) {
    screw('corner', [x, rb(f), 0], [0, 0, 1], 3);
    screw('corner', [x, rb(f), L], [0, 0, -1], 3);
  }
  joint('spine', 2, 'struct', 'Head/foot rail (A) into spine (C)',
    `3 at each end, through A into the end of C on the center mark (${fmt(H)} from either side), at ${r3txt} down from the top edge.`);
  for (const f of r3) { screw('spine', [H, rb(f), 0], [0, 0, 1], 3); screw('spine', [H, rb(f), L], [0, 0, -1], 3); }
  joint('beamSide', 2, 'struct', 'Side rail (B) into mid beam (D)',
    `3 on each side, through B into the end of D, centered ${fmt(Lh)} from the head end, at ${r3txt} down from the top edge.`);
  for (const f of r3) { screw('beamSide', [0, rb(f), Lh], [1, 0, 0], 3); screw('beamSide', [W, rb(f), Lh], [-1, 0, 0], 3); }
  joint('beamHanger', 2, 'hanger', `Mid beam (D) into spine (C): ${R} face-mount hanger`,
    `One hanger on each side of the spine, seat flush with the bottom of the rail. Hold D in place, then nail or screw every flange hole (SD9112).`);
  hanger('beamHanger', 'x', H - t / 2, -1, Lh - t / 2, Lh + t / 2, yR0, rh - 1);
  hanger('beamHanger', 'x', H + t / 2, 1, Lh - t / 2, Lh + t / 2, yR0, rh - 1);

  joint('joistHanger', 4, 'hanger', 'Joist (E) into rail/beam: 2×4 face-mount hanger (LUS24)',
    `A hanger at both ends of every joist, with the seat ${fmt(jh)} below the rail top so the joist sits flush. A joist offcut makes a good gauge. Fill every hole (SD9112).`);
  for (const x of joistX) {
    hanger('joistHanger', 'z', t, 1, x - t / 2, x + t / 2, F - jh, 3.125);
    hanger('joistHanger', 'z', Lh - t / 2, -1, x - t / 2, x + t / 2, F - jh, 3.125);
    hanger('joistHanger', 'z', Lh + t / 2, 1, x - t / 2, x + t / 2, F - jh, 3.125);
    hanger('joistHanger', 'z', L - t, -1, x - t / 2, x + t / 2, F - jh, 3.125);
  }

  // legs: 4 screws through every member face a leg touches, driven from the member's far side into the leg
  const legF = [0.28, 0.68];
  joint('leg', 3, 'struct', 'Rail/beam into leg (F)',
    `4 per face the leg touches, driven from the far side of the rail or beam into the leg: 2 columns about ½″ in from the leg's edges, at ${legF.map((f) => fmt((F - yR0) * (1 - f))).reverse().join(' and ')} ${fromTop}. Near a hanger, move the column over to clear its flange.`);
  const members = ['A', 'B', 'C', 'D'].flatMap((m) => defs[m].pieces.map((pc) => ({ m, b: pc.box })));
  for (const lgp of defs.F.pieces) {
    const Lb = lgp.box;
    lgp.faces = 0;
    for (const { b } of members) for (const ax of ['x', 'z']) {
      const o = ax === 'x' ? 'z' : 'x';
      const sgn = Math.abs(b[ax][1] - Lb[ax][0]) < 1e-6 ? 1 : Math.abs(b[ax][0] - Lb[ax][1]) < 1e-6 ? -1 : 0;
      if (!sgn) continue;
      const lo = Math.max(b[o][0], Lb[o][0]), hi = Math.min(b[o][1], Lb[o][1]);
      if (hi - lo < 1) continue;
      lgp.faces++;
      const entry = sgn > 0 ? b[ax][0] : b[ax][1];
      const ys = legF.map(rb);
      const clear = [];
      for (let c = lo + 0.5; c <= hi - 0.5 + 1e-9; c += 0.125) if (ys.every((y) => !onPlate(ax, entry, c, y))) clear.push(c);
      if (!clear.length) continue;
      const cols = clear[clear.length - 1] - clear[0] >= 1 ? [clear[0], clear[clear.length - 1]] : [clear[0]];
      for (const c of cols) for (const y of ys) screw('leg', ax === 'x' ? [entry, y, c] : [c, y, entry], ax === 'x' ? [sgn, 0, 0] : [0, 0, sgn], 3);
    }
  }

  // G/H — plywood deck: two full-width sheets at the outside, a strip in the middle
  const stripW = W - 2 * seam;
  const plyName = p.ply === 0.75 ? '¾″ plywood' : '⅝″ plywood';
  def('G', 'Deck panel', 'ply', seam, `${fmt(seam)} × ${fmt(L)}, one on each outside edge.`, { dims: [seam, L] });
  put('G', box(0, seam, F, D, 0, L), 4);
  put('G', box(W - seam, W, F, D, 0, L), 4);
  def('H', 'Deck center strip', 'ply', stripW, `${fmt(stripW)} × ${fmt(L)}, lies over the spine.`, { dims: [stripW, L] });
  put('H', box(seam, W - seam, F, D, 0, L), 4);

  joint('deck', 5, 'deck', 'Deck into frame',
    `Every 8″ down the center line of every rail, beam and joist, starting 1½″ from each end. The two seam joists (${fmt(seam)} and ${fmt(W - seam)}) get a row on each side of the seam, ⅜″ in from each panel edge.`);
  for (const m of ['A', 'B', 'C', 'D', 'E']) for (const pc of defs[m].pieces) {
    const b = pc.box, alongX = b.x[1] - b.x[0] > b.z[1] - b.z[0];
    const cx = (b.x[0] + b.x[1]) / 2, cz = (b.z[0] + b.z[1]) / 2;
    const [a0, a1] = alongX ? b.x : b.z;
    const n = Math.max(1, Math.round((a1 - a0 - 3) / 8));
    const offs = m === 'E' && [seam, W - seam].some((sx) => Math.abs(cx - sx) < 0.01) ? [-0.375, 0.375] : [0];
    for (let i = 0; i <= n; i++) {
      const a = a0 + 1.5 + (i * (a1 - a0 - 3)) / n;
      for (const o of offs) screw('deck', alongX ? [a, D, cz + o] : [cx + o, D, a], [0, -1, 0], 1.625);
    }
  }

  // L/P — raised lip: 1× boards on the outside faces of the rails, standing proud of the deck
  let lipT = 0, lipBoard = null;
  if (p.lip > 0) {
    const need = p.ply + p.lip + LIP_OVERLAP;
    lipBoard = LIP_BOARDS.find((b) => LUMBER[b].w >= need) || LIP_BOARDS[LIP_BOARDS.length - 1];
    if (LUMBER[lipBoard].w < need) warnings.push(`A ${fmt(p.lip)} lip is taller than a 1×8 can cover and still lap ${fmt(LIP_OVERLAP)} onto the rail. Lower the lip height.`);
    lipT = LUMBER[lipBoard].t;
    const top = D + p.lip, bot = top - LUMBER[lipBoard].w;
    const lb = lipBoard.replace('x', '×');
    def('L', 'Lip, head / foot', lipBoard, W + 2 * lipT, `Overlaps the ends of the side lips. Top edge sits ${fmt(p.lip)} above the deck.`);
    put('L', box(-lipT, W + lipT, bot, top, -lipT, 0), 1);
    put('L', box(-lipT, W + lipT, bot, top, L, L + lipT), 1);
    def('P', 'Lip, side', lipBoard, L, `${lb} screwed to the outside of the side rail, flush with the head and foot rails.`);
    put('P', box(-lipT, 0, bot, top, 0, L), 1);
    put('P', box(W, W + lipT, bot, top, 0, L), 1);

    const ov = F - bot;
    const ys = ov >= 1.6 ? [F - 0.55, bot + 0.55] : [(F + bot) / 2];
    joint('lip', 6, 'trim', 'Lip (L/P) into rail',
      `Pairs every 16″, starting 2″ from each end, ${ys.map((y) => fmt(top - y)).join(' and ')} down from the lip's top edge (that's into the rail, below the deck). Nudge a pair over if it lands on a structural screw head.`);
    const heads = fast.filter((f) => f.type === 'struct');
    const lipRun = (face, ax, dir, a0, a1, railFace) => {
      const n = Math.max(1, Math.ceil((a1 - a0 - 4) / 16));
      for (let i = 0; i <= n; i++) {
        const base = a0 + 2 + (i * (a1 - a0 - 4)) / n;
        const ni = ax === 'x' ? 0 : 2, ai = ax === 'x' ? 2 : 0;
        const hit = (v) => heads.some((h) => Math.abs(h.p[ni] - railFace) < 0.01 && ys.some((y) => Math.hypot(h.p[ai] - v, h.p[1] - y) < 1));
        const a = [base, base + 1.5, base - 1.5, base + 3].find((v) => !hit(v)) ?? base;
        for (const y of ys) screw('lip', ax === 'x' ? [face, y, a] : [a, y, face], dir, 1.625);
      }
    };
    lipRun(-lipT, 'z', [0, 0, 1], -lipT, W + lipT, 0);
    lipRun(L + lipT, 'z', [0, 0, -1], -lipT, W + lipT, L);
    lipRun(-lipT, 'x', [1, 0, 0], 0, L, 0);
    lipRun(W + lipT, 'x', [-1, 0, 0], 0, L, W);
  }

  // S/T/U — dog step: a small plywood box, freestanding against the bed
  let step = null;
  if (p.step) {
    const sH = p.stepH, sW = p.stepW, sD = p.stepD, pt = p.ply;
    if (sH < 6 || sH > p.target - 6) warnings.push(`A ${fmt(sH)} step is awkward with a ${fmt(p.target)} bed. Something near half the bed height (${fmt(p.target / 2)}) splits the jump evenly.`);
    if (sD < 2 * pt + 4 || sW < 3 * pt + 8) warnings.push('The step is too small to build as a box.');
    const off = lipT + STEP_GAP;
    const toWorld = (u0, u1, y0, y1, v0, v1) => {
      if (p.stepLoc === 'left') return box(-off - v1, -off - v0, y0, y1, L / 2 - sW / 2 + u0, L / 2 - sW / 2 + u1);
      if (p.stepLoc === 'right') return box(W + off + v0, W + off + v1, y0, y1, L / 2 - sW / 2 + u0, L / 2 - sW / 2 + u1);
      return box(W / 2 - sW / 2 + u0, W / 2 - sW / 2 + u1, y0, y1, L + off + v0, L + off + v1);
    };
    const inner = sH - pt, endD = sD - 2 * pt;
    def('S', 'Step top', 'ply', sW, `${fmt(sW)} × ${fmt(sD)}. Cover it with a non-slip carpet tread.`, { dims: [sW, sD] });
    put('S', toWorld(0, sW, inner, sH, 0, sD), 0);
    def('T', 'Step front / back', 'ply', sW, `${fmt(sW)} × ${fmt(inner)}. Runs the full width under the top.`, { dims: [sW, inner] });
    put('T', toWorld(0, sW, 0, inner, 0, pt), 0);
    put('T', toWorld(0, sW, 0, inner, sD - pt, sD), 0);
    def('U', 'Step end / divider', 'ply', endD, `${fmt(endD)} × ${fmt(inner)}. Two ends plus one center divider, between the front and back.`, { dims: [endD, inner] });
    for (const u of [0, sW / 2 - pt / 2, sW - pt]) put('U', toWorld(u, u + pt, 0, inner, pt, sD - pt), 0);
    step = { h: sH, w: sW, d: sD, loc: p.stepLoc };

    const pnt = (u, y, v) => { const b = toWorld(u, u, y, y, v, v); return [b.x[0], y, b.z[0]]; };
    const dirW = (du, dv) => (p.stepLoc === 'left' ? [-dv, 0, du] : p.stepLoc === 'right' ? [dv, 0, du] : [du, 0, dv]);
    const uCenters = [pt / 2, sW / 2, sW - pt / 2];
    joint('stepTop', 8, 'step', 'Step top (S) into front/back and ends',
      `Glue first. Then screw every 6″ or so along the front and back, and 3 into each end and the divider, ${fmt(pt / 2)} in from the edge so each one lands centered on the piece below.`);
    const nA = Math.max(1, Math.ceil((sW - 3) / 6));
    for (let i = 0; i <= nA; i++) for (const v of [pt / 2, sD - pt / 2]) screw('stepTop', pnt(1.5 + (i * (sW - 3)) / nA, sH, v), [0, -1, 0], 1.625);
    for (const u of uCenters) for (const f of [0.25, 0.5, 0.75]) screw('stepTop', pnt(u, sH, pt + (sD - 2 * pt) * f), [0, -1, 0], 1.625);
    const sy = [0.2, 0.5, 0.8];
    joint('stepBox', 8, 'step', 'Step front/back (T) into ends and divider (U)',
      `Glue, then 3 per joint through the front and back into each end and the divider: centered on it, at ${sy.map((f) => fmt(inner * f)).join(', ')} up from the bottom.`);
    for (const u of uCenters) for (const f of sy) {
      screw('stepBox', pnt(u, inner * f, 0), dirW(0, 1), 1.625);
      screw('stepBox', pnt(u, inner * f, sD), dirW(0, -1), 1.625);
    }
  }

  const mattresses = [
    box(p.clear, p.clear + QUEEN.w, D, D + p.mattT, p.clear, p.clear + QUEEN.l),
    box(p.clear + QUEEN.w, p.clear + 2 * QUEEN.w, D, D + p.mattT, p.clear, p.clear + QUEEN.l),
  ];

  // lumber packing per stock type
  const lumberCuts = {};
  for (const d of Object.values(defs)) {
    if (d.stock === 'ply') continue;
    (lumberCuts[d.stock] ||= []).push(...d.pieces.map(() => ({ mark: d.mark, len: d.len })));
  }
  const boards = {};
  for (const [stock, cuts] of Object.entries(lumberCuts)) boards[stock] = pack(cuts, STOCK_LENGTHS[stock] || STOCK_LENGTHS.default);

  // plywood: deck pieces are full-length strips across each sheet; the step is nested into the offcuts
  const sheets = [];
  const deckPieces = [];
  for (const m of ['G', 'H']) for (const _ of defs[m].pieces) deckPieces.push({ mark: m, w: defs[m].dims[0], l: L });
  deckPieces.sort((a, b) => b.w - a.w);
  for (const pc of deckPieces) {
    let s = sheets.find((s) => s.used + pc.w <= SHEET.w + 1e-9);
    if (!s) { s = { pieces: [], used: 0 }; sheets.push(s); }
    s.pieces.push({ ...pc, x: s.used, y: 0 });
    s.used += pc.w + KERF;
  }
  for (const s of sheets) {
    s.free = [
      { x: s.used, y: 0, w: SHEET.w - s.used, h: SHEET.l },
      { x: 0, y: L + KERF, w: Math.min(s.used, SHEET.w), h: SHEET.l - L - KERF },
    ].filter((f) => f.w > 0.5 && f.h > 0.5);
  }
  const extra = [];
  for (const m of ['S', 'T', 'U']) if (defs[m]) for (const _ of defs[m].pieces) extra.push({ mark: m, w: defs[m].dims[0], l: defs[m].dims[1] });
  extra.sort((a, b) => b.w * b.l - a.w * a.l);
  for (const pc of extra) {
    if (!nest(sheets, pc)) {
      sheets.push({ pieces: [], used: 0, free: [{ x: 0, y: 0, w: SHEET.w, h: SHEET.l }] });
      if (!nest(sheets, pc)) warnings.push(`Step piece ${pc.mark} is bigger than a 4×8 sheet.`);
    }
  }
  if (L > SHEET.l) warnings.push('The deck is longer than a 96″ sheet, so the plywood layout needs an extra seam.');

  // hardware
  const legs = defs.F.pieces;
  const hw = [
    { id: 'screw3', item: '3″ structural wood screws', spec: 'e.g. GRK RSS or Spax PowerLag, ¼″ × 3″', qty: fast.filter((f) => f.type === 'struct').length,
      note: '4 per leg face, 3 per butt joint' },
    { id: 'hanger24', item: '2×4 face-mount joist hangers', spec: 'Simpson LUS24 or LU24', qty: joints.joistHanger.count, note: 'Both ends of each joist' },
    { id: 'hangerBig', item: `${p.rail.replace('x', '×')} face-mount joist hangers`, spec: `Simpson LUS${p.rail.replace('2x', '2')}`, qty: 2,
      note: 'Mid-beam halves where they meet the spine' },
    { id: 'sd9', item: 'Connector screws for hangers', spec: 'Simpson SD9112 (#9 × 1½″)', qty: joints.joistHanger.count * 6 + joints.beamHanger.count * 10,
      note: 'About 6 per 2×4 hanger and 10 per large hanger' },
    { id: 'deck', item: '1⅝″ construction screws', spec: 'for the plywood deck', qty: joints.deck.count,
      note: 'Every 8″ along every member under the deck' },
    { id: 'pad', item: 'Felt or rubber furniture pads', spec: '3½″ square', qty: legs.length, note: 'One per leg' },
  ];
  if (lipBoard) hw.push({ id: 'trim', item: '1⅝″ trim-head screws', spec: 'for the lip boards', qty: joints.lip.count,
    note: 'Two every 16″ into the rails, below the deck line' });
  if (step) {
    hw.push(
      { id: 'stepScrew', item: '1⅝″ construction screws', spec: 'for the step box (same screws as the deck)', qty: joints.stepTop.count + joints.stepBox.count, note: 'Every 6″ through the top, 3 per end/divider joint' },
      { id: 'glue', item: 'Wood glue', spec: '8 oz bottle', qty: 1, note: 'Glue every step joint too. The step stays assembled' },
      { id: 'tread', item: 'Non-slip carpet stair tread', spec: `at least ${fmt(step.w)} × ${fmt(step.d)}`, qty: 1, note: 'Traction for paws. Glue or staple it on' },
      { id: 'stepPad', item: 'Rubber non-slip pads', spec: 'for the step feet', qty: 4, note: 'Keeps the step from skating when the dog launches' },
    );
  }

  const all = Object.values(defs).flatMap((d) => d.pieces.map((pc) => pc.box));
  const bounds = {
    x: [Math.min(...all.map((b) => b.x[0])), Math.max(...all.map((b) => b.x[1]))],
    z: [Math.min(...all.map((b) => b.z[0])), Math.max(...all.map((b) => b.z[1]))],
  };

  return { p, W, L, H, Lh, D, F, rh, yR0, t, defs, joistX, leftX, mattresses, boards, sheets, hw, warnings,
    plyName, legs, floorGap: yR0, diag: Math.hypot(W, L), gx, lipT, lipBoard, step, bounds,
    OW: W + 2 * lipT, OL: L + 2 * lipT, fast, hangers, joints };
}

// Guillotine-nest one piece into the free rectangles of existing sheets (either rotation).
function nest(sheets, pc) {
  for (const s of sheets) {
    for (let i = 0; i < s.free.length; i++) {
      const r = s.free[i];
      for (const [w, h] of [[pc.w, pc.l], [pc.l, pc.w]]) {
        if (w > r.w + 1e-9 || h > r.h + 1e-9) continue;
        s.pieces.push({ ...pc, x: r.x, y: r.y, w, l: h });
        s.free.splice(i, 1,
          { x: r.x + w + KERF, y: r.y, w: r.w - w - KERF, h },
          { x: r.x, y: r.y + h + KERF, w: r.w, h: r.h - h - KERF });
        s.free = s.free.filter((f) => f.w > 0.5 && f.h > 0.5);
        return true;
      }
    }
  }
  return false;
}

function pack(cuts, stocks) {
  let best = null;
  for (const pref of stocks) {
    const boards = [];
    const sorted = [...cuts].sort((a, b) => b.len - a.len);
    let ok = true;
    for (const c of sorted) {
      let b = boards.find((b) => b.rem >= c.len);
      if (!b) {
        const len = stocks.find((s) => s >= Math.max(pref, c.len)) ?? stocks.find((s) => s >= c.len);
        if (!len) { ok = false; break; }
        b = { len, cuts: [], rem: len };
        boards.push(b);
      }
      b.cuts.push(c); b.rem -= c.len + KERF;
    }
    if (!ok) continue;
    const total = boards.reduce((a, b) => a + b.len, 0);
    if (!best || total < best.total - 1e-6 || (Math.abs(total - best.total) < 1e-6 && boards.length < best.boards.length))
      best = { boards, total };
  }
  return best ? best.boards : [];
}

// ---------- prices (per-viewer convenience) ----------
let prices = { ...DEFAULT_PRICES };
try { Object.assign(prices, JSON.parse(localStorage.getItem('bedPrices') || '{}')); } catch {}
const savePrices = () => { try { localStorage.setItem('bedPrices', JSON.stringify(prices)); } catch {} };

// ---------- DOM rendering ----------
function renderStats(d, cost) {
  const boards = Object.values(d.boards).reduce((a, b) => a + b.length, 0);
  const items = [
    [fmt(d.p.target), 'Mattress top'], [fmt(d.D), 'Deck height'],
    [`${fmt(d.OW)} × ${fmt(d.OL)}`, 'Footprint'], [fmt(d.floorGap), 'Under-rail clearance'],
    ...(d.step ? [[fmt(d.step.h), 'Dog step']] : []),
    [`${boards} + ${d.sheets.length}`, 'Boards + sheets'], [`~$${Math.round(cost)}`, 'Materials (rough)'],
  ];
  $('#stats').innerHTML = items.map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
}

function markChip(m) { return `<span class="mark" style="background:${COLORS[m]}">${m}</span>`; }

function renderCuts(d) {
  const rows = Object.values(d.defs).map((x) => {
    const stock = x.stock === 'ply' ? d.plyName : x.stock.replace('x', '×');
    const len = x.dims ? `${fmt(x.dims[0])} × ${fmt(x.dims[1])}` : fmt(x.len);
    return `<tr data-mark="${x.mark}"><td>${markChip(x.mark)}</td><td>${esc(x.name)}<div class="note">${esc(x.note)}</div></td>
      <td>${stock}</td><td class="n">${x.pieces.length}</td><td class="n">${len}</td></tr>`;
  });
  $('#cutTable').innerHTML = `<thead><tr><th>Mark</th><th>Part</th><th>Stock</th><th>Qty</th><th>Length</th></tr></thead><tbody>${rows.join('')}</tbody>`;
  $('#cutTable').querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('mouseenter', () => { highlight(tr.dataset.mark); tr.classList.add('hl'); });
    tr.addEventListener('mouseleave', () => { highlight(null); tr.classList.remove('hl'); });
  });
}

function buyRows(d) {
  const rows = [];
  for (const [stock, boards] of Object.entries(d.boards)) {
    const byLen = {};
    boards.forEach((b) => (byLen[b.len] = (byLen[b.len] || 0) + 1));
    for (const [len, qty] of Object.entries(byLen))
      rows.push({ key: stock, item: `${stock.replace('x', '×')} ${stock[0] === '1' ? 'board' : 'lumber'}`, size: ftIn(+len), qty, unit: +len / 12, unitLabel: '/ft',
        note: stock === d.lipBoard ? 'For the lip. It\'s the visible face, so choose straight, clear select pine or poplar.' : '' });
  }
  rows.push({ key: `ply${d.p.ply}`, item: `${d.plyName} sheet`, size: '4′ × 8′', qty: d.sheets.length, unit: 1, unitLabel: '/sheet',
    note: `Sanded pine or birch ply (BC or better) keeps splinters out of the mattress cover.${d.step ? ' The step is cut from the deck offcuts.' : ''}` });
  for (const h of d.hw) rows.push({ key: h.id, item: h.item, size: h.spec, qty: h.qty, unit: 1, unitLabel: '/ea', hw: true, note: h.note });
  return rows;
}

function renderBuy(d) {
  const rows = buyRows(d);
  const lumber = rows.filter((r) => !r.hw), hw = rows.filter((r) => r.hw);
  const row = (r, i) => `<tr><td>${esc(r.item)}${r.note && !r.hw ? `<div class="note">${esc(r.note)}</div>` : ''}</td><td class="n">${esc(r.size)}</td>
    <td class="n">${r.qty}</td>
    <td class="n"><input class="price" type="number" step="0.01" min="0" data-key="${r.key}" value="${prices[r.key] ?? 0}"> <span class="note">${r.unitLabel}</span></td>
    <td class="n" data-sub="${i}"></td></tr>`;
  const hwRow = (r, i) => `<tr><td>${esc(r.item)}<div class="note">${esc(r.size)}</div></td><td class="n">${r.qty}</td><td class="note">${esc(r.note)}</td>
    <td class="n"><input class="price" type="number" step="0.01" min="0" data-key="${r.key}" value="${prices[r.key] ?? 0}"> <span class="note">/ea</span></td>
    <td class="n" data-sub="${i}"></td></tr>`;
  $('#buyTable').innerHTML = `<thead><tr><th>Item</th><th>Size</th><th>Qty</th><th>Unit price</th><th>Subtotal</th></tr></thead>
    <tbody>${lumber.map((r, i) => row(r, i)).join('')}</tbody><tfoot><tr><td colspan="4">Lumber &amp; plywood</td><td class="n" id="sumL"></td></tr></tfoot>`;
  $('#hwTable').innerHTML = `<thead><tr><th>Item</th><th>Qty</th><th>Why</th><th>Unit price</th><th>Subtotal</th></tr></thead>
    <tbody>${hw.map((r, i) => hwRow(r, i + lumber.length)).join('')}</tbody>
    <tfoot><tr><td colspan="4">Hardware</td><td class="n" id="sumH"></td></tr><tr><td colspan="4">Estimated total</td><td class="n" id="sumT"></td></tr></tfoot>`;

  const update = () => {
    let sL = 0, sH = 0;
    rows.forEach((r, i) => {
      const sub = r.qty * r.unit * (prices[r.key] ?? 0);
      document.querySelector(`[data-sub="${i}"]`).textContent = money(sub);
      if (r.hw) sH += sub; else sL += sub;
    });
    $('#sumL').textContent = money(sL); $('#sumH').textContent = money(sH); $('#sumT').textContent = money(sL + sH);
    renderStats(d, sL + sH);
  };
  document.querySelectorAll('.price').forEach((inp) => inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    prices[inp.dataset.key] = Number.isFinite(v) ? v : 0;
    savePrices(); update();
  }));
  update();

  // cutting diagrams
  const out = [];
  for (const [stock, boards] of Object.entries(d.boards)) {
    boards.forEach((b, i) => {
      let x = 0;
      const segs = b.cuts.map((c) => {
        const s = `<span style="left:${(x / b.len) * 100}%;width:${(c.len / b.len) * 100}%;background:${COLORS[c.mark]}" title="${c.mark} · ${fmt(c.len)}">${c.mark} ${fmt(c.len)}</span>`;
        x += c.len + KERF;
        return s;
      }).join('');
      out.push(`<div class="board"><div class="lbl">${stock.replace('x', '×')} ${ftIn(b.len)} #${i + 1}</div><div class="bar">${segs}</div></div>`);
    });
  }
  $('#boards').innerHTML = out.join('');
}

function renderSteps(d) {
  const r = d.p.rail.replace('x', '×');
  const lb = d.lipBoard?.replace('x', '×');
  const where = { foot: 'centered against the foot of the bed', left: 'against the left side, halfway along', right: 'against the right side, halfway along' };
  const steps = [
    ['Confirm the numbers.', `Measure the mattress thickness and both queen mattresses (they're usually 60″ × 80″, but check). Enter the thickness above. With ${fmt(d.p.mattT)}, the deck top has to sit at ${fmt(d.D)}.`],
    ['Cut and label.', `Cut every piece on the cut list and write its letter on it. Check that the cuts on each pair or set match exactly: A, B, C, D, all ${d.defs.E.pieces.length} E joists and all ${d.legs.length} legs.${d.step ? ' Cut the step pieces (S, T, U) from the plywood offcuts, following the sheet diagram.' : ''} Ease the edges and sand any faces you'll see.${lb ? ` Stain or seal the ${lb} lip boards now if you want a finish.` : ''}`],
    ['Build the perimeter upside down.', `In the bedroom, lay the four ${r} rails top-edge-down on a flat floor, with the head and foot rails (A) overlapping the ends of the side rails (B). Screw through A into B, three screws per joint. Because the frame is upside down, the floor keeps every top edge flush.`],
    ['Add the spine and mid beam.', `Center the spine (C) ${fmt(d.H)} from the outside edge and screw through A into its ends. Mark mid-length (${fmt(d.Lh)}). Screw each mid-beam half (D) through the side rail, then hang its other end on the spine with a ${r} hanger.`],
    ['Stand the legs in.', `Still upside down, set each 4×4 leg (F) into its spot with its end on the floor, so the top stays flush. Put one in each corner, one beside the spine at the head and at the foot, one beside the mid beam on each side rail, one at the center crossing, and one under each mid-beam half about ${fmt(d.gx)} from the side. Screw 4 screws through each face it touches.`],
    ['Hang the joists.', `Nail up the 2×4 hangers so the joist tops sit flush with the rails. Joist centers from the left edge: ${d.leftX.map(fmt).join(', ')}, then mirror them from the right edge. The joists at ${fmt(48)} and ${fmt(d.W - 48)} carry the plywood seams, so place those two carefully.`],
    ['Flip, square, level.', `Turn the frame over (you'll want two people). Measure both diagonals, which should each be about ${fmt(d.diag)}, and push the frame until they match. Check for level and shim any leg that rocks. Stick a pad under each leg.`],
    ['Lay the deck.', `Put the two 48″ panels (G) on the outside edges and the ${fmt(d.W - 96)} strip (H) in the middle. Drive 1⅝″ screws every 8″ into every member underneath.`],
  ];
  if (d.lipBoard) steps.push(['Add the lip.', `Screw the side lips (P) to the outside faces of the side rails, with the top edge ${fmt(d.p.lip)} above the deck. Then run the head and foot lips (L) across the ends so they cover the ends of P. Put two trim screws every 16″, going into the rail below the deck line. Round over or sand the top edges, since that edge is right at shin height.`]);
  steps.push(['Mattresses on.', `Set the two queens side by side. There's ${fmt(d.p.clear)} of deck showing around them${d.lipBoard ? ', inside the lip' : ''}. Add a bed bridge and connector strap across the seam, then check the top height, which should be about ${fmt(d.p.target)} before it settles.`]);
  if (d.step) steps.push(['Build the dog step.', `Glue and screw the front and back (T) to the two ends and the center divider (U), then glue and screw the top (S) on. Round every edge, glue on the carpet tread, stick the rubber pads underneath, and set it ${where[d.step.loc]}. It's ${fmt(d.step.h)} high, so the dog makes two jumps of about ${fmt(d.step.h)} each instead of one ${fmt(d.p.target)} jump.`]);
  const stageOf = { 'Build the perimeter upside down.': 1, 'Add the spine and mid beam.': 2, 'Stand the legs in.': 3, 'Hang the joists.': 4,
    'Lay the deck.': 5, 'Add the lip.': 6, 'Mattresses on.': 7, 'Build the dog step.': 8 };
  stageList = [];
  $('#stepList').innerHTML = steps.map(([h, b]) => {
    const st = stageOf[h];
    if (!st) return `<li><strong>${h}</strong>${b}</li>`;
    stageList.push({ stage: st, title: h.replace(/\.$/, '') });
    const js = Object.values(d.joints).filter((j) => j.stage === st && j.count);
    const fx = js.length ? `<ul class="fx">${js.map((j) => `<li><i style="background:${FASTENER_TYPES[j.type].color}"></i><b>${esc(j.title)}</b>
      <span class="n">× ${j.count}</span> <button class="zoom" data-joint="${j.key}">Zoom to one</button><div>${esc(j.where)}</div></li>`).join('')}</ul>` : '';
    return `<li><strong>${h}</strong>${b}${fx}<button class="show3d" data-stage="${st}">Show in 3D</button></li>`;
  }).join('');
  $('#stepList').querySelectorAll('.zoom').forEach((btn) => btn.addEventListener('click', () => {
    focusJoint(btn.dataset.joint);
    $('#render').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#stepList').querySelectorAll('.show3d').forEach((btn) => btn.addEventListener('click', () => {
    setStage(+btn.dataset.stage);
    $('#render').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// ---------- SVG drawings ----------
const SVG_INK = 'stroke:var(--ink);';
function rect(x, y, w, h, fill, extra = '') {
  return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0, w).toFixed(2)}" height="${Math.max(0, h).toFixed(2)}" fill="${fill}" style="${SVG_INK}stroke-width:.8" ${extra}/>`;
}
function dimH(x0, x1, y, label, tick = 5) {
  return `<g class="dim"><line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/><line x1="${x0}" y1="${y - tick}" x2="${x0}" y2="${y + tick}"/><line x1="${x1}" y1="${y - tick}" x2="${x1}" y2="${y + tick}"/></g>
    <text class="dimtxt" x="${(x0 + x1) / 2}" y="${y - 6}" text-anchor="middle">${label}</text>`;
}
function dimV(x, y0, y1, label, side = 1, tick = 5) {
  const tx = x + side * 8;
  return `<g class="dim"><line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}"/><line x1="${x - tick}" y1="${y0}" x2="${x + tick}" y2="${y0}"/><line x1="${x - tick}" y1="${y1}" x2="${x + tick}" y2="${y1}"/></g>
    <text class="dimtxt" x="${tx}" y="${(y0 + y1) / 2 + 4}" text-anchor="${side > 0 ? 'start' : 'end'}">${label}</text>`;
}

function stepBox(d) {
  const bs = ['S', 'T', 'U'].flatMap((m) => d.defs[m]?.pieces.map((p) => p.box) || []);
  if (!bs.length) return null;
  return {
    x: [Math.min(...bs.map((b) => b.x[0])), Math.max(...bs.map((b) => b.x[1]))],
    z: [Math.min(...bs.map((b) => b.z[0])), Math.max(...bs.map((b) => b.z[1]))],
  };
}

function drawStack(d) {
  const s = 4.4, top = d.p.target, mx = Math.max(29, top + d.p.lip + 2);
  const Hh = mx * s + 70, floorY = mx * s + 34;
  const Y = (inch) => floorY - inch * s;
  const bars = [['Now', 29], ['On floor', 19], ['New', top]];
  if (d.step) bars.push(['Step', d.step.h]);
  const bx = 40 + bars.length * 70, minX = d.bounds.x[0], maxX = d.bounds.x[1];
  const X = (inch) => bx + (inch - minX) * s;
  let g = '';
  bars.forEach(([lbl, h], i) => {
    const x = 20 + i * 70, c = i === 2 ? COLORS.C : i === 3 ? COLORS.S : '#9a8f82';
    g += `<rect x="${x}" y="${Y(h)}" width="44" height="${h * s}" rx="4" fill="${c}" opacity="${i >= 2 ? 1 : .55}"/>`;
    g += `<text x="${x + 22}" y="${Y(h) - 6}" text-anchor="middle" class="mono" font-size="13" font-weight="600">${fmt(h)}</text>`;
    g += `<text x="${x + 22}" y="${floorY + 18}" text-anchor="middle" font-size="12">${lbl}</text>`;
  });
  // legs visible below the foot rail (back legs lighter)
  for (const l of d.legs) {
    const front = l.box.z[1] > d.L - 6;
    g += rect(X(l.box.x[0]), Y(d.yR0), (l.box.x[1] - l.box.x[0]) * s, d.yR0 * s, COLORS.F, `opacity="${front ? 1 : .45}"`);
  }
  g += rect(X(0), Y(d.F), d.W * s, (d.F - d.yR0) * s, COLORS.A);
  g += rect(X(0), Y(d.D), d.W * s, (d.D - d.F) * s, COLORS.G);
  for (const m of d.mattresses) g += `<rect x="${X(m.x[0]) + 1}" y="${Y(m.y[1])}" width="${(m.x[1] - m.x[0]) * s - 2}" height="${(m.y[1] - m.y[0]) * s}" rx="8" fill="${COLORS.M}" style="${SVG_INK}stroke-width:.8"/>`;
  g += `<text x="${X(d.W / 4)}" y="${Y(d.D + d.p.mattT / 2) + 4}" text-anchor="middle" font-size="12">Queen</text><text x="${X(3 * d.W / 4)}" y="${Y(d.D + d.p.mattT / 2) + 4}" text-anchor="middle" font-size="12">Queen</text>`;
  const labelX = d.step?.loc === 'foot' ? (d.W / 2 - d.step.w / 2) / 2 : d.W / 2; // keep labels clear of a foot step
  const railLabelY = d.lipBoard ? (d.defs.L.pieces[0].box.y[0] + d.yR0) / 2 : (d.F + d.yR0) / 2;
  if (d.lipBoard) {
    const lb = d.defs.L.pieces[0].box;
    g += rect(X(lb.x[0]), Y(lb.y[1]), (lb.x[1] - lb.x[0]) * s, (lb.y[1] - lb.y[0]) * s, COLORS.L);
    g += `<text x="${X(labelX)}" y="${Y((lb.y[0] + lb.y[1]) / 2) + 4}" text-anchor="middle" font-size="11" font-weight="600" style="fill:#fff">L · lip (${d.lipBoard.replace('x', '×')})</text>`;
  }
  g += `<text x="${X(labelX)}" y="${Y(railLabelY) + 4}" text-anchor="middle" font-size="12" font-weight="600">A · foot rail (${d.p.rail.replace('x', '×')})</text>`;
  const sb = stepBox(d);
  if (sb) {
    const h = d.step.h, pt = d.p.ply;
    g += rect(X(sb.x[0]), Y(h - pt), (sb.x[1] - sb.x[0]) * s, (h - pt) * s, COLORS.T);
    g += rect(X(sb.x[0]), Y(h), (sb.x[1] - sb.x[0]) * s, pt * s, COLORS.S);
    g += `<text x="${X((sb.x[0] + sb.x[1]) / 2)}" y="${Y(h / 2) + 4}" text-anchor="middle" font-size="11" font-weight="600" style="fill:#fff">Step ${fmt(h)}</text>`;
  }
  g += `<line x1="${X(minX - 4)}" y1="${Y(top)}" x2="${X(maxX + 4)}" y2="${Y(top)}" stroke="${COLORS.C}" stroke-dasharray="5 4" stroke-width="1.5"/>`;
  g += `<line x1="10" y1="${floorY}" x2="${X(maxX) + 290}" y2="${floorY}" style="${SVG_INK}stroke-width:1.5"/>`;
  // dims on the right
  const dx = X(maxX) + 24;
  if (d.yR0 > 0) g += dimV(dx, Y(d.yR0), Y(0), `${fmt(d.yR0)} clear`);
  g += dimV(dx, Y(d.F), Y(d.yR0), `${fmt(d.F - d.yR0)} rail`);
  g += dimV(dx + 110, Y(d.D), Y(0), `${fmt(d.D)} deck`);
  if (d.lipBoard) g += dimV(dx + 110, Y(d.D + d.p.lip), Y(d.D), `${fmt(d.p.lip)} lip`);
  g += dimV(dx, Y(top), Y(d.D), `${fmt(d.p.mattT)} mattress`);
  g += dimV(dx + 200, Y(top), Y(0), `${fmt(top)} top`);
  const vbW = X(maxX) + 300;
  $('#svgStack').innerHTML = `<svg viewBox="0 0 ${vbW} ${Hh}" role="img" aria-label="Height stack elevation">${g}</svg>`;
}

function drawPlan(d) {
  const s = 7, mL = 80, mT = 100, minX = d.bounds.x[0], maxX = d.bounds.x[1], minZ = d.bounds.z[0], maxZ = d.bounds.z[1];
  const X = (x) => mL + (x - minX) * s, Z = (z) => mT + (z - minZ) * s;
  let g = '';
  const r2 = (b, c, op = 1) => rect(X(b.x[0]), Z(b.z[0]), (b.x[1] - b.x[0]) * s, (b.z[1] - b.z[0]) * s, c, `opacity="${op}"`);
  g += `<rect x="${X(0)}" y="${Z(0)}" width="${d.W * s}" height="${d.L * s}" fill="none" style="stroke:var(--line)"/>`;
  for (const m of ['E', 'D', 'C', 'B', 'A', 'P', 'L']) for (const pc of d.defs[m]?.pieces || []) g += r2(pc.box, COLORS[m]);
  for (const pc of d.defs.F.pieces) g += r2(pc.box, COLORS.F, 0.9);
  for (const pc of d.defs.S?.pieces || []) g += r2(pc.box, COLORS.S);
  // plywood seam lines
  for (const x of [48, d.W - 48]) g += `<line x1="${X(x)}" y1="${Z(0) - 8}" x2="${X(x)}" y2="${Z(d.L) + 8}" stroke="${COLORS.C}" stroke-dasharray="6 5" stroke-width="1.2"/>`;
  // labels
  const lab = (x, z, m) => `<circle cx="${X(x)}" cy="${Z(z)}" r="11" fill="${COLORS[m]}" style="${SVG_INK}stroke-width:.8"/><text x="${X(x)}" y="${Z(z) + 4.5}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" style="fill:#fff">${m}</text>`;
  g += lab(d.W / 4, 0.75, 'A') + lab(d.W / 4, d.L - 0.75, 'A') + lab(0.75, d.L / 4, 'B') + lab(d.W - 0.75, d.L / 4, 'B');
  g += lab(d.H, d.L / 4, 'C') + lab(d.W * 0.36, d.Lh, 'D') + lab(d.joistX[1], d.L * 0.18, 'E') + lab(3.25, 3.25, 'F');
  if (d.lipBoard) g += lab(d.W * 0.8, d.L + d.lipT / 2, 'L') + lab(d.W + d.lipT / 2, d.L * 0.8, 'P');
  const sb = stepBox(d);
  if (sb) {
    const cx = (sb.x[0] + sb.x[1]) / 2, cz = (sb.z[0] + sb.z[1]) / 2;
    g += lab(cx, cz, 'S');
    g += `<text x="${X(cx)}" y="${Z(cz) + 26}" text-anchor="middle" font-size="11" font-weight="600">Dog step</text>`;
  }
  // top: head label, overall width, joist centers
  const yj = Z(minZ) - 14, yw = Z(minZ) - 44;
  g += `<text x="${X(d.W / 2)}" y="${Z(minZ) - 72}" text-anchor="middle" font-size="12" font-weight="600">HEAD</text>`;
  g += dimH(X(0), X(d.W), yw, d.lipBoard ? `${fmt(d.W)} frame · ${fmt(d.OW)} over lip` : fmt(d.W));
  let prev = 0;
  for (const x of [...d.leftX, d.H]) { g += dimH(X(prev), X(x), yj, fmt(x - prev), 4); prev = x; }
  g += `<text class="dimtxt" x="${X(d.H) + 10}" y="${yj + 4}">← joist centers (mirror on the right)</text>`;
  g += dimV(X(minX) - 18, Z(0), Z(d.L), fmt(d.L), -1);
  g += dimV(X(maxX) + 18, Z(0), Z(d.Lh), `${fmt(d.Lh)} to beam ℄`);
  g += `<text class="dimtxt" x="${X(48)}" y="${Z(0) + 20}" text-anchor="middle" style="fill:${COLORS.C}">seam</text><text class="dimtxt" x="${X(d.W - 48)}" y="${Z(0) + 20}" text-anchor="middle" style="fill:${COLORS.C}">seam</text>`;
  g += `<text x="${X(d.W / 2)}" y="${Z(maxZ) + 30}" text-anchor="middle" font-size="12" font-weight="600">FOOT</text>`;
  const vbW = X(maxX) + 170, vbH = Z(maxZ) + 46;
  $('#svgPlan').innerHTML = `<svg viewBox="0 0 ${vbW} ${vbH}" role="img" aria-label="Frame plan view">${g}</svg>`;
}

function drawPly(d) {
  const s = 3.4, m = 30;
  let g = `<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" style="stroke:var(--line)" stroke-width="3"/></pattern></defs>`;
  const deckY = 44;
  g += `<text x="${m}" y="24" font-size="13" font-weight="600">Deck (top view, head at top)</text>`;
  const plyPieces = [...d.defs.G.pieces.map((p) => ['G', p]), ...d.defs.H.pieces.map((p) => ['H', p])];
  for (const [mk, pc] of plyPieces) {
    const b = pc.box;
    g += rect(m + b.x[0] * s, deckY + b.z[0] * s, (b.x[1] - b.x[0]) * s, (b.z[1] - b.z[0]) * s, COLORS[mk]);
    g += `<text x="${m + ((b.x[0] + b.x[1]) / 2) * s}" y="${deckY + (d.L / 2) * s}" text-anchor="middle" font-size="14" font-weight="700">${mk}</text>`;
    g += `<text x="${m + ((b.x[0] + b.x[1]) / 2) * s}" y="${deckY + (d.L / 2) * s + 16}" text-anchor="middle" class="dimtxt">${fmt(b.x[1] - b.x[0])}</text>`;
  }
  for (const x of d.joistX) g += `<line x1="${m + x * s}" y1="${deckY}" x2="${m + x * s}" y2="${deckY + d.L * s}" stroke="${COLORS.C}" stroke-dasharray="3 4" opacity=".6"/>`;
  g += dimH(m, m + d.W * s, deckY + d.L * s + 22, fmt(d.W));
  // sheets
  const ss = 3.0, sx0 = m + d.W * s + 60;
  g += `<text x="${sx0}" y="24" font-size="13" font-weight="600">Cuts from ${d.sheets.length} × 4′×8′ sheets</text>`;
  d.sheets.forEach((sh, i) => {
    const x0 = sx0 + i * (SHEET.w * ss + 22), y0 = deckY;
    g += `<rect x="${x0}" y="${y0}" width="${SHEET.w * ss}" height="${SHEET.l * ss}" fill="url(#hatch)" style="${SVG_INK}stroke-width:.8"/>`;
    for (const pc of sh.pieces) {
      const px = x0 + pc.x * ss, py = y0 + pc.y * ss, pw = pc.w * ss, ph = pc.l * ss;
      g += rect(px, py, pw, ph, COLORS[pc.mark]);
      const big = pw > 64 && ph > 34;
      g += `<text x="${px + pw / 2}" y="${py + ph / 2 + (big ? 0 : 4.5)}" text-anchor="middle" font-size="13" font-weight="700">${pc.mark}</text>`;
      if (big) g += `<text x="${px + pw / 2}" y="${py + ph / 2 + 15}" text-anchor="middle" class="dimtxt">${fmt(pc.w)}×${fmt(pc.l)}</text>`;
    }
    g += `<text x="${x0 + (SHEET.w / 2) * ss}" y="${y0 + SHEET.l * ss + 18}" text-anchor="middle" class="dimtxt">Sheet ${i + 1}</text>`;
  });
  const vbW = sx0 + d.sheets.length * (SHEET.w * ss + 22) + 10;
  let vbH = deckY + Math.max(d.L * s + 34, SHEET.l * ss + 30);
  if (d.step) {
    g += `<text class="dimtxt" x="${sx0}" y="${vbH + 4}">S, T, U = dog step pieces (sizes in the cut list)</text>`;
    vbH += 16;
  }
  $('#svgPly').innerHTML = `<svg viewBox="0 0 ${vbW} ${vbH}" role="img" aria-label="Plywood layout">${g}</svg>`;
}

// ---------- 3D ----------
let renderer, scene, persp, ortho, camera, controls, root, floor, grid, dirLight;
let explodeT = 0, explodeCur = 0, currentView = 'iso', cur = null;
const mats = {}, pickables = [];
let stage = null, stageList = [];
let fxGeo = null;
const fxMats = {};
const EXPLODE = [0, 12, 24, 38, 58, 82];

function init3d() {
  const el = $('#viewer');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.prepend(renderer.domElement);

  scene = new THREE.Scene();
  persp = new THREE.PerspectiveCamera(32, 1, 1, 6000);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -6000, 6000);
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x6b5a48, 1.6));
  dirLight = new THREE.DirectionalLight(0xffffff, 2.2);
  dirLight.position.set(90, 180, 120);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  Object.assign(dirLight.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 10, far: 600 });
  dirLight.shadow.bias = -0.0005;
  scene.add(dirLight);

  floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ opacity: 0.18 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  grid = new THREE.GridHelper(480, 40, 0x9a8f82, 0x9a8f82);
  grid.material.transparent = true; grid.material.opacity = 0.18;
  scene.add(grid);

  root = new THREE.Group();
  scene.add(root);

  new ResizeObserver(resize).observe(el);
  setupPicking();
  const loop = () => {
    explodeCur += (explodeT - explodeCur) * 0.14;
    for (const m of pickables) m.position.y = m.userData.baseY + explodeCur * m.userData.ex;
    controls?.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  camera = persp;
  requestAnimationFrame(loop);
}

function build3d(d) {
  cur = d;
  for (const m of pickables) {
    if (!m.userData.shared) m.geometry.dispose();
    m.children.forEach((c) => c.geometry.dispose());
    if (m.isInstancedMesh) m.dispose();
  }
  root.clear();
  pickables.length = 0;
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x2e1f12, transparent: true, opacity: 0.4 });
  const add = (b, mark, ex, info, opts = {}) => {
    const g = new THREE.BoxGeometry(b.x[1] - b.x[0], b.y[1] - b.y[0], b.z[1] - b.z[0]);
    mats[mark] ||= new THREE.MeshStandardMaterial({ color: COLORS[mark], roughness: 0.78, metalness: 0 });
    const mesh = new THREE.Mesh(g, mats[mark]);
    const cy = (b.y[0] + b.y[1]) / 2;
    mesh.position.set((b.x[0] + b.x[1]) / 2 - d.W / 2, cy, (b.z[0] + b.z[1]) / 2 - d.L / 2);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { mark, baseY: cy, ex: EXPLODE[ex], info, group: opts.group || mark, stage: STAGE_OF[mark] ?? 0 };
    if (!opts.noEdges) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat));
    root.add(mesh);
    pickables.push(mesh);
  };
  for (const x of Object.values(d.defs)) {
    const len = x.dims ? `${fmt(x.dims[0])} × ${fmt(x.dims[1])}` : fmt(x.len);
    const stock = x.stock === 'ply' ? d.plyName : x.stock.replace('x', '×');
    for (const pc of x.pieces) add(pc.box, x.mark, pc.ex, `${x.mark} · ${x.name} · ${stock} @ ${len}`, { group: GROUP_OF[x.mark] || x.mark });
  }
  mats.M ||= new THREE.MeshStandardMaterial({ color: COLORS.M, roughness: 0.95 });
  for (const m of d.mattresses) {
    const b = { x: [m.x[0] + 0.25, m.x[1] - 0.25], y: m.y, z: m.z };
    add(b, 'M', 5, `Queen mattress · 60″ × 80″ × ${fmt(d.p.mattT)}`, { group: 'M' });
  }
  buildFasteners(d);
  applyToggles();
  setView(currentView, true);
}

function applyToggles() {
  const show = { M: $('#tMatt').checked, G: $('#tPly').checked, S: $('#tStep').checked };
  const exploded = $('#tExplode').checked, showFx = $('#tFast').checked, xray = $('#tXray').checked;
  explodeT = exploded ? 1 : 0;
  for (const m of pickables) {
    const u = m.userData;
    let vis = u.fx ? showFx && !exploded : u.group in show ? show[u.group] : true;
    if (stage != null) vis = u.fx ? u.stage === stage && !exploded : u.stage <= stage;
    m.visible = vis;
  }
  // earlier stages fade back so the parts going on now stand out; X-ray fades all the wood
  for (const [mark, mat] of Object.entries(mats)) {
    const ghost = xray || (stage != null && (STAGE_OF[mark] ?? 0) < stage);
    mat.transparent = ghost;
    mat.opacity = ghost ? (xray ? 0.3 : 0.2) : 1;
    mat.depthWrite = !ghost;
    mat.needsUpdate = true;
  }
  updateStepper();
}

function setStage(st) {
  stage = st;
  if (st != null) { $('#tExplode').checked = false; }
  applyToggles();
  if (st != null && currentView !== 'iso' && currentView !== 'under') setView('iso');
}

function updateStepper() {
  const i = stageList.findIndex((x) => x.stage === stage);
  $('#stPrev').disabled = stage == null || i <= 0;
  $('#stNext').disabled = stage != null && i >= stageList.length - 1;
  $('#stAll').textContent = stage == null ? 'Step through the build' : 'Show finished bed';
  $('#stAll').classList.toggle('on', stage != null);
  if (stage == null || !cur) {
    $('#stCap').innerHTML = 'Step through the build to see what goes on in each step, and where every screw and hanger goes. You can also turn on <b>Fasteners</b> for the finished bed.';
    return;
  }
  const js = Object.values(cur.joints).filter((j) => j.stage === stage && j.count);
  $('#stCap').innerHTML = `<b>Step ${i + 1} of ${stageList.length}: ${esc(stageList[i].title)}.</b> ` +
    (js.length ? js.map((j) => `<button class="fxk" data-joint="${j.key}" title="Zoom to one"><i style="background:${FASTENER_TYPES[j.type].color}"></i>${esc(j.title)} × ${j.count}</button>`).join(' ')
      : 'No fasteners in this step.') +
    ' <span class="note">Click a fastener to zoom to one. Fasteners are drawn slightly oversize. The model is shown right side up, but the frame is built upside down.</span>';
  $('#stCap').querySelectorAll('.fxk').forEach((b) => b.addEventListener('click', () => focusJoint(b.dataset.joint)));
}

// Fly the camera to one example of a joint, looking at it from the side its fasteners go in.
function focusJoint(key) {
  if (!cur || !renderer) return;
  const j = cur.joints[key];
  if (!j) return;
  if (stage !== j.stage) setStage(j.stage);
  setView('iso');
  const off = new THREE.Vector3(-cur.W / 2, 0, -cur.L / 2);
  const up = new THREE.Vector3(0, 1, 0);
  const view = (tgt, from) => {
    const lat = new THREE.Vector3().crossVectors(from, up);
    if (lat.lengthSq() < 0.01) lat.set(1, 0, 1);
    const pos = tgt.clone().addScaledVector(from.clone().normalize(), 26).addScaledVector(lat.normalize(), 12)
      .add(new THREE.Vector3(0, from.y > 0.5 ? 6 : 14, 0));
    return { tgt, pos };
  };
  const cands = [
    ...cur.fast.filter((x) => x.key === key).map((f) => view(new THREE.Vector3(...f.p).add(off), new THREE.Vector3(...f.dir).multiplyScalar(-1))),
    ...cur.hangers.filter((x) => x.key === key).map((h) => {
      const b = h.boxes[1];
      return view(new THREE.Vector3((b.x[0] + b.x[1]) / 2, (b.y[0] + b.y[1]) / 2, (b.z[0] + b.z[1]) / 2).add(off),
        h.axis === 'x' ? new THREE.Vector3(h.sgn, 0, 0) : new THREE.Vector3(0, 0, h.sgn));
    }),
  ];
  if (!cands.length) return;
  // prefer the example whose camera ends up farthest outside the bed, so nothing blocks the view
  const { tgt, pos } = cands.reduce((a, c) => (Math.hypot(c.pos.x, c.pos.z) > Math.hypot(a.pos.x, a.pos.z) ? c : a));
  persp.position.copy(pos);
  controls.target.copy(tgt);
  controls.update();
}

function buildFasteners(d) {
  fxGeo ||= { shaft: new THREE.CylinderGeometry(1, 1, 1, 8), head: new THREE.CylinderGeometry(1, 1, 1, 14) };
  for (const [k, ft] of Object.entries(FASTENER_TYPES))
    fxMats[k] ||= new THREE.MeshStandardMaterial({ color: ft.color, metalness: k === 'hanger' ? 0.7 : 0.35, roughness: k === 'hanger' ? 0.35 : 0.45 });
  const Y = new THREE.Vector3(0, 1, 0), m4 = new THREE.Matrix4(), off = new THREE.Vector3(-d.W / 2, 0, -d.L / 2);
  const groups = {};
  for (const f of d.fast) (groups[`${f.type}|${f.stage}`] ||= []).push(f);
  for (const list of Object.values(groups)) {
    const ft = FASTENER_TYPES[list[0].type];
    const mk = (geo) => {
      const im = new THREE.InstancedMesh(geo, fxMats[list[0].type], list.length);
      im.userData = { fx: true, shared: true, stage: list[0].stage, baseY: 0, ex: 0, infos: list.map((f) => f.info) };
      root.add(im); pickables.push(im);
      return im;
    };
    const shafts = mk(fxGeo.shaft), heads = mk(fxGeo.head);
    list.forEach((f, i) => {
      const dir = new THREE.Vector3(...f.dir), q = new THREE.Quaternion().setFromUnitVectors(Y, dir);
      const p0 = new THREE.Vector3(...f.p).add(off);
      m4.compose(p0.clone().addScaledVector(dir, f.len / 2), q, new THREE.Vector3(ft.r, f.len, ft.r));
      shafts.setMatrixAt(i, m4);
      m4.compose(p0.clone().addScaledVector(dir, -0.04), q, new THREE.Vector3(ft.head, 0.09, ft.head));
      heads.setMatrixAt(i, m4);
    });
  }
  for (const h of d.hangers) for (const b of h.boxes) {
    const g = new THREE.BoxGeometry(b.x[1] - b.x[0], b.y[1] - b.y[0], b.z[1] - b.z[0]);
    const mesh = new THREE.Mesh(g, fxMats.hanger);
    const cy = (b.y[0] + b.y[1]) / 2;
    mesh.position.set((b.x[0] + b.x[1]) / 2 - d.W / 2, cy, (b.z[0] + b.z[1]) / 2 - d.L / 2);
    mesh.userData = { fx: true, stage: h.stage, baseY: cy, ex: 0, info: `${FASTENER_TYPES.hanger.label} · ${h.info}` };
    root.add(mesh); pickables.push(mesh);
  }
}

function viewExtents(v, d) {
  const top = d.p.target + ($('#tExplode').checked ? EXPLODE[5] : 0);
  // the camera looks at the middle of the bed, so size the view for whichever side reaches farthest
  const span = (r, mid) => 2 * Math.max(mid - r[0], r[1] - mid);
  const sx = span(d.bounds.x, d.W / 2), sz = span(d.bounds.z, d.L / 2);
  if (v === 'top') return [sx, sz];
  if (v === 'front') return [sx, top];
  if (v === 'side') return [sz, top];
  return null;
}

function setView(v, keep) {
  if (!cur) return;
  currentView = v;
  const d = cur, cy = d.p.target / 2;
  const ex = viewExtents(v, d);
  camera = ex ? ortho : persp;
  camera.up.set(0, 1, 0);
  if (v === 'iso') persp.position.set(150, 120, 190);
  if (v === 'under') persp.position.set(90, -140, 170);
  if (v === 'top') { ortho.up.set(0, 0, -1); ortho.position.set(0, 400, 0); }
  if (v === 'front') ortho.position.set(0, cy, 400);
  if (v === 'side') ortho.position.set(400, cy, 0);
  ortho.zoom = 1;
  controls?.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const exY = $('#tExplode').checked && v === 'iso' ? EXPLODE[4] / 2 : 0;
  controls.target.set(0, v === 'top' ? 0 : v === 'under' ? d.F / 2 : cy + exY, 0);
  floor.visible = grid.visible = v !== 'under';
  resize();
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
}

function resize() {
  const el = $('#viewer');
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  persp.aspect = aspect; persp.updateProjectionMatrix();
  const ex = cur && viewExtents(currentView, cur);
  if (ex) {
    const half = Math.max(ex[1] / 2, ex[0] / 2 / aspect) * 1.18;
    Object.assign(ortho, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    ortho.updateProjectionMatrix();
  }
}

function highlight(mark) {
  for (const [k, m] of Object.entries(mats)) {
    const on = mark && (k === mark);
    m.emissive?.set(on ? 0x6a3a10 : 0x000000);
  }
}

function setupPicking() {
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(), tip = $('#tip'), el = renderer.domElement;
  let last = null;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(pickables.filter((m) => m.visible && !(m.material.transparent && !m.userData.fx)), false)[0];
    const mark = hit?.object.userData.mark || null;
    if (hit) {
      const u = hit.object.userData;
      tip.textContent = u.infos ? u.infos[hit.instanceId] : u.info;
      tip.style.opacity = 1;
      const x = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 6);
      tip.style.left = `${Math.max(6, x)}px`; tip.style.top = `${e.clientY - r.top + 14}px`;
    } else tip.style.opacity = 0;
    if (mark !== last) {
      highlight(mark);
      document.querySelectorAll('#cutTable tbody tr').forEach((tr) => tr.classList.toggle('hl', tr.dataset.mark === mark));
      last = mark;
    }
  });
  el.addEventListener('pointerleave', () => { tip.style.opacity = 0; highlight(null); last = null; });
}

// ---------- wiring ----------
function renderAll() {
  const d = design(readParams());
  $('#warnings').innerHTML = d.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  renderCuts(d);
  renderBuy(d);
  renderSteps(d);
  if (stage != null && !stageList.some((x) => x.stage === stage)) stage = null;
  drawStack(d);
  drawPlan(d);
  drawPly(d);
  if (renderer) build3d(d);
}

$('#legend').innerHTML = GROUP_LABELS.map(([m, l]) => `<span><i style="background:${COLORS[m]}"></i>${l}</span>`).join('')
  + Object.values(FASTENER_TYPES).map((f) => `<span class="lfx"><i style="background:${f.color};border-radius:50%"></i>${f.label}</span>`).join('');
['#mattT', '#target', '#clear', '#rail', '#spacing', '#ply', '#lip', '#stepOn', '#stepH', '#stepW', '#stepD', '#stepLoc']
  .forEach((id) => $(id).addEventListener('input', renderAll));
['#tMatt', '#tPly', '#tStep', '#tFast', '#tXray'].forEach((id) => $(id).addEventListener('change', applyToggles));
$('#tExplode').addEventListener('change', () => { applyToggles(); setView(currentView); });
document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#stAll').addEventListener('click', () => setStage(stage == null ? stageList[0]?.stage ?? null : null));
const stepBy = (k) => { const i = stageList.findIndex((x) => x.stage === stage); const n = stageList[i + k]; if (n) setStage(n.stage); };
$('#stPrev').addEventListener('click', () => stepBy(-1));
$('#stNext').addEventListener('click', () => (stage == null ? setStage(stageList[0]?.stage) : stepBy(1)));

try { init3d(); } catch (e) {
  $('#viewer').insertAdjacentHTML('beforeend', '<div class="warn" style="margin:16px">3D view unavailable in this browser (WebGL failed to start). The drawings below still apply.</div>');
  console.error(e);
}
renderAll();
