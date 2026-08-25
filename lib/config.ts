import { access } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Knex } from "knex"
import { z } from "zod"
import { DEFAULT_LOAD_EXTENSIONS, type MigrationScanOptions } from "./migrations.js"

export class DriftConfigError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = "DriftConfigError"
  }
}

const DriftFileSchema = z.object({
  knexfile: z.string().default("./knexfile.js"),
  environment: z.string().optional(),
  sidecarTableName: z.string().default("knex_drift_migrations"),
  /** Strip carriage returns before hashing so a Windows checkout is not all-drift. */
  normalizeEol: z.boolean().default(true),
})

const KnexMigrationsSchema = z.object({
  directory: z.union([z.string(), z.array(z.string())]).default("./migrations"),
  tableName: z.string().default("knex_migrations"),
  schemaName: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  loadExtensions: z.array(z.string()).default([...DEFAULT_LOAD_EXTENSIONS]),
  sortDirsSeparately: z.boolean().default(false),
})

export type ResolvedConfig = {
  readonly knexConfig: Knex.Config
  readonly scan: MigrationScanOptions
  readonly tableName: string
  readonly schemaName: string | null
  readonly sidecarTableName: string
  readonly environment: string
  readonly knexfilePath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function importFile(absolute: string, what: string): Promise<unknown> {
  try {
    const module: unknown = await import(pathToFileURL(absolute).href)
    if (isRecord(module) && "default" in module) return module["default"]
    return module
  } catch (error) {
    throw new DriftConfigError(`Could not load the ${what} at ${absolute}`, { cause: error })
  }
}

/**
 * A knexfile either exports one config, or a map keyed by environment.
 * This mirrors how the knex CLI decides between the two shapes.
 */
function selectEnvironment(loaded: unknown, environment: string): unknown {
  if (isRecord(loaded) && isRecord(loaded[environment])) return loaded[environment]
  return loaded
}

/**
 * Reads `drift.config.js` if present, then the knexfile it names, and returns
 * everything the checks need. Absent files fall back to knex's own defaults, so
 * a plain project needs no configuration at all.
 */
export async function loadConfig(
  configPath?: string,
  cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
  const driftPath = path.resolve(cwd, configPath ?? "drift.config.js")
  const raw =
    configPath !== undefined || (await exists(driftPath))
      ? await importFile(driftPath, "drift config")
      : {}

  const parsedDrift = DriftFileSchema.safeParse(raw)
  if (!parsedDrift.success) {
    throw new DriftConfigError(`Invalid drift config at ${driftPath}: ${parsedDrift.error.message}`)
  }
  const drift = parsedDrift.data

  const knexfilePath = path.resolve(cwd, drift.knexfile)
  if (!(await exists(knexfilePath))) {
    throw new DriftConfigError(
      `knexfile not found at ${knexfilePath}. Set "knexfile" in drift.config.js.`,
    )
  }

  const environment = drift.environment ?? process.env["NODE_ENV"] ?? "development"
  const knexConfig = selectEnvironment(await importFile(knexfilePath, "knexfile"), environment)

  if (!isRecord(knexConfig) || knexConfig["client"] === undefined) {
    throw new DriftConfigError(
      `The knexfile at ${knexfilePath} has no "client" for environment "${environment}".`,
    )
  }

  const parsedMigrations = KnexMigrationsSchema.safeParse(knexConfig["migrations"] ?? {})
  if (!parsedMigrations.success) {
    throw new DriftConfigError(
      `Invalid "migrations" section in ${knexfilePath}: ${parsedMigrations.error.message}`,
    )
  }
  const migrations = parsedMigrations.data

  return {
    knexConfig,
    environment,
    knexfilePath,
    tableName: migrations.tableName,
    schemaName: migrations.schemaName,
    sidecarTableName: drift.sidecarTableName,
    scan: {
      directories:
        typeof migrations.directory === "string" ? [migrations.directory] : migrations.directory,
      loadExtensions: migrations.loadExtensions,
      sortDirsSeparately: migrations.sortDirsSeparately,
      normalizeEol: drift.normalizeEol,
    },
  }
}
