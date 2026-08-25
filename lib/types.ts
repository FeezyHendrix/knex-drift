declare const brand: unique symbol

/** Attaches a compile-time-only tag so two strings with different meanings cannot mix. */
export type Brand<T, B extends string> = T & { readonly [brand]: B }

/** The file name of a migration, exactly as knex records it in the ledger. */
export type MigrationName = Brand<string, "MigrationName">

/** A lowercase hex SHA-256 digest. */
export type Sha256 = Brand<string, "Sha256">

export function migrationName(value: string): MigrationName {
  return value as MigrationName
}

export function sha256(value: string): Sha256 {
  return value as Sha256
}

/** A migration file found on disk, with its content digest. */
export type MigrationFile = {
  readonly name: MigrationName
  readonly path: string
  readonly checksum: Sha256
}

/** One row of the knex ledger table (`knex_migrations` by default). */
export type LedgerRow = {
  readonly name: MigrationName
  readonly batch: number | null
}

/** One row of the sidecar checksum table (`knex_drift_migrations` by default). */
export type SidecarRow = {
  readonly name: MigrationName
  readonly checksum: Sha256
}

/** Evidence that the database holds user tables, used by the D7 check. */
export type UserTables = {
  readonly count: number
  readonly sample: readonly string[]
}

/**
 * One disagreement between the migration files, the ledger, and the database.
 * The `code` field discriminates the union; every consumer matches it exhaustively.
 */
export type Finding =
  | {
      readonly code: "D2"
      readonly name: MigrationName
      readonly batch: number | null
    }
  | {
      readonly code: "D3"
      readonly name: MigrationName
      readonly recorded: Sha256
      readonly actual: Sha256
      readonly batch: number | null
    }
  | {
      readonly code: "D4"
      readonly name: MigrationName
      readonly latestApplied: MigrationName
    }
  | {
      readonly code: "D5"
      readonly name: MigrationName
      readonly count: number
    }
  | {
      readonly code: "D7"
      readonly tables: UserTables
    }
  | {
      readonly code: "UNVERIFIED"
      readonly count: number
      readonly oldest: MigrationName
    }

export type DriftCode = Finding["code"]

export type Severity = "block" | "warn" | "info"

/**
 * D2 warns rather than blocks: knex itself already throws on a missing file
 * unless `disableMigrationsListValidation` is set, and squashing migrations is
 * a legitimate workflow that produces D2 on purpose.
 */
export const SEVERITY_BY_CODE = {
  D2: "warn",
  D3: "block",
  D4: "block",
  D5: "block",
  D7: "block",
  UNVERIFIED: "info",
} as const satisfies Record<DriftCode, Severity>

export function severityOf(finding: Finding): Severity {
  return SEVERITY_BY_CODE[finding.code]
}

/** Process exit codes. `warn` becomes `block` under `--strict`. */
export const EXIT = {
  clean: 0,
  block: 1,
  warn: 2,
  error: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`)
}
