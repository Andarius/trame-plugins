set quiet

# the Trame checkout the plugins are composed into (its lint config, toolchain and typecheck)
trame := env("TRAME", justfile_directory() / "../trame")
pg_bin := trame / ".scratch/package/pg/usr/lib/postgresql/18/bin"

default:
    just --list

# Format the backends and their tests with the shared rustfmt.toml
fmt plugin="*":
    rustfmt plugins/{{ plugin }}/src/mod.rs $(ls plugins/{{ plugin }}/tests/*.rs 2>/dev/null)

# Rust formatting, oxlint with Trame's config, the bun tests (release identity, each plugin's own)
lint plugin="*":
    rustfmt --check plugins/{{ plugin }}/src/mod.rs $(ls plugins/{{ plugin }}/tests/*.rs 2>/dev/null)
    {{ trame }}/node_modules/.bin/oxlint -c {{ trame }}/.oxlintrc.json plugins/{{ plugin }}/web
    bun test _test

# Write {{ trame }}/plugins.local.json with every plugin (or one) and generate its registries
compose plugin="*":
    cd {{ trame }} && echo "{ \"plugins\": [$(for d in {{ justfile_directory() }}/plugins/{{ plugin }}; do printf '"%s",' "$d"; done | sed 's/,$//')] }" > plugins.local.json
    cd {{ trame }} && bun scripts/gen-plugins.ts

# Everything CI runs, from {{ trame }} with the plugins composed (`just compose`)
check: lint
    cd {{ trame }} && cargo clippy -p trame-local --all-targets --locked -- -D warnings
    cd {{ trame }} && cargo test -p trame-local --locked --lib local_gen::
    cd {{ trame }} && TRAME_ISOLATED=1 TRAME_OFFLINE=1 TRAME_LOCAL_DIR="$PWD/.scratch/test" TRAME_PG_BIN="{{ pg_bin }}" \
        cargo test -p trame-local --locked --test 'plugin_*'
    cd {{ trame }}/app/web && npx tsc --noEmit

# Enable the git hooks (pre-commit: `just lint`)
hooks:
    git config core.hooksPath .githooks
    echo "hooks enabled (.githooks). Bypass one with --no-verify."
