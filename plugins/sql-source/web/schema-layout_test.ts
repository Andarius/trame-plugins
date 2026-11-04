import { expect, test } from "bun:test";
import { bestMatch, type Box, keyColumns, layout, matches, neighborhood, portY, type Schema, type SchemaFk, tableKey } from "./schema-layout.ts";

const col = (name: string, pk = false) => ({ name, type: "integer", nullable: !pk, pk });
const table = (name: string, ...cols: ReturnType<typeof col>[]) => ({ schema: "s", name, kind: "r", rows: 0, columns: cols });
const fk = (from: string, fromCol: string, to: string, toCol = "id"): SchemaFk => ({
  name: `${from}_${fromCol}_fkey`,
  from: { schema: "s", table: from, columns: [fromCol] },
  to: { schema: "s", table: to, columns: [toCol] },
});

// customer ← orders ← line, region ← customer, a cycle a ⇄ b, a self-reference, a table with no key
const SCHEMA: Schema = {
  tables: [
    table("region", col("id", true), col("label")),
    table("customer", col("id", true), col("region_id"), col("name"), col("email")),
    table("orders", col("id", true), col("customer_id"), col("note")),
    table("line", col("order_id", true), col("n", true), col("qty")),
    table("a", col("id", true), col("b_id")),
    table("b", col("id", true), col("a_id")),
    table("staff", col("id", true), col("boss_id")),
    table("log", col("at"), col("msg")),
  ],
  fks: [
    fk("customer", "region_id", "region"),
    fk("orders", "customer_id", "customer"),
    fk("line", "order_id", "orders"),
    fk("line", "n", "region"), // spans two layers
    fk("a", "b_id", "b"),
    fk("b", "a_id", "a"),
    fk("staff", "boss_id", "staff"),
  ],
};
const all = new Set(SCHEMA.tables.map((t) => tableKey(t.schema, t.name)));
const placed = layout(SCHEMA, all, new Set());
const at = (name: string) => placed.boxes.get(`s.${name}`)!;

test("referenced tables sit left of the tables pointing at them", () => {
  expect(at("region").x).toBeLessThan(at("customer").x);
  expect(at("customer").x).toBeLessThan(at("orders").x);
  expect(at("orders").x).toBeLessThan(at("line").x);
});

test.each([
  { id: "collapsed customer keeps pk and fk", name: "customer", expanded: false, rows: ["id", "region_id"], hidden: 2 },
  { id: "collapsed region keeps the referenced id", name: "region", expanded: false, rows: ["id"], hidden: 1 },
  { id: "expanded shows every column", name: "customer", expanded: true, rows: ["id", "region_id", "name", "email"], hidden: 0 },
  { id: "a table with no key shows no column", name: "log", expanded: false, rows: [], hidden: 2 },
])("$id", ({ name, expanded, rows, hidden }) => {
  const b = layout(SCHEMA, all, new Set(expanded ? [`s.${name}`] : [])).boxes.get(`s.${name}`)!;
  expect(b.rows.map((r) => r.name)).toEqual(rows);
  expect(b.hidden).toBe(hidden);
});

test("boxes never overlap, cycles and self-references included", () => {
  const boxes = [...placed.boxes.values()];
  expect(boxes.length).toBe(SCHEMA.tables.length);
  const overlap = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
  for (const p of boxes) for (const q of boxes) if (p !== q) expect(overlap(p, q)).toBe(false);
});

test("edges are orthogonal, start on the FK column row and end on the referenced row", () => {
  expect(placed.edges.length).toBe(SCHEMA.fks.length);
  for (const e of placed.edges) {
    e.points.slice(1).forEach(([x, y], i) => {
      const [px, py] = e.points[i];
      expect(x === px || y === py).toBe(true);
    });
    const from = placed.boxes.get(e.from)!, to = placed.boxes.get(e.to)!;
    expect(e.points[0][1]).toBe(portY(from, e.fk.from.columns[0]));
    expect(e.points.at(-1)![1]).toBe(portY(to, e.fk.to.columns[0]));
    expect([from.x, from.x + from.w]).toContain(e.points[0][0]);
    expect([to.x, to.x + to.w]).toContain(e.points.at(-1)![0]);
  }
});

test("a long edge passes no table it does not connect", () => {
  const e = placed.edges.find((e) => e.fk.name === "line_n_fkey")!;
  const others = [...placed.boxes.values()].filter((b) => b.key !== e.from && b.key !== e.to);
  e.points.slice(1).forEach(([x2, y2], i) => {
    const [x1, y1] = e.points[i];
    for (const b of others) {
      const crosses = Math.max(x1, x2) > b.x && Math.min(x1, x2) < b.x + b.w && Math.max(y1, y2) > b.y && Math.min(y1, y2) < b.y + b.h;
      expect(crosses).toBe(false);
    }
  });
});

test.each([
  { id: "one hop both ways", center: "s.orders", hops: 1, want: ["s.customer", "s.line", "s.orders"] },
  { id: "two hops", center: "s.orders", hops: 2, want: ["s.customer", "s.line", "s.orders", "s.region"] },
  { id: "isolated table", center: "s.log", hops: 3, want: ["s.log"] },
  { id: "filtered out neighbours", center: "s.orders", hops: 2, want: ["s.customer", "s.orders"], among: ["s.orders", "s.customer"] },
])("neighborhood: $id", ({ center, hops, want, among }) => {
  expect([...neighborhood(SCHEMA.fks, center, hops, new Set(among ?? all))].sort()).toEqual(want);
});

test.each([
  { id: "table name, any case", q: "LIN", want: ["line"] },
  { id: "column name", q: "email", want: ["customer"] },
  { id: "schema-qualified", q: "s.reg", want: ["region"] },
  { id: "blank matches nothing", q: "  ", want: [] },
])("search: $id", ({ q, want }) => {
  expect(SCHEMA.tables.filter((t) => matches(t, q)).map((t) => t.name)).toEqual(want);
});

test("keyColumns joins primary, foreign and referenced columns", () => {
  expect([...keyColumns(SCHEMA.tables[3], SCHEMA.fks)].sort()).toEqual(["n", "order_id"]);
});

test.each([
  { id: "a table named like the search beats a column", q: "orders", want: "s.orders" },
  { id: "a name match beats a column match", q: "ord", want: "s.orders" },
  { id: "a column match when no name matches", q: "email", want: "s.customer" },
  { id: "nothing", q: "zzz", want: null },
])("best match: $id", ({ q, want }) => {
  expect(bestMatch(SCHEMA.tables, q)).toBe(want);
});
