import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { DEFAULT_LOAD_EXTENSIONS, digest, scanMigrations } from "../dist/migrations.js"

const options = {
  directories: ["migrations"],
  loadExtensions: [...DEFAULT_LOAD_EXTENSIONS],
  sortDirsSeparately: false,
  normalizeEol: true,
}

describe("digest", () => {
  it("gives the same value for CRLF and LF when normalizeEol is on", () => {
    const crlf = Buffer.from("exports.up = 1\r\nexports.down = 2\r\n")
    const lf = Buffer.from("exports.up = 1\nexports.down = 2\n")
    assert.equal(digest(crlf, true), digest(lf, true))
  })

  it("gives different values for CRLF and LF when normalizeEol is off", () => {
    const crlf = Buffer.from("exports.up = 1\r\n")
    const lf = Buffer.from("exports.up = 1\n")
    assert.notEqual(digest(crlf, false), digest(lf, false))
  })

  it("changes when one byte of content changes", () => {
    assert.notEqual(digest(Buffer.from("a"), true), digest(Buffer.from("b"), true))
  })
})

describe("scanMigrations", () => {
  let root = ""

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knex-drift-scan-"))
    const dir = path.join(root, "migrations")
    await writeFile(path.join(root, "placeholder"), "")
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }))
    await Promise.all([
      writeFile(path.join(dir, "003_c.js"), "// c"),
      writeFile(path.join(dir, "001_a.js"), "// a"),
      writeFile(path.join(dir, "002_b.js"), "// b"),
      writeFile(path.join(dir, "notes.md"), "not a migration"),
      writeFile(path.join(dir, "004_d.cjs"), "// d"),
    ])
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("returns files sorted by name, the order knex applies them in", async () => {
    const found = await scanMigrations(options, root)
    assert.deepEqual(
      found.map((migration) => migration.name),
      ["001_a.js", "002_b.js", "003_c.js", "004_d.cjs"],
    )
  })

  it("drops files whose extension knex would not load", async () => {
    const found = await scanMigrations(options, root)
    assert.equal(
      found.some((migration) => migration.name === "notes.md"),
      false,
    )
  })

  it("gives every file a distinct digest for distinct content", async () => {
    const found = await scanMigrations(options, root)
    const digests = new Set(found.map((migration) => migration.checksum))
    assert.equal(digests.size, found.length)
  })
})
