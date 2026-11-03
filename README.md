# trame-plugins

Native plugins for [Trame](https://github.com/Andarius/trame), one per folder:

| Plugin | What it does |
|---|---|
| [`deployments`](plugins/deployments) | GitHub and GitLab releases waiting for approval, approved from the panel |
| [`k8s`](plugins/k8s) | Workloads of your kube contexts as cluster columns and force graphs |
| [`notebook-cells`](plugins/notebook-cells) | Python notebook cells on a Jupyter kernel, as page blocks |
| [`sql-source`](plugins/sql-source) | Fills a Trame database from a read-only PostgreSQL query |

## Use

Install one by its path in this repo; the build fetches its latest `<plugin>-vX.Y.Z` release:

```bash
tramecli plugins add Andarius/trame-plugins/k8s
```

The same `owner/repo/plugin` form goes in the `plugins.json` of your own build (Trame docs, "Plugins").

## Develop

Clone this repo next to a Trame checkout (`TRAME` overrides `../trame`). Every recipe takes an
optional plugin name and defaults to all of them:

```bash
just hooks             # pre-commit runs `just lint`
just compose [plugin]  # writes ../trame/plugins.local.json and generates Trame's plugin registries
(cd ../trame && just dev)
just lint [plugin]     # rustfmt, oxlint (Trame's config), bun tests
just check             # lint, then clippy, unit and integration tests and the web typecheck in ../trame
```

Each plugin keeps Trame's plugin layout (`src/mod.rs`, `web/index.ts`, `version.ts`, optional
`tests/` and `e2e/`); the root holds the shared tooling. CI composes all plugins into one Trame
build, so two plugins that cannot coexist fail together.

## Release

Bump `VERSION` in the plugin's `version.ts` and `src/mod.rs`, merge, then tag:

```bash
git tag k8s-v0.2.2 && git push origin k8s-v0.2.2
```

The release workflow refuses a tag whose version differs from that plugin's `VERSION`
(`release.ts`) and publishes notes since the plugin's previous tag. Trame then shows "Update
available" to builds of the older version.
