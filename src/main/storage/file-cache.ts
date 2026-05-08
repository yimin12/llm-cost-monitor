import type { DatabaseHandle } from './db'

// Per-file parse-state cache. Mirrors CLI Pulse's `<provider>-v2.json`
// (file_path → { mtime, parsedBytes, last_parsed_at }) but stored in the
// existing `files` SQLite table instead of a separate JSON cache.
//
// When a parser reopens a file:
//   - mtime unchanged AND lastOffset == fileSize → skip entirely (fast path)
//   - mtime changed but lastOffset < fileSize → resume reading from lastOffset
//   - else → reparse from byte 0
export interface FileCacheRow {
  path: string
  mtime: number
  lastParsedAt: number
  lastOffset: number
}

export class FileCache {
  private readonly getStmt
  private readonly upsertStmt

  constructor(db: DatabaseHandle) {
    this.getStmt = db.prepare<{ path: string }, { path: string; mtime: bigint; last_parsed_at: bigint; last_offset: bigint }>(
      'SELECT path, mtime, last_parsed_at, last_offset FROM files WHERE path = @path',
    )
    this.upsertStmt = db.prepare(`
      INSERT INTO files (path, mtime, last_parsed_at, last_offset)
      VALUES (@path, @mtime, @last_parsed_at, @last_offset)
      ON CONFLICT(path) DO UPDATE SET
        mtime = excluded.mtime,
        last_parsed_at = excluded.last_parsed_at,
        last_offset = excluded.last_offset
    `)
  }

  get(path: string): FileCacheRow | null {
    const row = this.getStmt.get({ path })
    if (row === undefined) return null
    return {
      path: row.path,
      mtime: Number(row.mtime),
      lastParsedAt: Number(row.last_parsed_at),
      lastOffset: Number(row.last_offset),
    }
  }

  upsert(row: FileCacheRow): void {
    this.upsertStmt.run({
      path: row.path,
      mtime: row.mtime,
      last_parsed_at: row.lastParsedAt,
      last_offset: row.lastOffset,
    })
  }
}
