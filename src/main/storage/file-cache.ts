import type { Pool } from './connect'
import { namedQuery } from './db-utils'

// Per-file parse-state cache. Mirrors CLI Pulse's `<provider>-v2.json`
// (file_path → { mtime, parsedBytes, last_parsed_at }) but stored in the
// existing `files` Postgres table instead of a separate JSON cache.
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

interface PgFileRow {
  path: string
  mtime: bigint
  last_parsed_at: bigint
  last_offset: bigint
}

export class FileCache {
  constructor(private readonly pool: Pool) {}

  async get(path: string): Promise<FileCacheRow | null> {
    const q = namedQuery(
      'SELECT path, mtime, last_parsed_at, last_offset FROM files WHERE path = @path',
      { path },
    )
    const r = await this.pool.query<PgFileRow>(q.text, q.values)
    const row = r.rows[0]
    if (row === undefined) return null
    return {
      path: row.path,
      mtime: Number(row.mtime),
      lastParsedAt: Number(row.last_parsed_at),
      lastOffset: Number(row.last_offset),
    }
  }

  async upsert(row: FileCacheRow): Promise<void> {
    const q = namedQuery(
      `INSERT INTO files (path, mtime, last_parsed_at, last_offset)
       VALUES (@path, @mtime, @last_parsed_at, @last_offset)
       ON CONFLICT (path) DO UPDATE SET
         mtime = EXCLUDED.mtime,
         last_parsed_at = EXCLUDED.last_parsed_at,
         last_offset = EXCLUDED.last_offset`,
      {
        path: row.path,
        mtime: BigInt(row.mtime),
        last_parsed_at: BigInt(row.lastParsedAt),
        last_offset: BigInt(row.lastOffset),
      },
    )
    await this.pool.query(q.text, q.values)
  }
}
