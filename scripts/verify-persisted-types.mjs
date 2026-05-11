#!/usr/bin/env node
/**
 * Verify the persisted-type manifest matches the source.
 *
 * Why: TypeScript types that cross a serialization boundary (the
 * `TxTrackerStore` interface, the `tx-flight-react` storage adapters,
 * etc.) are *wire formats* — adding a new non-optional field to one
 * is a breaking change for any consumer with prior state on disk
 * (the field reads as `undefined` at runtime even though the static
 * type says it's present). The canonical instance was
 * `@valve-tech/tx-tracker` v0.11.0 → v0.11.1: a new
 * `TxStatus.terminalAtBlockNumber: bigint | null` field, plus a
 * strict-null check (`t !== null`) at the read site, plus legacy
 * persisted records lacking the field, equalled a silent crash
 * inside `Subscriptions.emit` that halted the in-flight fanout.
 *
 * This script enforces a discipline: every field on a registered
 * persisted type must appear in `persisted-types.manifest.json`.
 * The manifest is checked into the repo. When a field is added
 * (or removed), this script fails until the manifest is updated.
 *
 * Updating the manifest forces the maintainer to ask one question:
 * "Is this field optional, defensive-on-read, or migration-safe?"
 * If the answer is "no" for all three, the change is unsafe.
 *
 * See `feedback_persisted_type_evolution.md` in project memory for
 * the full lessons-learned note from the v0.11.0 incident.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = resolve(ROOT, 'scripts/persisted-types.manifest.json')

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

/**
 * Extract field names from a TypeScript interface declaration. Looks
 * for the named interface, finds the matching outer braces, and
 * returns the top-level field names (skipping nested object types).
 *
 * Top-level field heuristic: a line whose leading whitespace is
 * exactly 2 spaces (matching the workspace's prettier-style indent),
 * followed by an identifier and either `:` or `?:`. Nested object
 * fields are 4+ space indented and so are skipped. JSDoc / comments
 * are line-prefixed and so are skipped.
 */
const extractInterfaceFields = (source, interfaceName) => {
  const lines = source.split('\n')
  let inInterface = false
  let braceDepth = 0
  const fields = []
  const interfaceStart = new RegExp(
    `\\binterface\\s+${interfaceName}\\b`,
  )
  for (const line of lines) {
    if (!inInterface && interfaceStart.test(line)) {
      inInterface = true
      braceDepth = 0
    }
    if (!inInterface) continue
    // Capture depth at line start BEFORE consuming braces — a
    // top-level field whose type opens an inline object (e.g.
    // `lastSeenInBlock: { ... } | null`) is declared at depth 1
    // and only dips into depth 2 partway through the line.
    const depthAtLineStart = braceDepth
    for (const ch of line) {
      if (ch === '{') braceDepth += 1
      else if (ch === '}') braceDepth -= 1
    }
    if (depthAtLineStart === 1) {
      const fieldMatch = line.match(/^  (\w+)\s*\??:\s/)
      if (fieldMatch) fields.push(fieldMatch[1])
    }
    if (inInterface && braceDepth === 0) {
      break
    }
  }
  return fields
}

let hasErrors = false

for (const typeDecl of manifest.types) {
  const declFilePath = resolve(ROOT, typeDecl.declarationFile)
  let source
  try {
    source = readFileSync(declFilePath, 'utf8')
  } catch (err) {
    console.error(
      `✗ ${typeDecl.name}: declaration file ${typeDecl.declarationFile} not readable: ${err.message}`,
    )
    hasErrors = true
    continue
  }

  const actualFields = extractInterfaceFields(source, typeDecl.name)
  if (actualFields.length === 0) {
    console.error(
      `✗ ${typeDecl.name}: interface declaration not found in ${typeDecl.declarationFile} (or had no top-level fields)`,
    )
    hasErrors = true
    continue
  }

  const manifestSet = new Set(typeDecl.fields)
  const actualSet = new Set(actualFields)
  const added = actualFields.filter((f) => !manifestSet.has(f))
  const removed = typeDecl.fields.filter((f) => !actualSet.has(f))

  if (added.length === 0 && removed.length === 0) {
    console.log(
      `✓ ${typeDecl.name} (${typeDecl.fields.length} fields): manifest matches source`,
    )
    continue
  }

  if (added.length > 0) {
    console.error(
      `✗ ${typeDecl.name}: new field(s) not in manifest: ${added.join(', ')}`,
    )
    console.error(
      `  This is a wire-format change. Before adding to scripts/persisted-types.manifest.json, confirm that EACH new field:`,
    )
    console.error(`    (a) is declared optional (\`field?: T\`), OR`)
    console.error(`    (b) has a runtime defensive read at every site (\`typeof x === ...\` / \`x ?? default\` / \`x == null\`), OR`)
    console.error(`    (c) ships with a store migration that backfills it.`)
    console.error(
      `  See feedback_persisted_type_evolution.md in project memory for the v0.11.1 instance.`,
    )
  }
  if (removed.length > 0) {
    console.error(
      `✗ ${typeDecl.name}: field(s) in manifest but not in source: ${removed.join(', ')}`,
    )
    console.error(
      `  Removed fields are also breaking changes for legacy persisted records (deserialized reads would lose data).`,
    )
    console.error(
      `  Either restore the field, or update the manifest AND bump a major version with migration notes in the CHANGELOG.`,
    )
  }
  hasErrors = true
}

if (hasErrors) {
  process.exit(1)
} else {
  console.log('')
  console.log(
    `✓ All ${manifest.types.length} persisted types match the manifest. No wire-format drift detected.`,
  )
}
