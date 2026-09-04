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
  domain: string
  description: string
  source?: 'mysql' | 'mock'
  columns: Record<string, string>
  live_columns: LiveColumn[]
  sample_rows: Record<string, unknown>[]
  refreshed_at?: string
}

interface DomainPack {
  domain: string
  description: string
  tables: TableSchema[]
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|load\s+data|outfile|dumpfile|into\s+outfile)\b/i
const DOMAIN_FILES = new Set(['设备', '运行', '检修', '抢修', '停电', '未分组'])

function resolveDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

function domainPath(schemaDir: string, domain: string): string {
  return path.join(schemaDir, `${domain}.json`)
}

function normalizeDomain(raw?: string): string {
  const name = (raw || '设备').trim()
  return name || '设备'
}

async function readPack(file: string): Promise<DomainPack | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as DomainPack | TableSchema
    if ('tables' in raw && Array.isArray(raw.tables)) {
      return {
        domain: raw.domain || path.basename(file, '.json'),
        description: raw.description || '',
        tables: raw.tables.map((t) => ({ ...t, domain: raw.domain || t.domain || path.basename(file, '.json') })),
      }
    }
    if ('table' in raw && raw.table) {
      const table = raw as TableSchema
      return {
        domain: table.domain || '未分组',
        description: '',
        tables: [{ ...table, domain: table.domain || '未分组' }],
      }
    }
    return null
  } catch {
    return null
  }
}

