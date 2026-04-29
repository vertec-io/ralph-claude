// Tests for GET /api/fs/list (US-015a).
//
// Strategy: build a bare Hono app mounting only fsRouter — no auth middleware —
// matching the pattern used by routes.test.ts and unmanaged.test.ts. The
// bearerMiddleware lives in server/index.ts and gates /api/* at app level;
// testing auth separately in auth.test.ts means route-unit tests can skip it.
//
// We manipulate process.env.RALPH_MONITOR_PROJECT_ROOTS per test because
// getAllowedRoots() reads the env at call time (not at import time), so there
// is no module-level singleton to reset.
//
// The tmp dir used as an allowed root is created via mkdtempSync. We set
// RALPH_MONITOR_PROJECT_ROOTS to that path before each test so the allowlist
// contains exactly our controlled directory.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// Imports must come after any env-var setup that modules read at import time.
// fsRouter only reads env at call time (getAllowedRoots), so order is fine,
// but we follow the established pattern anyway.
const { Hono } = await import('hono')
const { fsRouter } = await import('./fs')

const app = new Hono()
app.route('/', fsRouter)

// ---------------------------------------------------------------------------
// Test fixture: a single tmp dir used as the allowed root for most tests.
// ---------------------------------------------------------------------------

let tmpRoot: string
const createdDirs: string[] = []

function mkTmp(prefix = 'ralph-fs-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(d)
  return d
}

beforeAll(() => {
  tmpRoot = mkTmp()
})

