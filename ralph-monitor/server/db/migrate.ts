// Migration runner. Reads PRAGMA user_version, applies any MIGRATIONS whose
// version is strictly greater, and bumps user_version after each migration.
// Each migration is wrapped in a single transaction so partial failures roll
// back cleanly. Running the runner twice on the same DB is a no-op.

import type { Database } from 'bun:sqlite'
import { MIGRATIONS, type Migration } from './schema'

export function runMigrations(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  const current = row?.user_version ?? 0

  // MIGRATIONS is authored in version order, but defensively sort so an
  // out-of-order entry can't sneak through.
  const pending: Migration[] = MIGRATIONS
    .filter(m => m.version > current)
    .sort((a, b) => a.version - b.version)

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql)
      // PRAGMA user_version cannot be parameterized; the value is an integer
      // sourced from our own array, so string interpolation is safe here.
      db.exec(`PRAGMA user_version = ${m.version}`)
    })()
  }
}
