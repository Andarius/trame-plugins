set quiet

# the Trame checkout this plugin is composed into (its lint config, toolchain and typecheck)
trame := env("TRAME", "../trame")
pg_bin := trame / ".scratch/package/pg/usr/lib/postgresql/18/bin"

default:
    just --list

# Format the backend and its tests with Trame's rustfmt settings
fmt:
    rustfmt --edition 2024 src/mod.rs tests/*.rs

# Rust formatting, oxlint with Trame's config, the bun tests
lint:
    rustfmt --edition 2024 --check src/mod.rs tests/*.rs
    {{ trame }}/node_modules/.bin/oxlint -c {{ trame }}/.oxlintrc.json web
    bun test _test

# Everything CI runs; the plugin must be composed into {{ trame }} (plugins.local.json + `just plugins`)
check: lint
    cd {{ trame }} && cargo clippy -p trame-local --all-targets --locked -- -D warnings
    cd {{ trame }} && cargo test -p trame-local --locked --lib local_gen::
    cd {{ trame }} && TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$PWD/.scratch/test" TRAME_PG_BIN="{{ pg_bin }}" \
        cargo test -p trame-local --locked --test 'plugin_sql_source_*'
    cd {{ trame }}/app/web && npx tsc --noEmit

# Enable the git hooks (pre-commit: `just lint`)
hooks:
    git config core.hooksPath .githooks
    echo "hooks enabled (.githooks). Bypass one with --no-verify."
