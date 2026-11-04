// Schema diagram layout: layered (referenced tables left of the tables that point at them), orthogonal edges
// from foreign-key column rows to referenced column rows. Pure: no DOM, sizes from character counts.

export type SchemaColumn = { name: string; type: string; nullable: boolean; pk: boolean };
export type SchemaTable = { schema: string; name: string; kind: string; rows: number; columns: SchemaColumn[] };
export type SchemaFk = {
  name: string;
  from: { schema: string; table: string; columns: string[] };
  to: { schema: string; table: string; columns: string[] };
};
export type Schema = { tables: SchemaTable[]; fks: SchemaFk[] };

export type BoxRow = { name: string; type: string; pk: boolean; fk: boolean; nullable: boolean };
export type Box = { key: string; table: SchemaTable; x: number; y: number; w: number; h: number; rows: BoxRow[]; hidden: number };
export type Edge = { fk: SchemaFk; from: string; to: string; points: [number, number][] };
export type Layout = { boxes: Map<string, Box>; edges: Edge[]; width: number; height: number };

export const HEADER = 26;
export const ROW = 18;
const PAD = 6;
export const CHAR = 6.6; // 11px monospace
const MIN_W = 150;
const MAX_W = 380;
const GAP_Y = 22;
const DUMMY_H = 8;
const LOOP = 16;

export const tableKey = (schema: string, name: string) => `${schema}.${name}`;
const fromKey = (fk: SchemaFk) => tableKey(fk.from.schema, fk.from.table);
const toKey = (fk: SchemaFk) => tableKey(fk.to.schema, fk.to.table);

/** Columns a collapsed table shows: its primary key, its foreign keys and the columns others reference. */
export function keyColumns(t: SchemaTable, fks: SchemaFk[]): Set<string> {
  const key = tableKey(t.schema, t.name);
  const out = new Set(t.columns.filter((c) => c.pk).map((c) => c.name));
  for (const fk of fks) {
    if (fromKey(fk) === key) fk.from.columns.forEach((c) => out.add(c));
    if (toKey(fk) === key) fk.to.columns.forEach((c) => out.add(c));
  }
  return out;
}

/** How well a table matches a search (case-insensitive): 0 its name, 1 part of `schema.name`, 2 a column, null none. */
export function matchRank(t: SchemaTable, query: string): 0 | 1 | 2 | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (t.name.toLowerCase() === q || tableKey(t.schema, t.name).toLowerCase() === q) return 0;
  if (tableKey(t.schema, t.name).toLowerCase().includes(q)) return 1;
  return t.columns.some((c) => c.name.toLowerCase().includes(q)) ? 2 : null;
}

export const matches = (t: SchemaTable, query: string) => matchRank(t, query) !== null;

/** The table a search should focus: best rank first, then `schema.name` order; null when nothing matches. */
export function bestMatch(tables: SchemaTable[], query: string): string | null {
  const ranked = tables
    .map((t) => [matchRank(t, query), tableKey(t.schema, t.name)] as const)
    .filter((r): r is readonly [0 | 1 | 2, string] => r[0] !== null)
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return ranked[0]?.[1] ?? null;
}

/** Tables within `hops` foreign-key steps of `center` (either direction), among `among`. */
export function neighborhood(fks: SchemaFk[], center: string, hops: number, among: Set<string>): Set<string> {
  const adj = new Map<string, string[]>();
  for (const fk of fks) {
    const a = fromKey(fk), b = toKey(fk);
    if (!among.has(a) || !among.has(b)) continue;
    adj.set(a, [...adj.get(a) ?? [], b]);
    adj.set(b, [...adj.get(b) ?? [], a]);
  }
  const seen = new Set([center]);
  let frontier = [center];
  for (let i = 0; i < hops && frontier.length; i++) {
    const next = frontier.flatMap((k) => adj.get(k) ?? []).filter((k) => !seen.has(k));
    next.forEach((k) => seen.add(k));
    frontier = [...new Set(next)];
  }
  return seen;
}

