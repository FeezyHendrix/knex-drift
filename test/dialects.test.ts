import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { Knex } from "knex"
import knexFactory from "knex"
import { runChecks } from "../dist/checks.js"
import type { ResolvedConfig } from "../dist/config.js"
import { countUserTables, type LedgerNames, readLedger, readSidecar } from "../dist/ledger.js"
import { scanMigrations } from "../dist/migrations.js"
import type { Finding } from "../dist/types.js"
import { record, verify } from "../dist/verify.js"

type Target = { readonly name: string; readonly config: Knex.Config }

const TARGETS: readonly Target[] = [
  {
    name: "postgresql",
    config: { client: "pg", connection: "postgres://testuser:knextest@localhost:25432/knex_test" },
  },
  {
    name: "mysql",
    config: {
      client: "mysql2",
      connection: {
        host: "localhost",
        port: 23306,
        user: "testuser",
        password: "testpassword",
        database: "knex_test",
      },
    },
  },
  {
    name: "mariadb",
    config: {
      client: "mysql2",
      connection: {
        host: "localhost",
        port: 23307,
        user: "testuser",
        password: "testpassword",
        database: "knex_test",
      },
    },
  },
  {
    name: "cockroachdb",
    config: {
      client: "cockroachdb",
      connection: "postgresql://root@localhost:26257/test?sslmode=disable",
    },
  },
  {
    name: "mssql",
    config: {
      client: "mssql",
      connection: {
        server: "localhost",
        port: 21433,
        user: "sa",
        password: "S0meVeryHardPassword",
        database: "knex_test",
        options: { encrypt: false, trustServerCertificate: true },
      },
    },
  },
]

async function unreachableReason(config: Knex.Config): Promise<string | null> {
  const knex = knexFactory(config)
  try {
    await knex.raw("select 1")
    return null
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 60) : "unreachable"
  } finally {
    await knex.destroy()
  }
}

const probes = await Promise.all(
  TARGETS.map(async (target) => ({ target, reason: await unreachableReason(target.config) })),
)

const MIGRATION = "20240101000000_first.cjs"

function codes(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => finding.code)
}

for (const { target, reason } of probes) {
  const skip = reason === null ? false : `unreachable — ${reason}`

  describe(`${target.name} (live)`, { skip }, () => {
    const id = `kd${Math.random().toString(36).slice(2, 8)}`
    const names: LedgerNames = {
      tableName: `${id}_mig`,
      schemaName: null,
      sidecarTableName: `${id}_sum`,
    }
    const userTable = `${id}_users`
    const strayTable = `${id}_stray`

    let root = ""
    let migrationsDir = ""
    let knex: Knex
    let config: ResolvedConfig

    after(async () => {
      if (knex === undefined) return
      for (const table of [
        userTable,
        strayTable,
        names.sidecarTableName,
        names.tableName,
        `${names.tableName}_lock`,
      ]) {
        await knex.schema.dropTableIfExists(table).catch(() => undefined)
      }
      await knex.destroy()
      await rm(root, { recursive: true, force: true })
    })

    it("catches an empty ledger on a populated database (D7)", async () => {
      root = await mkdtemp(path.join(tmpdir(), `knex-drift-${target.name}-`))
      migrationsDir = path.join(root, "migrations")
      await mkdir(migrationsDir, { recursive: true })
      await writeFile(
        path.join(migrationsDir, MIGRATION),
        [
          `exports.up = (knex) => knex.schema.createTable('${userTable}', (t) => {`,
          "  t.increments('id')",
          "  t.string('label', 100)",
          "})",
          `exports.down = (knex) => knex.schema.dropTable('${userTable}')`,
          "",
        ].join("\n"),
      )

      knex = knexFactory({
        ...target.config,
        migrations: { directory: migrationsDir, tableName: names.tableName },
      })
      config = {
        knexConfig: target.config,
        environment: "test",
        knexfilePath: "",
        tableName: names.tableName,
        schemaName: null,
        sidecarTableName: names.sidecarTableName,
        scan: {
          directories: [migrationsDir],
          loadExtensions: [".cjs"],
          sortDirsSeparately: false,
          normalizeEol: true,
        },
      }

      // Given: a table that no migration created, and nothing in the ledger
      await knex.schema.createTable(strayTable, (table) => table.increments("id"))

      // Then: the dialect's table query runs, and D7 fires
      const findings = await verify(knex, config, root)
      assert.ok(codes(findings).includes("D7"), `got ${codes(findings).join(",") || "nothing"}`)
    })

    it("records a checksum after a real knex migration, then verifies clean", async () => {
      // When: knex applies the migration for real against this engine
      await knex.migrate.latest()

      const applied = await readLedger(knex, names)
      assert.equal(applied.length, 1)
      assert.equal(applied[0]?.name, MIGRATION)
      assert.equal(applied[0]?.batch, 1, "batch must come back as a number, not a string")

      // Then: unverified until recorded, clean afterwards
      assert.deepEqual(codes(await verify(knex, config, root)), ["UNVERIFIED"])
      assert.equal(await record(knex, config, { all: true }, root), 1)

      const stored = await readSidecar(knex, names)
      assert.equal(stored.length, 1)
      assert.match(stored[0]?.checksum ?? "", /^[0-9a-f]{64}$/)
      assert.deepEqual(codes(await verify(knex, config, root)), [])
    })

    it("lists real tables and excludes its own bookkeeping tables", async () => {
      const tables = await countUserTables(knex, names)
      assert.notEqual(tables, null, "the dialect must be recognised, not skipped")
      assert.ok(tables !== null && tables.count > 0)

      for (const hidden of [names.tableName, `${names.tableName}_lock`, names.sidecarTableName]) {
        assert.equal(tables.sample.includes(hidden), false, `${hidden} must not be reported`)
      }
    })

    it("catches a file edited after it was applied (D3)", async () => {
      await appendFile(path.join(migrationsDir, MIGRATION), "// edited after apply\n")

      const findings = await verify(knex, config, root)
      const changed = findings.filter((finding) => finding.code === "D3")
      assert.equal(changed.length, 1, `got ${codes(findings).join(",") || "nothing"}`)
      assert.equal(changed[0]?.code === "D3" ? changed[0].name : "", MIGRATION)
    })

    it("feeds the pure checks data the driver actually returned", async () => {
      const [files, ledger, sidecar, userTables] = await Promise.all([
        scanMigrations(config.scan, root),
        readLedger(knex, names),
        readSidecar(knex, names),
        countUserTables(knex, names),
      ])

      assert.equal(files.length, 1)
      assert.equal(ledger.length, 1)
      assert.equal(sidecar.length, 1)
      assert.notEqual(userTables, null)
      assert.deepEqual(codes(runChecks({ files, ledger, sidecar, userTables })), ["D3"])
    })
  })
}
