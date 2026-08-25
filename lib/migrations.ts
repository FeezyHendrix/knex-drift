import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { type MigrationFile, migrationName, sha256 } from "./types.js"

/**
 * Copied verbatim from knex `lib/migrations/common/MigrationsLoader.js` so that
 * this tool sees exactly the files knex sees. Note that knex omits `.mjs`.
 */
export const DEFAULT_LOAD_EXTENSIONS = [
  ".co",
  ".coffee",
  ".eg",
  ".iced",
  ".js",
  ".cjs",
  ".litcoffee",
  ".ls",
  ".ts",
] as const

export type MigrationScanOptions = {
  readonly directories: readonly string[]
  readonly loadExtensions: readonly string[]
  readonly sortDirsSeparately: boolean
  readonly normalizeEol: boolean
}

type FoundFile = { readonly file: string; readonly directory: string }

async function listDirectory(directory: string, cwd: string): Promise<readonly FoundFile[]> {
  const absolute = path.resolve(cwd, directory)
  const entries = await readdir(absolute)
  return entries.map((file) => ({ file, directory: absolute }))
}

function byFileName(a: FoundFile, b: FoundFile): number {
  if (a.file < b.file) return -1
  if (a.file > b.file) return 1
  return 0
}

/**
 * Hashes the file content. When `normalizeEol` is set, carriage returns are
 * removed first, so a Windows checkout does not report every file as changed.
 */
export function digest(content: Buffer, normalizeEol: boolean): string {
  const bytes = normalizeEol
    ? Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"))
    : content
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Lists every migration file knex would load, in knex's order, each with its
 * content digest. Reads run concurrently: the file system, not the hash,
 * dominates the cost.
 */
export async function scanMigrations(
  options: MigrationScanOptions,
  cwd: string = process.cwd(),
): Promise<readonly MigrationFile[]> {
  const perDirectory = await Promise.all(
    options.directories.map((directory) => listDirectory(directory, cwd)),
  )

  const collected = options.sortDirsSeparately
    ? perDirectory.flatMap((files) => [...files].sort(byFileName))
    : [...perDirectory.flat()].sort(byFileName)

  const migrations = collected.filter((found) =>
    options.loadExtensions.includes(path.extname(found.file)),
  )

  return Promise.all(
    migrations.map(async (found) => {
      const full = path.join(found.directory, found.file)
      const content = await readFile(full)
      return {
        name: migrationName(found.file),
        path: full,
        checksum: sha256(digest(content, options.normalizeEol)),
      }
    }),
  )
}
