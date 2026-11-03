// How the panel groups deployments: by project (the default) or by environment.
export type Grouping = "project" | "environment";

type Groupable = { repo: string; environment: string; status: string };

const GROUPING_KEY = "trame:deployments:group";

export function readGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === "environment" ? "environment" : "project";
  } catch {
    return "project";
  }
}

export function saveGrouping(g: Grouping) {
  try {
    localStorage.setItem(GROUPING_KEY, g);
  } catch { /* storage blocked: the choice lasts this view */ }
}

/** Groups with the most waiting first, then the most items, then by name. */
export function groupItems<T extends Groupable>(items: T[], by: Grouping): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const d of items) {
    const k = by === "project" ? d.repo : d.environment;
    m.set(k, [...(m.get(k) ?? []), d]);
  }
  const waiting = (l: T[]) => l.filter((d) => d.status === "waiting").length;
  return [...m.entries()].sort((a, b) =>
    waiting(b[1]) - waiting(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0])
  );
}
