import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import mysql from 'mysql2/promise'

export const name = 'nl2sql-mysql'
export const inject = ['tools']

export interface Nl2sqlConfig {
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  schemaDir?: string
  sampleLimit?: number
  queryLimit?: number
}

interface LiveColumn {
  name: string
  type: string
  comment: string
}

interface TableSchema {
  table: string
  description: string
  columns: Record<string, string>
  live_columns: LiveColumn[]
  sample_rows: Record<string, unknown>[]
  refreshed_at?: string
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|load\s+data|outfile|dumpfile|into\s+outfile)\b/i

function resolveDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

function schemaFile(schemaDir: string, table: string): string {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, '_')
  return path.join(schemaDir, `${safe}.json`)
}

async function loadAll(schemaDir: string): Promise<TableSchema[]> {
  await mkdir(schemaDir, { recursive: true })
  const names = await readdir(schemaDir)
  const out: TableSchema[] = []
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    const raw = await readFile(path.join(schemaDir, file), 'utf8')
    const data = JSON.parse(raw) as TableSchema
    if (!data.table) continue
    data.columns ??= {}
    data.live_columns ??= []
    data.sample_rows ??= []
    data.description ??= ''
    out.push(data)
  }
  return out
}

function formatCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (typeof value === 'bigint') return value.toString()
  return value
}

async function withMysql<T>(cfg: Required<Pick<Nl2sqlConfig, 'host' | 'port' | 'user' | 'password' | 'database'>>, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  if (!cfg.database) throw new Error('cordis.yml 里还没配 database')
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: 'utf8mb4',
  })
  try {
    return await fn(conn)
  } finally {
    await conn.end()
  }
}

async function pullLive(cfg: Required<Pick<Nl2sqlConfig, 'host' | 'port' | 'user' | 'password' | 'database'>>, table: string, sampleLimit: number) {
  const ident = table.replace(/`/g, '')
  return withMysql(cfg, async (conn) => {
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [ident],
    )
    const live = (cols as LiveColumn[]).map((c) => ({
      name: String(c.name),
      type: String(c.type),
      comment: String(c.comment || ''),
    }))
    if (!live.length) throw new Error(`MySQL 中没有表 ${ident}，检查 database 配置`)
    const [rows] = await conn.query(`SELECT * FROM \`${ident}\` LIMIT ?`, [sampleLimit])
    const sample = (rows as Record<string, unknown>[]).map((row) => {
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) next[k] = formatCell(v)
      return next
    })
    return { live, sample }
  })
}

function validateSelect(sql: string, allowed: Set<string>, queryLimit: number): string {
  const compact = sql.trim().replace(/;+\s*$/, '')
  if (compact.includes(';')) throw new Error('只允许单条 SQL')
  if (FORBIDDEN.test(compact)) throw new Error(`禁止写入或危险关键词: ${compact}`)
  if (!/^select\b/i.test(compact)) throw new Error('只允许 SELECT')
  const found = new Set(
    [...compact.matchAll(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi)].map((m) => m[1].toLowerCase()),
  )
  for (const name of found) {
    if (!allowed.has(name)) throw new Error(`表 ${name} 未登记，先调 db_register_table`)
  }
  if (!/\blimit\s+\d+/i.test(compact)) return `${compact} LIMIT ${queryLimit}`
  return compact
}

function renderSchema(item: TableSchema): string {
  const lines = [`TABLE \`${item.table}\``, item.description || '']
  const comments = item.columns || {}
  const live = item.live_columns || []
  lines.push('COLUMNS:')
  if (live.length) {
    for (const col of live) {
      const hint = comments[col.name] || col.comment || ''
      lines.push(`- ${col.name} ${col.type} ${hint}`.trimEnd())
    }
  } else {
    for (const [name, hint] of Object.entries(comments)) lines.push(`- ${name} ${hint}`)
  }
  if (item.sample_rows?.length) {
    lines.push('SAMPLE_ROWS_JSON:')
    lines.push(JSON.stringify(item.sample_rows, null, 2))
  }
  return lines.filter(Boolean).join('\n')
}

