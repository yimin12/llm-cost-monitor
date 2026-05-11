import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Minimum-viable git scanner for the Yield Score card.
//
// Walks the user's home dir up to `MAX_DEPTH` levels deep looking for
// `.git` directories. For each repo found, runs `git log --since=<iso>`
// and counts commits + merge commits in the window.
//
// V1 deliberately keeps the scope small:
//   - no caching: ~50 repos × `git log` is well under a second on
//     warm FS, and the scanner is called from an IPC handler that the
//     renderer only triggers when the Yield card is mounted.
//   - skip-list of well-known noise dirs (Library, node_modules, …)
//     to keep the walk bounded.
//   - returns only counts + repo paths; never reads commit messages,
//     diffs, file lists, or author info — matches the privacy
//     statement in settings.ts header.

const execFileP = promisify(execFile)

const MAX_DEPTH = 2
const MAX_REPOS = 50
const GIT_TIMEOUT_MS = 5_000

// Don't descend into these — either platform garbage or known-huge
// trees that never contain personal repos.
const SKIP_DIRS = new Set<string>([
  'Library',
  'Pictures',
  'Movies',
  'Music',
  'Downloads',
  'Public',
  'Applications',
  'node_modules',
  '.Trash',
])

export interface RepoCommitStats {
  /** Absolute repo path. */
  path: string
  /** Repo basename for display. */
  name: string
  /** Commits authored in the window. */
  commits: number
  /** Merge commits in the window (parents > 1). */
  merges: number
}

export interface YieldScanResult {
  repos: RepoCommitStats[]
  totalCommits: number
  totalMerges: number
  scannedAt: number
  /** ms it took to scan + count — surfaced to renderer so it can warn
   *  if scanning is slow. */
  durationMs: number
}

async function findRepos(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_REPOS) return
    if (depth < 0) return
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // If this dir IS a git repo, record it and stop descending.
    if (entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
      found.push(dir)
      return
    }
    for (const e of entries) {
      if (found.length >= MAX_REPOS) break
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.')) continue
      if (SKIP_DIRS.has(e.name)) continue
      await walk(join(dir, e.name), depth - 1)
    }
  }
  await walk(root, MAX_DEPTH)
  return found
}

async function countCommits(repo: string, sinceUnixMs: number): Promise<RepoCommitStats> {
  const name = repo.split('/').filter(Boolean).pop() ?? repo
  try {
    // `--pretty=%P` prints just the parent hashes per commit, one
    // line per commit. Parent count > 1 → merge commit.
    const { stdout } = await execFileP(
      'git',
      [
        '-C',
        repo,
        'log',
        '--since',
        new Date(sinceUnixMs).toISOString(),
        '--pretty=format:%P',
      ],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    )
    const lines = stdout.split('\n').filter((l) => l.length > 0)
    const merges = lines.filter((l) => l.trim().split(/\s+/).length > 1).length
    return { path: repo, name, commits: lines.length, merges }
  } catch {
    return { path: repo, name, commits: 0, merges: 0 }
  }
}

export async function scanYield(sinceUnixMs: number): Promise<YieldScanResult> {
  const t0 = Date.now()
  const repos = await findRepos(homedir())
  const stats = await Promise.all(repos.map((r) => countCommits(r, sinceUnixMs)))
  // Sort by activity (most commits first) so the renderer shows the
  // hot repos at the top of the breakdown list.
  stats.sort((a, b) => b.commits - a.commits)
  const totalCommits = stats.reduce((acc, s) => acc + s.commits, 0)
  const totalMerges = stats.reduce((acc, s) => acc + s.merges, 0)
  return {
    repos: stats.filter((s) => s.commits > 0),
    totalCommits,
    totalMerges,
    scannedAt: Date.now(),
    durationMs: Date.now() - t0,
  }
}
