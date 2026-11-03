// Release check: a `<plugin>-vX.Y.Z` tag must name a plugin under plugins/ and match its VERSION.
// USAGE: bun release.ts <tag>   (prints the plugin name; exits 1 with the reason otherwise)
import { existsSync } from "node:fs";

/** `{ plugin, version }` of a release tag such as `k8s-v0.2.1` (or its `refs/tags/` ref), else null. */
export function parseTag(tag: string) {
  const m = /^(?:refs\/tags\/)?([a-z0-9][a-z0-9-]*)-v(\d+\.\d+\.\d+)$/.exec(tag);
  return m ? { plugin: m[1], version: m[2] } : null;
}

/** Why `tag` cannot release, or null; `versionOf` reads a plugin's VERSION (null: no such plugin). */
export async function tagMismatch(tag: string, versionOf: (plugin: string) => Promise<string | null>) {
  const parsed = parseTag(tag);
  if (!parsed) return `tag ${tag} is not <plugin>-vX.Y.Z`;
  const version = await versionOf(parsed.plugin);
  if (version === null) return `tag ${tag}: no plugin ${parsed.plugin} under plugins/`;
  return version === parsed.version ? null : `tag ${tag} does not match ${parsed.plugin} ${version} (version.ts)`;
}

export const versionOf = async (plugin: string) => {
  const file = new URL(`./plugins/${plugin}/version.ts`, import.meta.url);
  return existsSync(file) ? ((await import(file.href)) as { VERSION: string }).VERSION : null;
};

if (import.meta.main) {
  const tag = process.argv[2] ?? "";
  const error = await tagMismatch(tag, versionOf);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(parseTag(tag)!.plugin);
}
