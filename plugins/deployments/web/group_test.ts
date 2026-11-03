import { expect, test } from "bun:test";
import { groupItems, readGrouping } from "./group.ts";

const d = (repo: string, environment: string, status = "waiting") => ({ repo, environment, status });
const items = [
  d("acme/api", "production"),
  d("acme/web", "production"),
  d("acme/web", "staging"),
  d("acme/cli", "production", "failed"),
];

test.each([
  { id: "by project, most waiting first", by: "project" as const, want: ["acme/web", "acme/api", "acme/cli"] },
  { id: "by environment", by: "environment" as const, want: ["production", "staging"] },
])("$id", ({ by, want }) => {
  expect(groupItems(items, by).map(([k]) => k)).toEqual(want);
});

test("projects is the default grouping", () => {
  expect(readGrouping()).toBe("project");
});
