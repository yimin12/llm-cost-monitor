// Tiny named-param → positional-param translator. We keep our SQL readable by
// writing `WHERE id = @id` instead of `WHERE id = $1`, but pg only speaks
// positional. Conversion happens at runtime.
//
// Limitations:
//  - Inside string literals: this naive scan ignores quoted contexts. Don't
//    write `'@something'` in your SQL. We only use double-quoted identifiers
//    and unquoted parameters, so this is fine in practice.
//  - Each @name maps to one $N; reused names are deduplicated.

export interface PreparedSql {
  text: string
  values: unknown[]
}

export function namedQuery(
  sql: string,
  params: Record<string, unknown>,
): PreparedSql {
  const values: unknown[] = []
  const indexByName: Record<string, number> = {}

  const text = sql.replace(/@([a-zA-Z_][a-zA-Z_0-9]*)/g, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`namedQuery: missing param @${name}`)
    }
    const existing = indexByName[name]
    if (existing !== undefined) return `$${existing}`
    values.push(params[name])
    const idx = values.length
    indexByName[name] = idx
    return `$${idx}`
  })

  return { text, values }
}