async function loadPacks(schemaDir: string): Promise<DomainPack[]> {
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

async function loadAll(schemaDir: string): Promise<TableSchema[]> {
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

async function saveTable(schemaDir: string, data: TableSchema): Promise<void> {
  await mkdir(schemaDir, { recursive: true })
  const file = domainPath(schemaDir, data.domain)
  const existing = await readPack(file)
  const pack: DomainPack = existing || {
    domain: data.domain,
    description: DOMAIN_FILES.has(data.domain) ? `${data.domain}业务域` : '',
    tables: [],
  }
  const idx = pack.tables.findIndex((t) => t.table.toLowerCase() === data.table.toLowerCase())
  if (idx >= 0) pack.tables[idx] = data
  else pack.tables.push(data)
  pack.domain = data.domain
  await writeFile(file, `${JSON.stringify(pack, null, 2)}\n`, 'utf8')
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
    const [rows] = await conn.query('SELECT * FROM `' + ident + '` LIMIT ?', [sampleLimit])
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
    if (!allowed.has(name)) throw new Error(`表 ${name} 未登记，先调 db_register_table 或先看业务域目录`)
  }
  if (!/\blimit\s+\d+/i.test(compact)) return `${compact} LIMIT ${queryLimit}`
  return compact
}

function renderSchema(item: TableSchema): string {
  const lines = [
    `DOMAIN ${item.domain}`,
    `TABLE \`${item.table}\`  source=${item.source || 'mysql'}`,
    item.description || '',
  ]
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
    name: 'db_list_domains',
    description: 'List distribution-network business domains and how many tables each domain contains. Domains include 设备/运行/检修/抢修/停电.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const packs = await loadPacks(cfg.schemaDir)
      if (!packs.length) return '还没有业务域。先看 schemas/设备.json 或调 db_register_table。'
      return packs.map((p) => `- 域 ${p.domain}  tables=${p.tables.length}  ${p.description}`).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_register_table',
    description:
      'Register a real MySQL table into a business domain (设备/运行/检修/抢修/停电). Pulls live columns and sample rows, then writes into that domain JSON pack — not one file per table.',
    parameters: {
      table: { type: 'string', required: true, description: 'Exact MySQL table name' },
      domain: { type: 'string', description: 'Business domain. Default 设备. Use 运行/检修/抢修/停电 when appropriate.' },
      description: { type: 'string', description: 'What this table means' },
      columns_json: {
        type: 'string',
        description: 'Optional JSON object of column comments',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const table = args.table.trim()
      const domain = normalizeDomain(args.domain)
      let columns: Record<string, string> = {}
      if (args.columns_json) {
        const parsed = JSON.parse(args.columns_json) as Record<string, string>
        if (!parsed || typeof parsed !== 'object') throw new Error('columns_json must be a JSON object')
        columns = parsed
      }
      const all = await loadAll(cfg.schemaDir)
      const existing = all.find((t) => t.table.toLowerCase() === table.toLowerCase() && t.domain === domain)
        || all.find((t) => t.table.toLowerCase() === table.toLowerCase())
      const { live, sample } = await pullLive(cfg, table, cfg.sampleLimit)
      const data: TableSchema = {
        table,
        domain,
        source: 'mysql',
        description: args.description || existing?.description || '',
        columns: { ...(existing?.columns || {}), ...columns },
        live_columns: live,
        sample_rows: sample,
        refreshed_at: new Date().toISOString(),
      }
      await saveTable(cfg.schemaDir, data)
      return renderSchema(data)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_list_tables',
    description: 'List registered tables grouped by business domain. Pass domain to only see 设备 or another domain.',
    parameters: {
      domain: { type: 'string', description: 'Optional domain filter: 设备/运行/检修/抢修/停电' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const all = await loadAll(cfg.schemaDir)
      const domain = args.domain?.trim()
      const picked = domain ? all.filter((t) => t.domain === domain) : all
      if (!picked.length) return domain ? `域 ${domain} 下还没有表` : '还没有登记表'
      const groups = new Map<string, TableSchema[]>()
      for (const item of picked) {
        const list = groups.get(item.domain) || []
        list.push(item)
        groups.set(item.domain, list)
      }
      const blocks: string[] = []
      for (const [name, list] of groups) {
        blocks.push(`## 域 ${name}`)
        for (const item of list) {
          blocks.push(`- ${item.table}  ${item.source || 'mysql'}  ${item.description}`)
        }
      }
      return blocks.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_schema',
    description:
      'Get schemas and sample rows. Prefer passing domain=设备 for equipment questions so the model sees the whole equipment pack, not one table file.',
    parameters: {
      domain: { type: 'string', description: 'Business domain, e.g. 设备' },
      table: { type: 'string', description: 'Optional single table name' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const all = await loadAll(cfg.schemaDir)
      if (!all.length) return '还没有登记表'
      let picked = all
      if (args.domain?.trim()) picked = picked.filter((t) => t.domain === args.domain.trim())
      if (args.table?.trim()) picked = picked.filter((t) => t.table.toLowerCase() === args.table.trim().toLowerCase())
      if (!picked.length) return '没有匹配的表。先 db_list_domains / db_list_tables。'
      if (picked.length > 8 && !args.table) {
        const summary = picked.map((t) => `- ${t.domain}.${t.table}  ${t.description}`).join('\n')
        return `该范围有 ${picked.length} 张表，先看目录，再 db_schema 指定 table。\n${summary}`
      }
      return picked.map(renderSchema).join('\n\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_query',
    description:
      'Run one read-only MySQL SELECT. Table must be registered in some domain. Mock equipment tables are schema-only until the same name exists in MySQL or you register the real table.',
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
      const used = [...sql.matchAll(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi)].map((m) => m[1].toLowerCase())
      const mockOnly = used.filter((name) => all.find((t) => t.table.toLowerCase() === name)?.source === 'mock')
      try {
        const rows = await withMysql(cfg, async (conn) => {
          const [result] = await conn.query(sql)
          return (result as Record<string, unknown>[]).map((row) => {
            const next: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(row)) next[k] = formatCell(v)
            return next
          })
        })
        return [`SQL: ${sql}`, `rows: ${rows.length}`, JSON.stringify(rows, null, 2)].join('\n')
      } catch (err) {
        if (mockOnly.length) {
          const samples = all.filter((t) => mockOnly.includes(t.table.toLowerCase()))
          return [
            `真库查询失败（${String(err)} ）`,
            `以下表目前只是设备域模拟说明: ${mockOnly.join(', ')}`,
            '若要查真实数据，用 db_register_table 把库里同名真表登记进对应域。',
            ...samples.map((t) => `MOCK ${t.table}:\n${JSON.stringify(t.sample_rows, null, 2)}`),
          ].join('\n\n')
        }
        throw err
      }
    },
  }))
}
