import {
  assertNever,
  EXIT,
  type ExitCode,
  type Finding,
  type Severity,
  severityOf,
} from "./types.js"

const LABEL: Record<Severity, string> = { block: "FAIL", warn: "WARN", info: "INFO" }

function short(hash: string): string {
  return hash.slice(0, 12)
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

type Rendered = {
  readonly title: string
  readonly detail: readonly string[]
  readonly fix: readonly string[]
}

function render(finding: Finding): Rendered {
  switch (finding.code) {
    case "D2":
      return {
        title: "a ledger row has no migration file",
        detail: [`${finding.name}`, `  recorded in batch ${finding.batch ?? "unknown"}`],
        fix: [
          "Restore the file, or accept the loss if the migrations were squashed.",
          "knex itself throws on this unless disableMigrationsListValidation is set.",
        ],
      }
    case "D3":
      return {
        title: "a migration changed after it was applied",
        detail: [
          `${finding.name}`,
          `  recorded  ${short(finding.recorded)}  (batch ${finding.batch ?? "unknown"})`,
          `  on disk   ${short(finding.actual)}`,
        ],
        fix: [
          "This database has the OLD behaviour; a rebuilt one gets the NEW behaviour.",
          "Restore the file content, or write a NEW migration for the change.",
        ],
      }
    case "D4":
      return {
        title: "a pending migration sorts before an applied one",
        detail: [`${finding.name}`, `  newest applied: ${finding.latestApplied}`],
        fix: [
          "knex runs it next, so a rebuilt database applies a different order.",
          "Rename the file with a timestamp later than the newest applied one.",
        ],
      }
    case "D5":
      return {
        title: "a migration is recorded more than once",
        detail: [`${finding.name}`, `  ${finding.count} ledger rows`],
        fix: [
          "Rollback picks the wrong batch while duplicates exist.",
          "Delete the extra rows, keeping the earliest.",
        ],
      }
    case "D7":
      return {
        title: "the ledger is empty but the database holds tables",
        detail: [
          `${finding.tables.count} user tables, for example: ${finding.tables.sample.join(", ")}`,
        ],
        fix: [
          "knex migrate:latest would replay every migration onto this database.",
          "Record the current state first, then migrate.",
        ],
      }
    case "UNVERIFIED":
      return {
        title: "applied migrations have no recorded checksum",
        detail: [`${finding.count} migrations, oldest: ${finding.oldest}`],
        fix: [
          "No checksum is stored for these, so a later edit to them cannot be found.",
          "Run: knex-drift record --all",
        ],
      }
    default:
      return assertNever(finding)
  }
}

function block(finding: Finding, strict: boolean): string {
  const severity = effectiveSeverity(finding, strict)
  const { title, detail, fix } = render(finding)
  const lines = [
    `${LABEL[severity]}  ${finding.code}  ${title}`,
    "",
    ...detail.map((line) => `  ${line}`),
    "",
    ...fix.map((line) => `  ${line}`),
  ]
  return lines.join("\n")
}

function effectiveSeverity(finding: Finding, strict: boolean): Severity {
  const severity = severityOf(finding)
  return strict && severity === "warn" ? "block" : severity
}

export function exitCodeFor(findings: readonly Finding[], strict: boolean): ExitCode {
  const severities = findings.map((finding) => effectiveSeverity(finding, strict))
  if (severities.includes("block")) return EXIT.block
  if (severities.includes("warn")) return EXIT.warn
  return EXIT.clean
}

export function formatHuman(findings: readonly Finding[], strict: boolean): string {
  if (findings.length === 0) return "OK  files, ledger and database agree"

  const counts = { block: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[effectiveSeverity(finding, strict)] += 1

  const summary = [
    plural(counts.block, "blocking issue"),
    plural(counts.warn, "warning"),
    plural(counts.info, "note"),
  ].join(", ")
  return [...findings.map((finding) => block(finding, strict)), summary].join("\n\n")
}

export function formatJson(findings: readonly Finding[], strict: boolean): string {
  return JSON.stringify(
    {
      ok: exitCodeFor(findings, strict) === EXIT.clean,
      findings: findings.map((finding) => ({
        ...finding,
        severity: effectiveSeverity(finding, strict),
        message: render(finding).title,
      })),
    },
    null,
    2,
  )
}
