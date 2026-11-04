// Schema diagram of a saved connection: tables with their key columns, foreign keys as orthogonal edges.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "@trame/web-api";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { readSchema } from "./api";
import { bestMatch, type Box, CHAR, type Edge, HEADER, layout, matches, neighborhood, ROW, type Schema, tableKey } from "./schema-layout";

const KIND: Record<string, string> = { v: "view", m: "mat. view", f: "foreign", p: "partitioned" };
const HOPS = [1, 2, 3, Infinity];
const chip = "rounded-full border px-2 py-0.5 text-[11px]";
const btn = "rounded-md border border-chipline px-2 py-0.5 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50";

/** "12", "3.4k", "1.2M" — Postgres row estimates, so never exact. */
const approx = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`);
const clip = (s: string, chars: number) => (s.length <= chars ? s : `${s.slice(0, Math.max(1, chars - 1))}…`);
const path = (e: Edge) => e.points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("");

function TableBox({ b, dim, lit, match, focused, onToggle, onFocus, onHover }: {
  b: Box;
  dim: boolean;
  lit: boolean;
  match: boolean;
  focused: boolean;
  onToggle: () => void;
  onFocus: () => void;
  onHover: (on: boolean) => void;
}) {
  const t = b.table;
  const kind = KIND[t.kind];
  const estimate = t.rows > 0 ? `≈${approx(t.rows)}` : ""; // 0: never analyzed, so unknown
  const nameRoom = Math.floor((b.w - 28 - (estimate.length + (kind ? kind.length + 2 : 0)) * CHAR) / CHAR) - t.schema.length - 1;
  return (
    <g
      transform={`translate(${b.x},${b.y})`}
      opacity={dim ? 0.22 : 1}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ cursor: "pointer" }}
    >
      <rect
        width={b.w}
        height={b.h}
        rx={6}
        fill="var(--color-panel)"
        stroke={focused || match ? "var(--color-copper)" : lit ? "var(--color-ink-soft)" : "var(--color-line)"}
        strokeWidth={focused || match ? 2 : 1}
        strokeDasharray={t.kind === "v" || t.kind === "m" ? "4 3" : undefined}
      />
      <g onClick={onToggle} onDoubleClick={onFocus}>
        <title>{`${t.schema}.${t.name} · ≈${t.rows} rows · click: ${b.hidden ? "all columns" : "key columns"} · double-click: focus`}</title>
        <path d={`M0,${HEADER}V6a6,6 0 0 1 6,-6H${b.w - 6}a6,6 0 0 1 6,6V${HEADER}Z`} fill="var(--color-hover)" />
        <text x={10} y={17} fontSize={12} fill="var(--color-ink)">
          <tspan fill="var(--color-ink-muted)">{t.schema}.</tspan>
          <tspan fontWeight={600}>{clip(t.name, Math.max(4, nameRoom))}</tspan>
          {kind && <tspan fill="var(--color-ink-muted)" fontSize={10}>{`  ${kind}`}</tspan>}
        </text>
        <text x={b.w - 10} y={17} fontSize={10} textAnchor="end" fill="var(--color-ink-muted)">{estimate}</text>
      </g>
      {b.rows.map((r, i) => {
        const y = HEADER + i * ROW + ROW / 2 + 4;
        return (
          <g key={r.name} fontFamily="ui-monospace, monospace" fontSize={11}>
            <text x={10} y={y} fill={r.pk ? "var(--color-copper)" : "var(--color-ink-muted)"} fontSize={9}>
              {r.pk ? "PK" : r.fk ? "FK" : ""}
            </text>
            <text x={30} y={y} fill="var(--color-ink)" fontStyle={r.nullable ? "italic" : undefined}>
              {clip(r.name, Math.floor((b.w - 52) / CHAR) - r.type.length)}
            </text>
            <text x={b.w - 10} y={y} textAnchor="end" fill="var(--color-ink-muted)">{r.type}</text>
          </g>
        );
      })}
      {b.hidden > 0 && (
        <text x={30} y={HEADER + b.rows.length * ROW + ROW / 2 + 4} fontSize={10.5} fill="var(--color-ink-muted)" onClick={onToggle}>
          + {b.hidden} more column{b.hidden > 1 ? "s" : ""}
        </text>
      )}
    </g>
  );
}

export function SchemaView({ connectionId, name, onClose }: { connectionId: string; name: string; onClose: () => void }) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiddenSchemas, setHiddenSchemas] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [hops, setHops] = useState(1);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<Edge | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ZoomTransform>(zoomIdentity);
  const zoomer = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  useEffect(() => {
    let live = true;
    readSchema({ connection_id: connectionId })
      .then((s) => live && setSchema({ tables: s.tables, fks: s.fks }))
      .catch((e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [connectionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (focus ? setFocus(null) : onClose());
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [focus, onClose]);

  const schemas = useMemo(() => [...new Set(schema?.tables.map((t) => t.schema))].sort(), [schema]);
  const shown = useMemo(() => {
    if (!schema) return new Set<string>();
    const base = new Set(schema.tables.filter((t) => !hiddenSchemas.has(t.schema)).map((t) => tableKey(t.schema, t.name)));
    return focus && base.has(focus) ? neighborhood(schema.fks, focus, hops, base) : base;
  }, [schema, hiddenSchemas, focus, hops]);
  const lay = useMemo(() => (schema ? layout(schema, shown, expanded) : null), [schema, shown, expanded]);
  const hits = useMemo(
    () => new Set(schema?.tables.filter((t) => shown.has(tableKey(t.schema, t.name)) && matches(t, query)).map((t) => tableKey(t.schema, t.name))),
    [schema, shown, query],
  );

  // tables and edges lit by the hovered table or edge; the rest dims
  const lit = useMemo(() => {
    if (!lay || (!hover && !hoverEdge)) return null;
    if (hoverEdge) return { tables: new Set([hoverEdge.from, hoverEdge.to]), edges: new Set([hoverEdge]) };
    const edges = new Set(lay.edges.filter((e) => e.from === hover || e.to === hover));
    return { tables: new Set([hover!, ...[...edges].flatMap((e) => [e.from, e.to])]), edges };
  }, [lay, hover, hoverEdge]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const z = zoom<SVGSVGElement, unknown>().scaleExtent([0.1, 3]).on("zoom", (e: { transform: ZoomTransform }) => setView(e.transform));
    select(svg).call(z).on("dblclick.zoom", null);
    zoomer.current = z;
  }, [schema]);

  const fit = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !lay || !zoomer.current) return;
    const { width, height } = svg.getBoundingClientRect();
    const k = Math.min(1.2, (width - 48) / Math.max(1, lay.width), (height - 48) / Math.max(1, lay.height));
    const t = zoomIdentity.translate((width - lay.width * k) / 2, Math.max(24, (height - lay.height * k) / 2)).scale(k);
    select(svg).call(zoomer.current.transform, t);
  }, [lay]);
  // refit when the set of tables changes, not when a table expands
  const fitted = useRef<string | null>(null);
  const shownKey = [...shown].join("|");
  useEffect(() => {
    if (!lay || fitted.current === shownKey) return;
    fitted.current = shownKey;
    fit();
  }, [lay, shownKey, fit]);

  const flip = (s: Set<string>, k: string) => {
    const next = new Set(s);
    if (!next.delete(k)) next.add(k);
    return next;
  };
  const toggle = (k: string) => setExpanded((s) => flip(s, k));
  const focusOn = (k: string) => (setFocus(k), setHover(null));
  const fkCount = lay?.edges.length ?? 0;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink" role="dialog" aria-label={`Schema of ${name}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sidebar px-4 py-2">
        <h2 className="m-0 mr-2 text-[13px] font-semibold">Schema · {name}</h2>
        {schemas.length > 1 && schemas.map((s) => {
          const on = !hiddenSchemas.has(s);
          return (
            <button
              key={s}
              type="button"
              className={`${chip} ${on ? "border-copper/50 text-ink" : "border-chipline text-ink-muted/60 line-through"}`}
              onClick={() => setHiddenSchemas((h) => flip(h, s))}
            >
              {s}
            </button>
          );
        })}
        <input
          aria-label="Search tables and columns"
          className="ml-auto w-[220px] rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] outline-none focus:border-chipline"
          placeholder="search tables, columns ⏎ focus"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const best = e.key === "Enter" && schema ? bestMatch(schema.tables.filter((t) => hits.has(tableKey(t.schema, t.name))), query) : null;
            if (best) focusOn(best);
          }}
        />
        {query.trim() && <span className="text-[11px] text-ink-muted">{hits.size} match{hits.size === 1 ? "" : "es"}</span>}
        <button type="button" className={btn} onClick={fit} disabled={!lay}>Fit</button>
        <button type="button" className="px-1 text-ink-muted hover:text-ink" title="close (esc)" onClick={onClose}>✕</button>
      </div>
      {focus && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[11.5px] text-ink-soft">
          Focused on <b className="text-ink">{focus}</b> · within
          {HOPS.map((h) => (
            <button
              key={h}
              type="button"
              className={`${chip} ${hops === h ? "border-copper/60 text-ink" : "border-chipline text-ink-muted"}`}
              onClick={() => setHops(h)}
            >
              {h === Infinity ? "all" : `${h} hop${h > 1 ? "s" : ""}`}
            </button>
          ))}
          <button type="button" className={btn} onClick={() => setFocus(null)}>Show all</button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {!schema && !error && <div className="p-6 text-[12px] text-ink-muted">Reading the catalog…</div>}
        {error && <div className="p-6 text-[12px] text-blocked">{error}</div>}
        {schema && schema.tables.length === 0 && <div className="p-6 text-[12px] text-ink-muted">No table in this database.</div>}
        <svg ref={svgRef} className={`h-full w-full ${schema ? "" : "hidden"}`}>
          <defs>
            {(["chipline", "copper"] as const).map((c) => (
              <g key={c}>
                <marker id={`sql-schema-to-${c}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
                  <path d="M0,0L8,4L0,8Z" fill={`var(--color-${c})`} />
                </marker>
                <marker id={`sql-schema-from-${c}`} viewBox="0 0 6 6" refX={3} refY={3} markerWidth={5} markerHeight={5}>
                  <circle cx={3} cy={3} r={2.4} fill="var(--color-panel)" stroke={`var(--color-${c})`} />
                </marker>
              </g>
            ))}
          </defs>
          {lay && (
            <g transform={view.toString()}>
              {lay.edges.map((e) => {
                const on = lit?.edges.has(e);
                return (
                  <g key={e.fk.name + e.from} onMouseEnter={() => setHoverEdge(e)} onMouseLeave={() => setHoverEdge(null)}>
                    <title>{`${e.fk.name}: ${e.from}(${e.fk.from.columns.join(", ")}) → ${e.to}(${e.fk.to.columns.join(", ")})`}</title>
                    <path d={path(e)} fill="none" stroke="transparent" strokeWidth={8} />
                    <path
                      d={path(e)}
                      fill="none"
                      stroke={on ? "var(--color-copper)" : "var(--color-chipline)"}
                      strokeWidth={on ? 1.8 : 1.1}
                      opacity={lit && !on ? 0.18 : 1}
                      markerStart={`url(#sql-schema-from-${on ? "copper" : "chipline"})`}
                      markerEnd={`url(#sql-schema-to-${on ? "copper" : "chipline"})`}
                    />
                  </g>
                );
              })}
              {[...lay.boxes.values()].map((b) => (
                <TableBox
                  key={b.key}
                  b={b}
                  dim={Boolean(lit && !lit.tables.has(b.key))}
                  lit={Boolean(lit?.tables.has(b.key))}
                  match={hits.has(b.key)}
                  focused={focus === b.key}
                  onToggle={() => toggle(b.key)}
                  onFocus={() => focusOn(b.key)}
                  onHover={(on) => setHover(on ? b.key : null)}
                />
              ))}
            </g>
          )}
        </svg>
        {lay && (
          <div className="pointer-events-none absolute bottom-2 left-4 text-[11px] text-ink-muted/80">
            {lay.boxes.size} table{lay.boxes.size === 1 ? "" : "s"} · {fkCount} foreign key{fkCount === 1 ? "" : "s"} · click a header for
            all columns · double-click to focus · scroll to zoom
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
