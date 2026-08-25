import type {
  Finding,
  LedgerRow,
  MigrationFile,
  MigrationName,
  SidecarRow,
  UserTables,
} from "./types.js"

/**
 * Everything the checks need, already gathered. The checks are pure: they touch
 * no database and no file system, so each one is testable from plain data.
 */
export type CheckInput = {
  readonly files: readonly MigrationFile[]
  readonly ledger: readonly LedgerRow[]
  readonly sidecar: readonly SidecarRow[]
  /** Null when the dialect is unknown, which skips the D7 check. */
  readonly userTables: UserTables | null
}

/** D5 — the same migration name recorded more than once. */
export function duplicateLedgerRows(ledger: readonly LedgerRow[]): readonly Finding[] {
  const counts = new Map<MigrationName, number>()
  for (const row of ledger) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)

  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ code: "D5", name, count }) as const)
}

/** D7 — nothing recorded, yet the database already holds user tables. */
export function emptyLedgerOnLiveDatabase(
  ledger: readonly LedgerRow[],
  userTables: UserTables | null,
): readonly Finding[] {
  if (ledger.length > 0 || userTables === null || userTables.count === 0) return []
  return [{ code: "D7", tables: userTables }]
}

/** D2 — a ledger row whose migration file is gone. */
export function orphanedLedgerRows(
  ledger: readonly LedgerRow[],
  files: readonly MigrationFile[],
): readonly Finding[] {
  const onDisk = new Set(files.map((file) => file.name))
  const seen = new Set<MigrationName>()

  return ledger.flatMap((row) => {
    if (onDisk.has(row.name) || seen.has(row.name)) return []
    seen.add(row.name)
    return [{ code: "D2", name: row.name, batch: row.batch } as const]
  })
}

/** D3 — the file content no longer matches the checksum recorded when it ran. */
export function changedAfterApply(input: CheckInput): readonly Finding[] {
  const fileByName = new Map(input.files.map((file) => [file.name, file]))
  const recordedByName = new Map(input.sidecar.map((row) => [row.name, row.checksum]))
  const seen = new Set<MigrationName>()

  return input.ledger.flatMap((row) => {
    if (seen.has(row.name)) return []
    seen.add(row.name)

    const file = fileByName.get(row.name)
    const recorded = recordedByName.get(row.name)
    if (file === undefined || recorded === undefined || recorded === file.checksum) return []

    return [
      {
        code: "D3",
        name: row.name,
        recorded,
        actual: file.checksum,
        batch: row.batch,
      } as const,
    ]
  })
}

/**
 * D4 — a pending file sorts before the newest applied one. knex would run it
 * next, so a rebuilt database applies it in a different order than production.
 */
export function outOfOrderPending(
  ledger: readonly LedgerRow[],
  files: readonly MigrationFile[],
): readonly Finding[] {
  const applied = new Set(ledger.map((row) => row.name))
  const latestApplied = [...applied].sort().at(-1)
  if (latestApplied === undefined) return []

  return files
    .filter((file) => !applied.has(file.name) && file.name < latestApplied)
    .map((file) => ({ code: "D4", name: file.name, latestApplied }) as const)
}

/** Applied migrations with no recorded checksum, so D3 cannot speak for them. */
export function unverifiedMigrations(input: CheckInput): readonly Finding[] {
  const recorded = new Set(input.sidecar.map((row) => row.name))
  const onDisk = new Set(input.files.map((file) => file.name))

  const missing = input.ledger
    .map((row) => row.name)
    .filter((name) => onDisk.has(name) && !recorded.has(name))

  const oldest = missing[0]
  if (oldest === undefined) return []
  return [{ code: "UNVERIFIED", count: new Set(missing).size, oldest }]
}

/** Runs every check that compares the migration files against the ledger. */
export function runChecks(input: CheckInput): readonly Finding[] {
  return [
    ...emptyLedgerOnLiveDatabase(input.ledger, input.userTables),
    ...duplicateLedgerRows(input.ledger),
    ...changedAfterApply(input),
    ...outOfOrderPending(input.ledger, input.files),
    ...orphanedLedgerRows(input.ledger, input.files),
    ...unverifiedMigrations(input),
  ]
}
