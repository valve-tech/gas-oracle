#!/usr/bin/env node
// Pulls the upstream TrueBlocks OpenAPI 3.1 spec from a pinned commit
// of TrueBlocks/trueblocks-core, runs openapi-typescript against it,
// and writes the result to src/generated.ts.
//
// The pinned SHA is intentional — floating refs would make codegen
// non-reproducible across builds. To bump, replace SPEC_SHA with a
// newer commit, re-run `yarn codegen`, and review the diff in
// src/generated.ts before committing.

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'

const SPEC_SHA = '3205a003af599adf2229408f74afbe6952391883'
const SPEC_URL = `https://raw.githubusercontent.com/TrueBlocks/trueblocks-core/${SPEC_SHA}/docs/content/api/openapi.yaml`

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'src', 'generated.ts')

const HEADER = `/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * Source: ${SPEC_URL}
 * Tool:   openapi-typescript
 *
 * Re-run with \`yarn codegen\` from this package to refresh.
 */

`

console.log(`Pulling spec from ${SPEC_URL}`)
const raw = await (await fetch(SPEC_URL)).text()

// Upstream spec bug at this SHA: components.schemas.destination.termType
// is declared `type: object` with an `items.$ref: destType`, but the
// destType schema is never defined. openapi-typescript rejects the dangling
// ref. Replace the bogus block with a plain string type so codegen succeeds.
// Remove this patch once upstream fixes the spec.
const patched = raw.replace(
  /termType:\s*\n\s*type: object\s*\n\s*items:\s*\n\s*\$ref:\s*"#\/components\/schemas\/destType"\s*\n\s*description: "the type of the term"/,
  'termType:\n          type: string\n          description: "the type of the term"',
)
if (patched === raw) {
  console.warn(
    'WARNING: termType patch did not match — upstream may have fixed it. Remove the patch from codegen.mjs.',
  )
}

const ast = await openapiTS(patched)
const body = astToString(ast)
writeFileSync(OUT, HEADER + body, 'utf8')
console.log(`Wrote ${OUT}`)