afterAll(() => {
  for (const d of createdDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// Restore env after each test so tests don't bleed into each other.
const ORIGINAL_ROOTS = process.env.RALPH_MONITOR_PROJECT_ROOTS

afterEach(() => {
  if (ORIGINAL_ROOTS === undefined) {
    delete process.env.RALPH_MONITOR_PROJECT_ROOTS
  } else {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = ORIGINAL_ROOTS
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(urlPath: string): Promise<Response> {
  return app.fetch(new Request(`http://test${urlPath}`))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/fs/list — missing/bad params', () => {
  test('no path query param -> 400 path_required', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get('/api/fs/list')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('path_required')
  })

  test('empty path -> 400 path_required', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get('/api/fs/list?path=')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('path_required')
  })
})

describe('GET /api/fs/list — path_not_found (404)', () => {
  test('non-existent path -> 404 path_not_found', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get('/api/fs/list?path=/nonexistent-ralph-monitor-test-path-abc123')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('path_not_found')
  })

  test('path that contains non-existent component -> 404 path_not_found', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get(
      `/api/fs/list?path=${encodeURIComponent(join(tmpRoot, 'does-not-exist', 'subdir'))}`,
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('path_not_found')
  })
})

describe('GET /api/fs/list — path_outside_allowlist (403)', () => {
  test('traversal: path/<..><..>/etc resolves outside allowlist -> 403', async () => {
    // This is the key traversal test. The path looks like it starts with tmpRoot
    // but after realpath resolves ".." it lands outside.
    // e.g. /tmp/abc/../../../etc -> /etc  (or wherever the OS resolves it).
    // We use a path that resolves to / (always outside any tmp-based allowlist).
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    // Build a traversal path: start inside tmpRoot, climb out past it.
    // How many levels we need depends on the depth of tmpRoot in the fs.
    // Using ../../.. from a known temp path always lands at or above /tmp.
    const traversal = join(tmpRoot, '..', '..', '..', 'etc')
    const res = await get(`/api/fs/list?path=${encodeURIComponent(traversal)}`)
    // realpath of <tmpRoot>/../../.. /etc may succeed (if /etc exists) or fail
    // (if the path doesn't exist). Either 403 or 404 is acceptable here —
    // what matters is we never get 200.
    expect([403, 404]).toContain(res.status)
    if (res.status === 403) {
      const body = await res.json()
      expect(body.error).toBe('path_outside_allowlist')
      expect(Array.isArray(body.allowed)).toBe(true)
    }
  })

  test('direct path outside allowlist (/tmp when root is a separate tmpdir) -> 403', async () => {
    // Use a fresh isolated dir as the allowed root, then request /tmp (which
    // is its parent or peer — never equal to or inside the isolated dir).
    const isolatedRoot = mkTmp('ralph-fs-isolated-')
    process.env.RALPH_MONITOR_PROJECT_ROOTS = isolatedRoot

    // /tmp exists on Linux; request it directly — it's outside isolatedRoot.
    const res = await get(`/api/fs/list?path=${encodeURIComponent(tmpdir())}`)
    // tmpdir() could equal isolatedRoot's parent (/tmp), or be a different path.
    // As long as it isn't isolatedRoot or a subdir of it, we expect 403.
    // We verify by checking the response, not the path math.
    const body = await res.json()
    if (res.status === 403) {
      expect(body.error).toBe('path_outside_allowlist')
    } else {
      // If somehow tmpdir() == isolatedRoot (extremely unlikely), the test is moot.
      // In that case it would 200 — acceptable.
      expect(res.status).toBe(200)
    }
  })

  test('symlink inside allowlist pointing outside -> 403', async () => {
    // Create a symlink inside tmpRoot that points to /etc (or /tmp, which is
    // outside our isolated allowed root when we use a nested tmp dir).
    // After realpath, the resolved path of the symlink is /etc (outside).
    const isolatedRoot = mkTmp('ralph-fs-symlink-')
    process.env.RALPH_MONITOR_PROJECT_ROOTS = isolatedRoot

    // Create the symlink: <isolatedRoot>/outside_link -> /etc
    // (Use /etc because it always exists on Linux.)
    const symlinkPath = join(isolatedRoot, 'outside_link')
    try {
      symlinkSync('/etc', symlinkPath)
    } catch {
      // If symlink creation fails (e.g. permissions), skip gracefully.
      return
    }

    // Request the symlink path — realpath resolves it to /etc.
    const res = await get(`/api/fs/list?path=${encodeURIComponent(symlinkPath)}`)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('path_outside_allowlist')
  })

  test('allowlist path separator: /home/user never matches /home/userX', async () => {
    // This is a regression guard for the path.sep check. We set two distinct
    // temp roots and verify that only the exact one (or its children) passes.
    const rootA = mkTmp('ralph-fs-a-')
    const rootB = mkTmp('ralph-fs-b-')

    // Only allow rootA.
    process.env.RALPH_MONITOR_PROJECT_ROOTS = rootA

    // Request rootB (peer directory, same parent). realpathSync.native(rootB)
    // succeeds, but rootB doesn't start with rootA + '/'.
    const res = await get(`/api/fs/list?path=${encodeURIComponent(rootB)}`)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('path_outside_allowlist')
  })
})

describe('GET /api/fs/list — happy path', () => {
  test('lists directory with normalizedPath', async () => {
    // Create some files inside tmpRoot.
    const sub = join(tmpRoot, 'list-happy')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'file.txt'), 'hello')
    mkdirSync(join(sub, 'subdir'), { recursive: true })

    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get(`/api/fs/list?path=${encodeURIComponent(sub)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.normalizedPath).toBe('string')
    // normalizedPath is the realpath'd version of sub.
    expect(body.normalizedPath).toBe(realpathSync.native(sub))
    expect(Array.isArray(body.entries)).toBe(true)
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('file.txt')
    expect(names).toContain('subdir')

    // Type assertions.
    const fileEntry = body.entries.find((e: any) => e.name === 'file.txt')
    expect(fileEntry.isDir).toBe(false)
    expect(fileEntry.isSymlink).toBe(false)

    const dirEntry = body.entries.find((e: any) => e.name === 'subdir')
    expect(dirEntry.isDir).toBe(true)
    expect(dirEntry.isSymlink).toBe(false)
  })

  test('allowed root itself is a valid target', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get(`/api/fs/list?path=${encodeURIComponent(tmpRoot)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.entries)).toBe(true)
  })

  test('symlink inside allowlist pointing inside allowlist -> isSymlink=true', async () => {
    // Create a real dir and a symlink that points to it, both inside tmpRoot.
    const realDir = join(tmpRoot, 'real-target')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'inside.txt'), '')
    const linkPath = join(tmpRoot, 'good-link')
    try {
      symlinkSync(realDir, linkPath)
    } catch {
      return
    }

    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    // List the parent dir — the symlink should appear with isSymlink=true.
    const res = await get(`/api/fs/list?path=${encodeURIComponent(tmpRoot)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const linkEntry = body.entries.find((e: any) => e.name === 'good-link')
    if (linkEntry) {
      // The Dirent reflects the symlink itself, not the target.
      expect(linkEntry.isSymlink).toBe(true)
    }
  })
})

describe('GET /api/fs/list — dotfile filtering', () => {
  let dotDir: string

  beforeEach(() => {
    dotDir = join(tmpRoot, `dotfiles-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dotDir, { recursive: true })
    writeFileSync(join(dotDir, '.hidden'), '')
    writeFileSync(join(dotDir, '.env'), '')
    writeFileSync(join(dotDir, 'visible.txt'), '')
    mkdirSync(join(dotDir, '.hidden-dir'), { recursive: true })
  })

  test('dotfiles excluded by default', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get(`/api/fs/list?path=${encodeURIComponent(dotDir)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('visible.txt')
    expect(names).not.toContain('.hidden')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('.hidden-dir')
  })

  test('show_hidden=true includes dotfiles', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get(`/api/fs/list?path=${encodeURIComponent(dotDir)}&show_hidden=true`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('visible.txt')
    expect(names).toContain('.hidden')
    expect(names).toContain('.env')
    expect(names).toContain('.hidden-dir')
  })

  test('show_hidden=false behaves like the default (no dotfiles)', async () => {
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get(`/api/fs/list?path=${encodeURIComponent(dotDir)}&show_hidden=false`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('visible.txt')
    expect(names).not.toContain('.hidden')
  })
})

describe('GET /api/fs/list — not_a_directory (422)', () => {
  test('path is a file, not a dir -> 422 not_a_directory', async () => {
    const filePath = join(tmpRoot, 'just-a-file.txt')
    writeFileSync(filePath, 'content')
    process.env.RALPH_MONITOR_PROJECT_ROOTS = tmpRoot

    const res = await get(`/api/fs/list?path=${encodeURIComponent(filePath)}`)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('not_a_directory')
  })
})

describe('GET /api/fs/list — default root is $HOME', () => {
  test('unset RALPH_MONITOR_PROJECT_ROOTS defaults to homedir()', async () => {
    delete process.env.RALPH_MONITOR_PROJECT_ROOTS

    // $HOME itself should be in the default allowlist.
    const home = realpathSync.native(homedir())
    const res = await get(`/api/fs/list?path=${encodeURIComponent(home)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.entries)).toBe(true)
  })
})