export function apply(ctx: Context, config: Nl2sqlConfig = {}) {
  const cfg = {
    host: config.host || process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(config.port || process.env.MYSQL_PORT || 3306),
    user: config.user || process.env.MYSQL_USER || 'root',
    password: config.password ?? process.env.MYSQL_PASSWORD ?? '',
    database: config.database || process.env.MYSQL_DATABASE || '',
    schemaDir: resolveDir(config.schemaDir || './extras/dsh-nl2sql/schemas'),
    sampleLimit: Number(config.sampleLimit ?? 5),
    queryLimit: Number(config.queryLimit ?? 50),
  }

  ctx.tools.register(defineTool({
    name: 'db_register_table',
    description:
      'Register a MySQL table for NL2SQL. Saves your Chinese description and column comments, then reads live columns and a few real sample rows from the local database. Call this before querying a new table.',
    parameters: {
      table: { type: 'string', required: true, description: 'Exact MySQL table name' },
      description: { type: 'string', description: 'What this table means in business language' },
      columns_json: {
        type: 'string',
        description: 'Optional JSON object of column comments, e.g. {"name":"线路名称","city":"地市编码"}',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const table = args.table.trim()
      let columns: Record<string, string> = {}
      if (args.columns_json) {
        const parsed = JSON.parse(args.columns_json) as Record<string, string>
        if (!parsed || typeof parsed !== 'object') throw new Error('columns_json must be a JSON object')
        columns = parsed
      }
      const file = schemaFile(cfg.schemaDir, table)
      let existing: TableSchema | null = null
      try {
        existing = JSON.parse(await readFile(file, 'utf8')) as TableSchema
      } catch {
        existing = null
      }
      const { live, sample } = await pullLive(cfg, table, cfg.sampleLimit)
      const data: TableSchema = {
        table,
        description: args.description || existing?.description || '',
        columns: { ...(existing?.columns || {}), ...columns },
        live_columns: live,
        sample_rows: sample,
        refreshed_at: new Date().toISOString(),
      }
      await mkdir(cfg.schemaDir, { recursive: true })
      await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      return renderSchema(data)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_list_tables',
    description: 'List MySQL tables already registered for NL2SQL.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const all = await loadAll(cfg.schemaDir)
      if (!all.length) return '还没有登记表。先调 db_register_table。'
      return all.map((item) => {
        const n = item.live_columns?.length || 0
        const s = item.sample_rows?.length || 0
        return `- ${item.table}  cols=${n} samples=${s}  ${item.description}`
      }).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_schema',
    description:
      'Get registered table schemas plus live sample rows. Use this before writing SQL so filters match real column values (city codes, org codes, line names).',
    parameters: {
      table: { type: 'string', description: 'Optional single table. Omit to return every registered table.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const all = await loadAll(cfg.schemaDir)
      if (!all.length) return '还没有登记表。先调 db_register_table。'
      const wanted = args.table?.trim()
      const picked = wanted ? all.filter((x) => x.table.toLowerCase() === wanted.toLowerCase()) : all
      if (!picked.length) return `表 ${wanted} 未登记`
      return picked.map(renderSchema).join('\n\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_query',
    description:
      'Run one read-only MySQL SELECT for business questions such as line counts, faults, or work orders. Table names must already be registered. Do not invent write statements.',
    parameters: {
      sql: { type: 'string', required: true, description: 'A single SELECT statement' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const all = await loadAll(cfg.schemaDir)
      const allowed = new Set(all.map((x) => x.table.toLowerCase()))
      const sql = validateSelect(args.sql, allowed, cfg.queryLimit)
      const rows = await withMysql(cfg, async (conn) => {
        const [result] = await conn.query(sql)
        return (result as Record<string, unknown>[]).map((row) => {
          const next: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(row)) next[k] = formatCell(v)
          return next
        })
      })
      return [`SQL: ${sql}`, `rows: ${rows.length}`, JSON.stringify(rows, null, 2)].join('\n')
    },
  }))
}
