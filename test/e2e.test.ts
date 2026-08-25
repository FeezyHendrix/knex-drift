import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { Knex } from "knex"
import knexFactory from "knex"
import { loadConfig } from "../dist/config.js"
import { exitCodeFor } from "../dist/report.js"
import type { Finding } from "../dist/types.js"
import { record, verify } from "../dist/verify.js"

const FIRST = "20240101000000_users.cjs"
const SECOND = "20240102000000_orders.cjs"

function migrationSource(table: string): string {
  return [
    `exports.up = (knex) => knex.schema.createTable('${table}', (t) => {`,
    "  t.increments('id')",
    "  t.string('label')",
    "})",
    `exports.down = (knex) => knex.schema.dropTable('${table}')`,
    "",
  ].join("\n")
}

type Project = {
  readonly root: string
  readonly knex: Knex
  readonly cleanup: () => Promise<void>
}

async function makeProject(): Promise<Project> {
  const root = await mkdtemp(path.join(tmpdir(), "knex-drift-e2e-"))
  const migrations = path.join(root, "migrations")
  await mkdir(migrations, { recursive: true })

  await Promise.all([
    writeFile(path.join(migrations, FIRST), migrationSource("users")),
    writeFile(path.join(migrations, SECOND), migrationSource("orders")),
    writeFile(
      path.join(root, "knexfile.cjs"),
      [
        "module.exports = {",
        "  client: 'better-sqlite3',",
        `  connection: { filename: ${JSON.stringify(path.join(root, "data.sqlite"))} },`,
        "  useNullAsDefault: true,",
        `  migrations: { directory: ${JSON.stringify(migrations)} },`,
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(root, "drift.config.cjs"),
      "module.exports = { knexfile: './knexfile.cjs' }\n",
    ),
  ])

  const knex = knexFactory({
    client: "better-sqlite3",
    connection: { filename: path.join(root, "data.sqlite") },
    useNullAsDefault: true,
    migrations: { directory: migrations },
  })

  return {
    root,
    knex,
    cleanup: async () => {
      await knex.destroy()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function check(project: Project): Promise<readonly Finding[]> {
  const config = await loadConfig("drift.config.cjs", project.root)
  return verify(project.knex, config, project.root)
}

async function recordAll(project: Project): Promise<number> {
  const config = await loadConfig("drift.config.cjs", project.root)
  return record(project.knex, config, { all: true }, project.root)
}

function codes(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => finding.code)
}

describe("a normal deploy", () => {
  it("reports UNVERIFIED before checksums exist, then nothing after record", async () => {
    const project = await makeProject()
    try {
      // Given: two migrations applied by real knex
      await project.knex.migrate.latest()

      // When: verify runs before any checksum is stored
      const before = await check(project)

      // Then: the tool says so, and does not block the deploy
      assert.deepEqual(codes(before), ["UNVERIFIED"])
      assert.equal(exitCodeFor(before, false), 0)

      // When: the checksums are recorded
      const written = await recordAll(project)

      // Then: both migrations are covered and nothing is left to report
      assert.equal(written, 2)
      assert.deepEqual(codes(await check(project)), [])
    } finally {
      await project.cleanup()
    }
  })

  it("records only the newest batch by default", async () => {
    const project = await makeProject()
    try {
      await project.knex.migrate.up()
      const config = await loadConfig("drift.config.cjs", project.root)
      await record(project.knex, config, { all: false }, project.root)
      await project.knex.migrate.up()

      // Given: batch 1 is recorded, batch 2 is not
      const findings = await check(project)
      assert.deepEqual(codes(findings), ["UNVERIFIED"])

      // When: the deploy records the newest batch
      assert.equal(await record(project.knex, config, { all: false }, project.root), 1)
      assert.deepEqual(codes(await check(project)), [])
    } finally {
      await project.cleanup()
    }
  })
})

describe("a migration edited after it was applied", () => {
  it("blocks with D3 and names the file", async () => {
    const project = await makeProject()
    try {
      await project.knex.migrate.latest()
      await recordAll(project)

      // When: somebody edits a file that already ran
      await appendFile(path.join(project.root, "migrations", FIRST), "// a later edit\n")

      // Then: the gate blocks, and points at that exact file
      const findings = await check(project)
      const changed = findings.filter((finding) => finding.code === "D3")
      assert.equal(changed.length, 1)
      assert.equal(changed[0]?.code === "D3" ? changed[0].name : "", FIRST)
      assert.equal(exitCodeFor(findings, false), 1)
    } finally {
      await project.cleanup()
    }
  })
})

describe("a migration added with an earlier timestamp", () => {
  it("blocks with D4 and names the newest applied migration", async () => {
    const project = await makeProject()
    try {
      await project.knex.migrate.latest()
      await recordAll(project)

      // When: a new file is added that sorts before everything applied
      await writeFile(
        path.join(project.root, "migrations", "20231231000000_early.cjs"),
        migrationSource("early"),
      )

      const findings = await check(project)
      const outOfOrder = findings.filter((finding) => finding.code === "D4")
      assert.equal(outOfOrder.length, 1)
      assert.equal(outOfOrder[0]?.code === "D4" ? outOfOrder[0].latestApplied : "", SECOND)
      assert.equal(exitCodeFor(findings, false), 1)
    } finally {
      await project.cleanup()
    }
  })
})

describe("a database that already has tables but an empty ledger", () => {
  it("blocks with D7 rather than letting knex replay every migration", async () => {
    const project = await makeProject()
    try {
      // Given: a table created outside migrations, and nothing in the ledger
      await project.knex.schema.createTable("legacy_orders", (table) => {
        table.increments("id")
      })

      const findings = await check(project)
      const empty = findings.filter((finding) => finding.code === "D7")
      assert.equal(empty.length, 1)
      assert.equal(empty[0]?.code === "D7" ? empty[0].tables.count : -1, 1)
      assert.equal(exitCodeFor(findings, false), 1)
    } finally {
      await project.cleanup()
    }
  })
})
