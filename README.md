# trame-sql-source

A SQL source plugin for [Trame](https://github.com/Andarius/trame). It fills a Trame database from a **read-only query** on a PostgreSQL you choose, on demand or on a schedule (every 5 minutes to 30 days).

## Use

```bash
tramecli plugins add Andarius/trame-sql-source
```

Or, in a Trame checkout with this repo next to it:

```bash
echo '{ "plugins": ["../trame-sql-source"] }' > plugins.local.json
just plugins && just dev
```

Open a database page and pick **⇣ Connect** (or "Fill from a SQL query" on an empty one), paste a connection string and a query, run it, choose the key column and map or skip the other columns. A dry run shows the table as the write would leave it before anything is saved.

- **Rows** match by the key column: new keys add rows, changed cells are patched, and with "delete missing" rows whose key left the results are removed.
- **Columns** the source fills are read-only in Trame; a column you map elsewhere, skip or disconnect goes back to you with its values.
- **Queries** run in a read-only transaction with a 30 s timeout and a 10 000-row cap; TLS connection strings are refused for now.

Connection strings live only in this machine's `settings.json` (mode 0600). They are never synced to the hub and never sent back to the UI; only the rows sync. Settings from the built-in plugin of Trame ≤ 0.28 carry over (same `sql-source` id).

## Test

`TRAME` points at the Trame checkout (default `../trame`), with the plugin composed into it:

```bash
just hooks   # pre-commit runs `just lint`
just lint    # rustfmt, oxlint (Trame's config), bun tests (import boundary, version)
just check   # lint, then clippy, the Rust unit and integration tests (real PostgreSQL) and the web typecheck
just e2e --project trame-sql-source   # from the Trame checkout: the e2e/ specs
```

`tests/*.rs` are linked into Trame's `crates/trame-local/tests/` by `just plugins` and run against a real Trame server and PostgreSQL (`.scratch/package`, from `bash scripts/rust-package.sh prepare`).

## Release

Bump `VERSION` in `version.ts` and `src/mod.rs`, merge, then push a matching tag (`git tag v0.1.0 && git push origin v0.1.0`). The release workflow refuses a tag that differs from `VERSION`; Trame then shows "Update available" for older installs.
