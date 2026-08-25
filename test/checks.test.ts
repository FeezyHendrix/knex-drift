import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { type CheckInput, runChecks } from "../dist/checks.js"
import type { Finding, LedgerRow, MigrationFile, SidecarRow } from "../dist/types.js"
import { migrationName, sha256 } from "../dist/types.js"

function file(name: string, checksum: string): MigrationFile {
  return { name: migrationName(name), path: `/tmp/${name}`, checksum: sha256(checksum) }
}

function ledgerRow(name: string, batch: number | null = 1): LedgerRow {
  return { name: migrationName(name), batch }
}

function sidecarRow(name: string, checksum: string): SidecarRow {
  return { name: migrationName(name), checksum: sha256(checksum) }
}

function input(partial: Partial<CheckInput>): CheckInput {
  return {
    files: partial.files ?? [],
    ledger: partial.ledger ?? [],
    sidecar: partial.sidecar ?? [],
    userTables: partial.userTables ?? null,
  }
}

function codes(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => finding.code)
}

function only<C extends Finding["code"]>(
  findings: readonly Finding[],
  code: C,
): Extract<Finding, { code: C }> {
  const matching = findings.filter(
    (finding): finding is Extract<Finding, { code: C }> => finding.code === code,
  )
  assert.equal(matching.length, 1, `expected exactly one ${code}, got ${codes(findings).join(",")}`)
  const first = matching[0]
  assert.ok(first)
  return first
}

describe("D3 — a migration changed after it was applied", () => {
  it("reports the recorded and the actual digest when they differ", () => {
    // Given: the ledger and the sidecar say the file hashed to "aaa" when it ran
    const findings = runChecks(
      input({
        files: [file("001_users.js", "bbb")],
        ledger: [ledgerRow("001_users.js", 7)],
        sidecar: [sidecarRow("001_users.js", "aaa")],
      }),
    )

    // When / Then: the file now hashes to "bbb", so D3 fires with both digests
    const finding = only(findings, "D3")
    assert.equal(finding.name, "001_users.js")
    assert.equal(finding.recorded, "aaa")
    assert.equal(finding.actual, "bbb")
    assert.equal(finding.batch, 7)
  })

  it("stays silent when the digest still matches", () => {
    const findings = runChecks(
      input({
        files: [file("001_users.js", "aaa")],
        ledger: [ledgerRow("001_users.js")],
        sidecar: [sidecarRow("001_users.js", "aaa")],
      }),
    )
    assert.deepEqual(codes(findings), [])
  })

  it("stays silent when no checksum was ever recorded", () => {
    // Given: a migration applied before the tool was installed
    const findings = runChecks(
      input({ files: [file("001_users.js", "bbb")], ledger: [ledgerRow("001_users.js")] }),
    )
    // Then: it is UNVERIFIED, not D3 — the tool must not invent a mismatch
    assert.deepEqual(codes(findings), ["UNVERIFIED"])
  })
})

describe("D4 — a pending migration sorts before an applied one", () => {
  it("reports the pending file and the newest applied name", () => {
    const findings = runChecks(
      input({
        files: [file("001_a.js", "x"), file("002_late.js", "y"), file("003_c.js", "z")],
        ledger: [ledgerRow("001_a.js"), ledgerRow("003_c.js")],
        sidecar: [sidecarRow("001_a.js", "x"), sidecarRow("003_c.js", "z")],
      }),
    )
    const finding = only(findings, "D4")
    assert.equal(finding.name, "002_late.js")
    assert.equal(finding.latestApplied, "003_c.js")
  })

  it("stays silent when the pending file sorts after everything applied", () => {
    const findings = runChecks(
      input({
        files: [file("001_a.js", "x"), file("004_new.js", "w")],
        ledger: [ledgerRow("001_a.js")],
        sidecar: [sidecarRow("001_a.js", "x")],
      }),
    )
    assert.deepEqual(codes(findings), [])
  })
})

describe("D5 — a migration recorded more than once", () => {
  it("counts the rows for the repeated name", () => {
    const findings = runChecks(
      input({
        files: [file("001_a.js", "x")],
        ledger: [ledgerRow("001_a.js", 1), ledgerRow("001_a.js", 2)],
        sidecar: [sidecarRow("001_a.js", "x")],
      }),
    )
    const finding = only(findings, "D5")
    assert.equal(finding.name, "001_a.js")
    assert.equal(finding.count, 2)
  })
})

describe("D2 — a ledger row with no file", () => {
  it("reports the name once, even when the row is duplicated", () => {
    const findings = runChecks(
      input({ ledger: [ledgerRow("001_gone.js", 3), ledgerRow("001_gone.js", 3)] }),
    )
    const finding = only(findings, "D2")
    assert.equal(finding.name, "001_gone.js")
    assert.equal(finding.batch, 3)
  })
})

describe("D7 — an empty ledger on a live database", () => {
  it("reports the table count and a sample", () => {
    const findings = runChecks(input({ userTables: { count: 12, sample: ["orders", "users"] } }))
    const finding = only(findings, "D7")
    assert.equal(finding.tables.count, 12)
    assert.deepEqual(finding.tables.sample, ["orders", "users"])
  })

  it("stays silent when the database is empty too", () => {
    const findings = runChecks(input({ userTables: { count: 0, sample: [] } }))
    assert.deepEqual(codes(findings), [])
  })

  it("stays silent when the dialect is unknown", () => {
    // Given: countUserTables returned null because it cannot query this engine
    const findings = runChecks(input({ userTables: null }))
    // Then: the check is skipped rather than guessed
    assert.deepEqual(codes(findings), [])
  })
})

describe("UNVERIFIED — applied migrations with no recorded checksum", () => {
  it("counts distinct names and names the oldest in ledger order", () => {
    const findings = runChecks(
      input({
        files: [file("001_a.js", "x"), file("002_b.js", "y"), file("003_c.js", "z")],
        ledger: [ledgerRow("001_a.js"), ledgerRow("002_b.js"), ledgerRow("003_c.js")],
        sidecar: [sidecarRow("003_c.js", "z")],
      }),
    )
    const finding = only(findings, "UNVERIFIED")
    assert.equal(finding.count, 2)
    assert.equal(finding.oldest, "001_a.js")
  })
})
