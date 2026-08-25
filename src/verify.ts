import type { Knex } from "knex"
import { type CheckInput, runChecks } from "./checks.js"
import type { ResolvedConfig } from "./config.js"
import {
  countUserTables,
  type LedgerNames,
  readLedger,
  readSidecar,
  writeChecksums,
} from "./ledger.js"
import { scanMigrations } from "./migrations.js"
import type { Finding, LedgerRow } from "./types.js"

function namesOf(config: ResolvedConfig): LedgerNames {
  return {
    tableName: config.tableName,
    schemaName: config.schemaName,
    sidecarTableName: config.sidecarTableName,
  }
}

/** Collects the three sources the checks compare, in parallel. */
export async function gather(
  knex: Knex,
  config: ResolvedConfig,
  cwd: string = process.cwd(),
): Promise<CheckInput> {
  const names = namesOf(config)
  const [files, ledger, sidecar, userTables] = await Promise.all([
    scanMigrations(config.scan, cwd),
    readLedger(knex, names),
    readSidecar(knex, names),
    countUserTables(knex, names),
  ])
  return { files, ledger, sidecar, userTables }
}

/**
 * The gate that runs before `knex migrate:latest`. It compares the migration
 * files with the ledger and never writes anything.
 */
export async function verify(
  knex: Knex,
  config: ResolvedConfig,
  cwd: string = process.cwd(),
): Promise<readonly Finding[]> {
  return runChecks(await gather(knex, config, cwd))
}

function newestBatch(ledger: readonly LedgerRow[]): number | null {
  const batches = ledger.flatMap((row) => (row.batch === null ? [] : [row.batch]))
  return batches.length === 0 ? null : Math.max(...batches)
}

export type RecordOptions = {
  /** Record every applied migration, not only the newest batch. */
  readonly all: boolean
}

/**
 * Stores the checksum of applied migrations. By default only the newest batch
 * is recorded, which is what a deploy needs after `knex migrate:latest`.
 * Recording every migration is an explicit adoption step.
 */
export async function record(
  knex: Knex,
  config: ResolvedConfig,
  options: RecordOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  const names = namesOf(config)
  const [files, ledger] = await Promise.all([
    scanMigrations(config.scan, cwd),
    readLedger(knex, names),
  ])

  const latest = newestBatch(ledger)
  const wanted = options.all ? ledger : ledger.filter((row) => row.batch === latest)
  const byName = new Map(files.map((file) => [file.name, file]))

  const entries = wanted.flatMap((row) => {
    const file = byName.get(row.name)
    if (file === undefined) return []
    return [
      {
        name: row.name,
        checksum: file.checksum,
        source: options.all ? ("baseline" as const) : ("record" as const),
      },
    ]
  })

  return writeChecksums(knex, names, entries)
}
