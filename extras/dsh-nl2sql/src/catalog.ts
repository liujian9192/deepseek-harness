import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

export interface LiveColumn {
  name: string
  type: string
  comment: string
}

export interface TableSchema {
  table: string
  domain: string
  description: string
  source?: 'mysql' | 'mock'
  columns: Record<string, string>
  live_columns: LiveColumn[]
  sample_rows: Record<string, unknown>[]
  refreshed_at?: string
}

export interface DomainPack {
  domain: string
  description: string
  keywords?: string
  tables: TableSchema[]
}

export interface MysqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function domainPath(schemaDir: string, domain: string): string {
  return path.join(schemaDir, `${domain}.json`)
}

export async function readPack(file: string): Promise<DomainPack | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as DomainPack | TableSchema
    if ('tables' in raw && Array.isArray(raw.tables)) {
      return {
        domain: raw.domain || path.basename(file, '.json'),
        description: raw.description || '',
        keywords: raw.keywords || '',
        tables: raw.tables.map((t) => ({ ...t, domain: raw.domain || t.domain || path.basename(file, '.json') })),
      }
    }
    if ('table' in raw && raw.table) {
      const table = raw as TableSchema
      return {
        domain: table.domain || '未分组',
        description: '',
        keywords: '',
        tables: [{ ...table, domain: table.domain || '未分组' }],
      }
    }
    return null
  } catch {
    return null
  }
}

export async function loadPacks(schemaDir: string): Promise<DomainPack[]> {
  await mkdir(schemaDir, { recursive: true })
  const names = await readdir(schemaDir)
  const packs: DomainPack[] = []
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    const pack = await readPack(path.join(schemaDir, file))
    if (pack) packs.push(pack)
  }
  return packs
}

export async function loadAll(schemaDir: string): Promise<TableSchema[]> {
  const packs = await loadPacks(schemaDir)
  return packs.flatMap((p) => p.tables.map((t) => {
    t.columns ??= {}
    t.live_columns ??= []
    t.sample_rows ??= []
    t.description ??= ''
    t.domain ??= p.domain
    return t
  }))
}

export async function savePack(schemaDir: string, pack: DomainPack): Promise<void> {
  await mkdir(schemaDir, { recursive: true })
  await writeFile(domainPath(schemaDir, pack.domain), `${JSON.stringify(pack, null, 2)}\n`, 'utf8')
}

export async function saveTable(schemaDir: string, data: TableSchema, keywords?: string): Promise<void> {
  const file = domainPath(schemaDir, data.domain)
  const existing = await readPack(file)
  const pack: DomainPack = existing || {
    domain: data.domain,
    description: `${data.domain}业务域`,
    keywords: keywords || '',
    tables: [],
  }
  if (keywords) pack.keywords = keywords
  const idx = pack.tables.findIndex((t) => t.table.toLowerCase() === data.table.toLowerCase())
  if (idx >= 0) pack.tables[idx] = data
  else pack.tables.push(data)
  pack.domain = data.domain
  await savePack(schemaDir, pack)
}

export function formatCell(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (typeof value === 'bigint') return value.toString()
  return value
}

export async function withMysql<T>(cfg: MysqlConfig, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  if (!cfg.database) throw new Error('还没配 database')
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

export async function listMysqlTables(cfg: MysqlConfig): Promise<string[]> {
  return withMysql(cfg, async (conn) => {
    const [rows] = await conn.query('SHOW TABLES')
    const key = rows.length ? Object.keys(rows[0] as object)[0] : ''
    return (rows as Record<string, string>[]).map((row) => String(row[key]))
  })
}

export async function pullLive(cfg: MysqlConfig, table: string, sampleLimit: number) {
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
    if (!live.length) throw new Error(`MySQL 中没有表 ${ident}`)
    const [rows] = await conn.query('SELECT * FROM `' + ident + '` LIMIT ?', [sampleLimit])
    const sample = (rows as Record<string, unknown>[]).map((row) => {
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) next[k] = formatCell(v)
      return next
    })
    return { live, sample }
  })
}
