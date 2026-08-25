#!/usr/bin/env node
import { Command } from "commander"
import knexFactory, { type Knex } from "knex"
import { DriftConfigError, loadConfig, type ResolvedConfig } from "./config.js"
import { exitCodeFor, formatHuman, formatJson } from "./report.js"
import { EXIT, type ExitCode } from "./types.js"
import { record, verify } from "./verify.js"

type CommonOptions = {
  readonly config?: string
  readonly cwd?: string
}

function write(text: string): void {
  process.stdout.write(`${text}\n`)
}

async function withKnex<T>(
  options: CommonOptions,
  run: (knex: Knex, config: ResolvedConfig, cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = options.cwd ?? process.cwd()
  const config = await loadConfig(options.config, cwd)
  const knex = knexFactory(config.knexConfig)
  try {
    return await run(knex, config, cwd)
  } finally {
    await knex.destroy()
  }
}

type VerifyOptions = CommonOptions & {
  readonly strict?: boolean
  readonly json?: boolean
}

async function runVerify(options: VerifyOptions): Promise<ExitCode> {
  const strict = options.strict === true
  const findings = await withKnex(options, (knex, config, cwd) => verify(knex, config, cwd))
  write(options.json === true ? formatJson(findings, strict) : formatHuman(findings, strict))
  return exitCodeFor(findings, strict)
}

async function runRecord(options: CommonOptions & { readonly all?: boolean }): Promise<ExitCode> {
  const all = options.all === true
  const written = await withKnex(options, (knex, config, cwd) => record(knex, config, { all }, cwd))
  write(
    written === 0
      ? "OK  every applied migration already has a checksum"
      : `OK  recorded ${written} checksum${written === 1 ? "" : "s"}`,
  )
  return EXIT.clean
}

function build(): Command {
  const program = new Command()
    .name("knex-drift")
    .description("Detect drift between knex migration files, the ledger, and the database.")
    .version("0.1.0")

  program
    .command("verify")
    .description("Compare the migration files with the ledger. Writes nothing.")
    .option("--pre", "run only the checks that are safe before a migration (the default today)")
    .option("--strict", "treat warnings as blocking")
    .option("--json", "print machine-readable output")
    .option("-c, --config <path>", "path to drift.config.js")
    .option("--cwd <path>", "directory to resolve paths from")
    .action(async (options: VerifyOptions) => {
      process.exitCode = await runVerify(options)
    })

  program
    .command("record")
    .description("Store the checksum of applied migrations in the sidecar table.")
    .option("--all", "record every applied migration, not only the newest batch")
    .option("-c, --config <path>", "path to drift.config.js")
    .option("--cwd <path>", "directory to resolve paths from")
    .action(async (options: CommonOptions & { readonly all?: boolean }) => {
      process.exitCode = await runRecord(options)
    })

  return program
}

async function main(): Promise<void> {
  // no-excuse-ok: catch
  try {
    await build().parseAsync(process.argv)
  } catch (error) {
    if (error instanceof DriftConfigError) {
      process.stderr.write(`ERROR  ${error.message}\n`)
      process.exitCode = EXIT.error
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ERROR  ${message}\n`)
    process.exitCode = EXIT.error
  }
}

await main()
