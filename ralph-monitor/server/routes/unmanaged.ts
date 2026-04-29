// GET /api/unmanaged-prds — returns discovered PRD records that have NOT yet
// been adopted into any project effort (left-anti-join against effort.prd_path).
//
// Join key: effort.prd_path === path.join(record.taskDir, 'prd.json')
//
// Each returned item is enriched with `suggestedProjectId` / `suggestedBranch`
// if the record's worktreeDir happens to be a known worktree of an existing
// project (via the shared git/worktrees.ts helper, cached 30s).

import { Hono } from 'hono'
import { join } from 'node:path'
import { discoverFromSystemd } from '../discovery'
import { getDb, listAllEfforts, listProjects } from '../db'
import { checkIsWorktreeOfProject } from '../git/worktrees'
import type { PRDRecord } from '../types'

export interface UnmanagedPRDItem extends Omit<PRDRecord, never> {
  suggestedProjectId: string | null
  suggestedBranch: string | null
}

export const unmanagedRouter = new Hono()

unmanagedRouter.get('/api/unmanaged-prds', async (c) => {
  const records = await discoverFromSystemd()

  const db = getDb()
  const efforts = listAllEfforts(db)
  const adoptedPaths = new Set(
    efforts.map((e) => e.prd_path).filter((p): p is string => p !== null),
  )

  const projects = listProjects(db, {})
  const projectStubs = projects.map((p) => ({ id: p.id, root_dir: p.root_dir }))

  const unmanagedList: UnmanagedPRDItem[] = records
    .filter((r) => !adoptedPaths.has(join(r.taskDir, 'prd.json')))
    .map((r) => {
      const suggested = r.worktreeDir
        ? checkIsWorktreeOfProject(r.worktreeDir, projectStubs)
        : { matched: false as const }
      return {
        ...r,
        suggestedProjectId: suggested.matched ? suggested.projectId : null,
        suggestedBranch: suggested.matched ? suggested.branch : null,
      }
    })

  return c.json({ unmanaged: unmanagedList })
})
