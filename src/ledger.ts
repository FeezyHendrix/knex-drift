import type { Knex } from "knex"
import { firstStringValue, rowsOf, toSupportedDialect, userTablesQuery } from "./dialect.js"
import {
  type LedgerRow,
  type MigrationName,
  migrationName,
  type SidecarRow,
  sha256,
  type UserTables,
} from "./types.js"

export type LedgerNames = {
  readonly tableName: string
  readonly schemaName: string | null
  readonly sidecarTableName: string
}

function qualified(tableName: string, schemaName: string | null): string {
  return schemaName === null ? tableName : `${schemaName}.${tableName}`
}

function schemaOf(knex: Knex, schemaName: string | null): Knex.SchemaBuilder {
  return schemaName === null ? knex.schema : knex.schema.withSchema(schemaName)
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/**
 * Reads every ledger row in insert order, duplicates included. A missing table
 * means no migration has ever run, which the D7 check treats as significant.
 */
export async function readLedger(knex: Knex, names: LedgerNames): Promise<readonly LedgerRow[]> {
  const present = await schemaOf(knex, names.schemaName).hasTable(names.tableName)
  if (!present) return []

  const rows: unknown = await knex
    .from(qualified(names.tableName, names.schemaName))
    .orderBy("id")
    .select("name", "batch")

  return rowsOf(rows).flatMap((row) => {
    const name = row["name"]
    if (typeof name !== "string") return []
    return [{ name: migrationName(name), batch: toNullableNumber(row["batch"]) }]
  })
}

/**
 * Creates the sidecar checksum table when absent. `name` is the primary key, so
 * the database itself refuses the duplicate rows that D5 reports in the ledger.
 */
export async function ensureSidecar(knex: Knex, names: LedgerNames): Promise<void> {
  const builder = schemaOf(knex, names.schemaName)
  if (await builder.hasTable(names.sidecarTableName)) return

  await schemaOf(knex, names.schemaName).createTable(names.sidecarTableName, (table) => {
    table.string("name", 255).notNullable().primary()
    table.string("checksum", 64).notNullable()
    table.string("source", 16).notNullable()
    table.timestamp("recorded_at").notNullable()
  })
}

export async function readSidecar(knex: Knex, names: LedgerNames): Promise<readonly SidecarRow[]> {
  const present = await schemaOf(knex, names.schemaName).hasTable(names.sidecarTableName)
  if (!present) return []

  const rows: unknown = await knex
    .from(qualified(names.sidecarTableName, names.schemaName))
    .select("name", "checksum")

  return rowsOf(rows).flatMap((row) => {
    const name = row["name"]
    const checksum = row["checksum"]
    if (typeof name !== "string" || typeof checksum !== "string") return []
    return [{ name: migrationName(name), checksum: sha256(checksum) }]
  })
}

export type ChecksumWrite = {
  readonly name: MigrationName
  readonly checksum: string
  readonly source: "record" | "baseline"
}

/** Inserts checksums for names not yet recorded. Existing rows are left alone. */
export async function writeChecksums(
  knex: Knex,
  names: LedgerNames,
  entries: readonly ChecksumWrite[],
): Promise<number> {
  if (entries.length === 0) return 0
  await ensureSidecar(knex, names)

  const known = new Set((await readSidecar(knex, names)).map((row) => row.name))
  const fresh = entries.filter((entry) => !known.has(entry.name))
  if (fresh.length === 0) return 0

  const recordedAt = new Date()
  await knex.into(qualified(names.sidecarTableName, names.schemaName)).insert(
    fresh.map((entry) => ({
      name: entry.name,
      checksum: entry.checksum,
      source: entry.source,
      recorded_at: recordedAt,
    })),
  )
  return fresh.length
}

/**
 * Counts tables that migrations are expected to own, excluding the bookkeeping
 * tables knex and this tool create. Returns null when the dialect is unknown,
 * so the D7 check is skipped rather than guessed.
 */
export async function countUserTables(knex: Knex, names: LedgerNames): Promise<UserTables | null> {
  const dialect = toSupportedDialect(knex.client.dialect)
  if (dialect === null) return null

  const query = userTablesQuery(dialect, names.schemaName)
  const response: unknown = await knex.raw(query.sql, [...query.bindings])

  const ignored = new Set([
    names.tableName.toLowerCase(),
    `${names.tableName}_lock`.toLowerCase(),
    names.sidecarTableName.toLowerCase(),
  ])

  const tables = rowsOf(response)
    .flatMap((row) => {
      const name = firstStringValue(row)
      return name === null ? [] : [name]
    })
    .filter((name) => !ignored.has(name.toLowerCase()))
    .sort()

  return { count: tables.length, sample: tables.slice(0, 5) }
}