function box(t: SchemaTable, fks: SchemaFk[], expanded: boolean): Omit<Box, "x" | "y"> {
  const keys = keyColumns(t, fks);
  const fkCols = new Set(fks.filter((fk) => fromKey(fk) === tableKey(t.schema, t.name)).flatMap((fk) => fk.from.columns));
  const shown = expanded ? t.columns : t.columns.filter((c) => keys.has(c.name));
  const rows = shown.map((c) => ({ name: c.name, type: c.type, pk: c.pk, fk: fkCols.has(c.name), nullable: c.nullable }));
  const hidden = t.columns.length - rows.length;
  const widest = Math.max(
    (t.name.length + t.schema.length + 1 + (t.kind === "r" ? 0 : 10)) * CHAR + 72,
    ...rows.map((r) => (r.name.length + r.type.length) * CHAR + 52),
  );
  return {
    key: tableKey(t.schema, t.name),
    table: t,
    w: Math.min(MAX_W, Math.max(MIN_W, Math.ceil(widest))),
    h: HEADER + (rows.length + (hidden > 0 ? 1 : 0)) * ROW + PAD,
    rows,
    hidden,
  };
}

/** y of a column's port on a placed box: its row's middle, or the header's when the column is hidden. */
export function portY(b: Box, column: string | undefined): number {
  const i = column === undefined ? -1 : b.rows.findIndex((r) => r.name === column);
  return i < 0 ? b.y + HEADER / 2 : b.y + HEADER + i * ROW + ROW / 2;
}

type Slot = { id: string; layer: number; h: number; y: number; w: number; dummy: boolean };

