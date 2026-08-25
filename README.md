# knex-drift

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Catch the migration problems that knex cannot see.

knex records only the **name** of every migration it runs. It never records what the file
contained, and it never looks at the database. So knex stays silent when a migration file is
edited after it was applied, when a new file is inserted out of order, when a ledger row is
duplicated, or when someone points a fresh ledger at a database that already has tables. Every
one of those makes a rebuilt database differ from production, and you find out much later.

`knex-drift` closes that gap. It is a standalone CLI, because the knex CLI has no plugin hook.
It never runs DDL, and it never modifies `knex_migrations`.

## Install

```bash
npm install --save-dev knex-drift
```

Requires Node 22 or newer, and knex 2 or newer as a peer dependency.

## Quick start

```bash
# 1. store the checksum of every migration already applied
npx knex-drift record --all

# 2. from now on, gate every deploy
npx knex-drift verify && npx knex migrate:latest && npx knex-drift record
```

Put that chain in `package.json` so a deploy is one command:

```json
{
  "scripts": {
    "db:migrate": "knex-drift verify && knex migrate:latest && knex-drift record"
  }
}
```

Because the steps are joined with `&&`, a failing check stops the deploy **before** knex touches
the database.

## What it detects

| Code | Condition | Severity |
| --- | --- | --- |
| `D3` | A migration file changed after it was applied | blocking |
| `D4` | A pending migration sorts before the newest applied one | blocking |
| `D5` | The same migration name appears in the ledger more than once | blocking |
| `D7` | The ledger is empty but the database already holds user tables | blocking |
| `D2` | A ledger row has no matching migration file | warning |
| `UNVERIFIED` | Applied migrations that have no recorded checksum yet | note |

Example output:

```
FAIL  D3  a migration changed after it was applied

  20240101120000_create_users.js
    recorded  fd7084b7885a  (batch 1)
    on disk   361b439e408d

  This database has the OLD behaviour; a rebuilt one gets the NEW behaviour.
  Restore the file content, or write a NEW migration for the change.

1 blocking issue, 0 warnings, 0 notes
```

## Commands

### `knex-drift verify`

Compares the migration files with the ledger. Reads only — it writes nothing.

| Option | Effect |
| --- | --- |
| `--strict` | Treat warnings as blocking |
| `--json` | Print machine-readable output |
| `--pre` | Run only the checks that are safe before a migration (the default today) |
| `-c, --config <path>` | Path to `drift.config.js` |
| `--cwd <path>` | Directory to resolve paths from |

### `knex-drift record`

Stores the checksum of applied migrations in the sidecar table.

| Option | Effect |
| --- | --- |
| `--all` | Record every applied migration, not only the newest batch |
| `-c, --config <path>` | Path to `drift.config.js` |
| `--cwd <path>` | Directory to resolve paths from |

Without `--all`, only the newest batch is recorded. That is what a deploy needs immediately after
`knex migrate:latest`. Recording every migration at once is the deliberate adoption step, so it is
explicit.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Clean, or notes only |
| `1` | At least one blocking finding |
| `2` | Warnings only (becomes `1` under `--strict`) |
| `3` | The tool could not run — bad config, no connection |

## Configuration

No configuration is required. By default the tool reads `./knexfile.js` and uses knex's own
defaults for the migrations directory, the ledger table name, and the schema name.

To change any of that, add `drift.config.js` next to your knexfile:

```js
module.exports = {
  // Path to the knexfile. Default: "./knexfile.js"
  knexfile: './knexfile.js',

  // Which knexfile environment to use.
  // Default: process.env.NODE_ENV, else "development"
  environment: 'production',

  // Where checksums are stored. Default: "knex_drift_migrations"
  sidecarTableName: 'knex_drift_migrations',

  // Strip carriage returns before hashing, so a Windows checkout does not
  // report every file as changed. Default: true
  normalizeEol: true,
}
```

## The sidecar table

On first `record`, the tool creates one table:

```
knex_drift_migrations
  name         varchar(255)  primary key
  checksum     varchar(64)
  source       varchar(16)   'record' or 'baseline'
  recorded_at  timestamp
```

`knex_migrations` is never altered. Uninstalling is `DROP TABLE knex_drift_migrations`.

## Programmatic use

```js
import knexFactory from 'knex'
import { loadConfig, verify, record, exitCodeFor, formatHuman } from 'knex-drift'

const config = await loadConfig()
const knex = knexFactory(config.knexConfig)

const findings = await verify(knex, config)
if (exitCodeFor(findings, false) !== 0) {
  console.error(formatHuman(findings, false))
  process.exit(1)
}

await knex.migrate.latest()
await record(knex, config, { all: false })
await knex.destroy()
```

> Do **not** build the pre-migration check on knex's lifecycle hooks. knex calls `beforeAll` only
> when there are pending migrations, so a deploy with nothing to run would skip the check entirely.

## Database support

The checksum and ledger checks (`D2`, `D3`, `D4`, `D5`, `UNVERIFIED`) are dialect-independent.

The `D7` check needs to list user tables, and supports PostgreSQL, Redshift, MySQL/MariaDB, SQLite,
MSSQL and Oracle. On an unrecognised dialect, `D7` is skipped rather than guessed.

The automated test suite runs against SQLite via `better-sqlite3`.

## Not implemented yet

This release covers migration files against the ledger. It does **not** yet compare either of them
against the live database schema. The following are planned:

- A catalog reader and a committed `expected.schema.json`, produced by replaying every migration
  onto a scratch database in CI
- Phantom object detection — tables, columns and indexes present in the database that no migration
  created
- `drift-ignore.yml`, with `adopt` / `revert` / `ignore` / `quarantine` classes
- A `baseline` command for adopting a database that has already drifted
- Custom `migrationSource` support; the tool currently reads the migrations directory itself

## License

MIT
