import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { tagMismatch, versionOf } from "./release.ts";

const fake = async (plugin: string) => (plugin === "k8s" || plugin === "notebook-cells" ? "0.2.1" : null);

// the release workflow refuses a tag that would publish a release under the wrong plugin or version
test.each([
  { id: "plugin tag", tag: "k8s-v0.2.1", ok: true },
  { id: "full ref", tag: "refs/tags/k8s-v0.2.1", ok: true },
  { id: "dashed plugin name", tag: "notebook-cells-v0.2.1", ok: true },
  { id: "other version", tag: "k8s-v0.3.0", ok: false },
  { id: "unknown plugin", tag: "nope-v0.2.1", ok: false },
  { id: "bare v tag", tag: "v0.2.1", ok: false },
  { id: "prerelease suffix", tag: "k8s-v0.2.1-rc.1", ok: false },
  { id: "path in name", tag: "../k8s-v0.2.1", ok: false },
  { id: "empty tag", tag: "", ok: false },
])("$id", async ({ tag, ok }) => {
  expect((await tagMismatch(tag, fake)) === null).toBe(ok);
});

// each plugin's REPO is installable as `owner/repo/<dir>`, and src/mod.rs carries the same identity
test.each(readdirSync(new URL("./plugins", import.meta.url)))("%s identity", async (plugin) => {
  const { VERSION, REPO } = await import(`./plugins/${plugin}/version.ts`);
  expect(REPO).toBe(`Andarius/trame-plugins/${plugin}`);
  expect(await versionOf(plugin)).toBe(VERSION);
  const rs = readFileSync(new URL(`./plugins/${plugin}/src/mod.rs`, import.meta.url), "utf8");
  expect(rs).toContain(`pub const ID: &str = "${plugin}";`);
  expect(rs).toContain(`const VERSION: &str = "${VERSION}";`);
  expect(rs).toContain(`const REPO: &str = "${REPO}";`);
});