/** Lays out the `visible` tables; `expanded` ones show every column. */
export function layout(schema: Schema, visible: Set<string>, expanded: Set<string>): Layout {
  const tables = schema.tables.filter((t) => visible.has(tableKey(t.schema, t.name)));
  const fks = schema.fks.filter((fk) => visible.has(fromKey(fk)) && visible.has(toKey(fk)));
  const sized = new Map(tables.map((t) => {
    const b = box(t, fks, expanded.has(tableKey(t.schema, t.name)));
    return [b.key, b] as const;
  }));

  // layering on child → parent edges; DFS back edges are flipped so cycles still layer
  const parents = new Map<string, Set<string>>();
  const linked = new Set<string>();
  for (const fk of fks) {
    const a = fromKey(fk), b = toKey(fk);
    if (a === b) continue;
    linked.add(a).add(b);
  }
  const out = new Map<string, string[]>();
  for (const fk of fks) {
    const a = fromKey(fk), b = toKey(fk);
    if (a !== b) out.set(a, [...out.get(a) ?? [], b]);
  }
  const state = new Map<string, 1 | 2>();
  const dag: [string, string][] = [];
  const visit = (n: string) => {
    state.set(n, 1);
    for (const p of out.get(n) ?? []) {
      if (state.get(p) === 1) dag.push([p, n]); // back edge: flip it
      else {
        dag.push([n, p]);
        if (!state.has(p)) visit(p);
      }
    }
    state.set(n, 2);
  };
  for (const k of [...linked].sort()) if (!state.has(k)) visit(k);
  for (const [c, p] of dag) parents.set(c, (parents.get(c) ?? new Set()).add(p));
  const layerOf = new Map<string, number>();
  const layer = (n: string): number => {
    const known = layerOf.get(n);
    if (known !== undefined) return known;
    layerOf.set(n, 0); // guards a cycle the flip missed
    const l = Math.max(-1, ...[...parents.get(n) ?? []].map(layer)) + 1;
    layerOf.set(n, l);
    return l;
  };
  [...linked].forEach(layer);

  // slots per layer, with dummies so an edge never jumps over a layer
  const layers: Slot[][] = [];
  const slot = (s: Slot) => {
    (layers[s.layer] ??= []).push(s);
    return s;
  };
  for (const k of [...linked].sort()) {
    const b = sized.get(k)!;
    slot({ id: k, layer: layerOf.get(k)!, h: b.h, y: 0, w: b.w, dummy: false });
  }
  // per FK: the slot ids it passes, from the right-hand end (higher layer) to the left-hand one
  const chains = new Map<SchemaFk, string[]>();
  fks.forEach((fk, i) => {
    const a = fromKey(fk), b = toKey(fk);
    if (a === b) return;
    const [hi, lo] = layerOf.get(a)! > layerOf.get(b)! ? [a, b] : [b, a];
    const chain = [hi];
    for (let l = layerOf.get(hi)! - 1; l > layerOf.get(lo)!; l--) chain.push(slot({ id: `~${i}:${l}`, layer: l, h: DUMMY_H, y: 0, w: 0, dummy: true }).id);
    chain.push(lo);
    chains.set(fk, chain);
  });
  for (let l = 0; l < layers.length; l++) layers[l] ??= [];

  // neighbours across adjacent layers, for ordering and vertical placement
  const near = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    near.set(a, (near.get(a) ?? new Set()).add(b));
    near.set(b, (near.get(b) ?? new Set()).add(a));
  };
  for (const chain of chains.values()) for (let i = 1; i < chain.length; i++) link(chain[i - 1], chain[i]);
  const byId = new Map(layers.flat().map((s) => [s.id, s]));
  const pos = new Map<string, number>();
  const index = () => layers.forEach((ls) => ls.forEach((s, i) => pos.set(s.id, i)));
  index();
  const bary = (s: Slot, from: number) => {
    const ns = [...near.get(s.id) ?? []].filter((n) => byId.get(n)!.layer === from);
    return ns.length ? ns.reduce((sum, n) => sum + pos.get(n)!, 0) / ns.length : pos.get(s.id)!;
  };
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0;
    for (let k = 1; k < layers.length; k++) {
      const l = down ? k : layers.length - 1 - k;
      const ref = down ? l - 1 : l + 1;
      const keyed = layers[l].map((s) => [bary(s, ref), s] as const);
      layers[l] = keyed.sort((a, b) => a[0] - b[0]).map(([, s]) => s);
      layers[l].forEach((s, i) => pos.set(s.id, i));
    }
  }

  // vertical: stack, then pull each slot toward its neighbours' middle without breaking the order
  const mid = (s: Slot) => s.y + s.h / 2;
  for (const ls of layers) {
    let y = 0;
    for (const s of ls) {
      s.y = y;
      y += s.h + (s.dummy ? 4 : GAP_Y);
    }
  }
  const settle = (ls: Slot[], want: number[]) => {
    ls.forEach((s, i) => (s.y = want[i]));
    for (let i = 1; i < ls.length; i++) {
      const min = ls[i - 1].y + ls[i - 1].h + (ls[i - 1].dummy || ls[i].dummy ? 4 : GAP_Y);
      if (ls[i].y < min) ls[i].y = min;
    }
  };
  for (let pass = 0; pass < 4; pass++) {
    const order = pass % 2 === 0 ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
    for (const l of order) {
      const want = layers[l].map((s) => {
        const ns = [...near.get(s.id) ?? []].map((n) => byId.get(n)!);
        return ns.length ? ns.reduce((sum, n) => sum + mid(n), 0) / ns.length - s.h / 2 : s.y;
      });
      settle(layers[l], want);
    }
  }
  const top = Math.min(0, ...layers.flat().map((s) => s.y));
  layers.flat().forEach((s) => (s.y -= top));

  // horizontal: layer columns, each gap wide enough for its vertical tracks
  const layerW = layers.map((ls) => Math.max(0, ...ls.map((s) => s.w)));
  const gapSegs: { fk: SchemaFk; y1: number; y2: number }[][] = layers.map(() => []);
  for (const [fk, chain] of chains) {
    for (let i = 1; i < chain.length; i++) {
      const a = byId.get(chain[i - 1])!, b = byId.get(chain[i])!;
      gapSegs[b.layer].push({ fk, y1: mid(a), y2: mid(b) });
    }
  }
  const gapW = gapSegs.map((g) => Math.min(260, Math.max(90, 40 + g.length * 9)));
  const layerX: number[] = [];
  let x = 0;
  for (let l = 0; l < layers.length; l++) {
    layerX[l] = x;
    x += layerW[l] + gapW[l];
  }

  const boxes = new Map<string, Box>();
  for (const s of layers.flat()) {
    if (s.dummy) continue;
    boxes.set(s.id, { ...sized.get(s.id)!, x: layerX[s.layer] + (layerW[s.layer] - s.w) / 2, y: s.y });
  }
  let width = Math.max(0, x - (gapW[layers.length - 1] ?? 0));
  let height = Math.max(0, ...[...boxes.values()].map((b) => b.y + b.h));

  // tables with no foreign key in view: a grid under the graph
  const loose = [...sized.values()].filter((b) => !linked.has(b.key)).sort((a, b) => a.key.localeCompare(b.key));
  if (loose.length) {
    const rowW = Math.max(width, 1100);
    let cx = 0, cy = height ? height + 60 : 0, rowH = 0;
    for (const b of loose) {
      if (cx > 0 && cx + b.w > rowW) {
        cx = 0;
        cy += rowH + GAP_Y;
        rowH = 0;
      }
      boxes.set(b.key, { ...b, x: cx, y: cy });
      cx += b.w + 40;
      rowH = Math.max(rowH, b.h);
      width = Math.max(width, cx - 40);
    }
    height = cy + rowH;
  }

  // edges: one vertical track per segment in each gap, ordered by height to limit crossings
  const track = new Map<string, number>();
  gapSegs.forEach((segs, l) => {
    const sorted = [...segs].sort((a, b) => Math.min(a.y1, a.y2) - Math.min(b.y1, b.y2));
    sorted.forEach((s, i) => track.set(`${l}:${s.fk.name}:${s.y1}:${s.y2}`, layerX[l] + layerW[l] + gapW[l] * (i + 1) / (sorted.length + 1)));
  });
  const edges: Edge[] = [];
  for (const fk of fks) {
    const a = fromKey(fk), b = toKey(fk);
    const from = boxes.get(a)!, to = boxes.get(b)!;
    const y1 = portY(from, fk.from.columns[0]), y2 = portY(to, fk.to.columns[0]);
    if (a === b) {
      const r = from.x + from.w;
      edges.push({ fk, from: a, to: b, points: [[r, y1], [r + LOOP, y1], [r + LOOP, y2], [r, y2]] });
      continue;
    }
    const chain = chains.get(fk)!;
    const points: [number, number][] = [];
    for (let i = 0; i < chain.length; i++) {
      const s = byId.get(chain[i])!;
      const yHere = chain[i] === a ? y1 : chain[i] === b ? y2 : mid(s);
      const bx = boxes.get(chain[i]);
      const left = bx ? bx.x : layerX[s.layer], right = bx ? bx.x + bx.w : layerX[s.layer] + layerW[s.layer];
      if (i > 0) points.push([right, yHere]);
      if (i < chain.length - 1) {
        points.push([left, yHere]);
        const next = byId.get(chain[i + 1])!;
        const tx = track.get(`${next.layer}:${fk.name}:${mid(s)}:${mid(next)}`)!;
        const yNext = chain[i + 1] === a ? y1 : chain[i + 1] === b ? y2 : mid(next);
        points.push([tx, yHere], [tx, yNext]);
      }
    }
    // the chain runs right to left; keep `points` from the FK holder to the referenced table
    edges.push({ fk, from: a, to: b, points: chain[0] === a ? points : points.reverse() });
  }
  return { boxes, edges, width, height };
}
