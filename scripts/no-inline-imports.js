/**
 * Lint rule: ban inline import() type expressions.
 *
 * Catches patterns like:
 *   readonly plugin?: import('./adapter.js').VendorPlugin | undefined
 *
 * These create implicit dependencies that are hard to track.
 * Use top-level `import type { ... } from '...'` instead.
 *
 * Runtime dynamic imports (`await import(...)`) are allowed.
 */

import { execSync } from 'node:child_process'

const result = execSync(
  "grep -rn --include='*.ts' --include='*.tsx' 'import(.' packages/*/src/ || true",
  { encoding: 'utf8' },
)

const violations = result
  .split('\n')
  .filter((line) => {
    if (line.trim() === '') return false
    // Allow runtime dynamic imports (await import, .then())
    if (line.includes('await import(')) return false
    if (line.includes('.then(')) return false
    // Allow import() in JSDoc comments
    if (line.includes('* ') || line.includes('//')) return false
    // Must contain import('...'). followed by a type name (capital letter)
    return /import\(['"].*['"]\)\.\w/.test(line)
  })

if (violations.length > 0) {
  console.error('Inline import() type expressions found. Use top-level imports instead:\n')
  for (const line of violations) {
    console.error(`  ${line}`)
  }
  process.exit(1)
}
