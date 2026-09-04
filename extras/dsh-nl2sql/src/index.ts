import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  formatCell,
  listMysqlTables,
  loadAll,
  loadPacks,
  pullLive,
  savePack,
  saveTable,
  withMysql,
  type MysqlConfig,
  type TableSchema,
} from './catalog.ts'

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
  adminPort?: number
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|load\s+data|outfile|dumpfile|into\s+outfile)\b/i
const HERE = path.dirname(fileURLToPath(import.meta.url))

function resolveDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

function runtimeFile(): string {
  return path.join(os.homedir(), '.dsh', 'nl2sql-config.json')
}

async function readRuntime(): Promise<Partial<MysqlConfig>> {
  try {
    return JSON.parse(await readFile(runtimeFile(), 'utf8')) as Partial<MysqlConfig>
  } catch {
    return {}
  }
}

async function writeRuntime(cfg: MysqlConfig): Promise<void> {
  await mkdir(path.dirname(runtimeFile()), { recursive: true })
  await writeFile(runtimeFile(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
}

function mergeMysql(base: MysqlConfig, extra: Partial<MysqlConfig>): MysqlConfig {
  return {
    host: extra.host || base.host,
    port: Number(extra.port || base.port),
    user: extra.user || base.user,
    password: extra.password === undefined || extra.password === '' ? base.password : extra.password,
    database: extra.database || base.database,
  }
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
    if (!allowed.has(name)) throw new Error(`表 ${name} 未登记，请先在配置页勾选注册`)
  }
  if (!/\blimit\s+\d+/i.test(compact)) return `${compact} LIMIT ${queryLimit}`
  return compact
}

function renderSchema(item: TableSchema): string {
  const lines = [
    `DOMAIN ${item.domain}`,
    `TABLE \`${item.table}\`  source=${item.source || 'mysql'}`,
    item.description || '',
    'COLUMNS:',
  ]
  const comments = item.columns || {}
  const live = item.live_columns || []
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

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json; charset=utf-8') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx: Context, config: Nl2sqlConfig = {}) {
  const state = {
    mysql: {
      host: config.host || process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(config.port || process.env.MYSQL_PORT || 3306),
      user: config.user || process.env.MYSQL_USER || 'root',
      password: config.password ?? process.env.MYSQL_PASSWORD ?? '',
      database: config.database || process.env.MYSQL_DATABASE || '',
    } as MysqlConfig,
    schemaDir: resolveDir(config.schemaDir || './extras/dsh-nl2sql/schemas'),
    sampleLimit: Number(config.sampleLimit ?? 10),
    queryLimit: Number(config.queryLimit ?? 50),
    adminPort: Number(config.adminPort ?? 3081),
  }

  void readRuntime().then((saved) => {
    state.mysql = mergeMysql(state.mysql, saved)
  })

  ctx.tools.register(defineTool({
    name: 'db_list_domains',
    description: 'List business domains for distribution-network NL2SQL.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      const packs = await loadPacks(state.schemaDir)
      if (!packs.length) return '还没有业务域。请打开 http://127.0.0.1:3081 配置。'
      return packs.map((p) => `- 域 ${p.domain}  tables=${p.tables.length}  ${p.keywords || ''}  ${p.description}`).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_register_table',
    description: 'Register one real MySQL table into a domain. Prefer the settings admin page for batch register.',
    parameters: {
      table: { type: 'string', required: true, description: 'MySQL table name' },
      domain: { type: 'string', description: '设备/运行/检修/抢修/停电' },
      description: { type: 'string', description: 'Table meaning' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const domain = (args.domain || '设备').trim()
      const { live, sample } = await pullLive(state.mysql, args.table.trim(), state.sampleLimit)
      const data: TableSchema = {
        table: args.table.trim(),
        domain,
        source: 'mysql',
        description: args.description || '',
        columns: {},
        live_columns: live,
        sample_rows: sample,
        refreshed_at: new Date().toISOString(),
      }
      await saveTable(state.schemaDir, data)
      return renderSchema(data)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_list_tables',
    description: 'List registered tables grouped by domain.',
    parameters: { domain: { type: 'string', description: 'Optional domain filter' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const all = await loadAll(state.schemaDir)
      const picked = args.domain?.trim() ? all.filter((t) => t.domain === args.domain.trim()) : all
      if (!picked.length) return '还没有登记表。请到 http://127.0.0.1:3081 勾选注册。'
      return picked.map((t) => `- [${t.domain}] ${t.table}  ${t.source || 'mysql'}  ${t.description}`).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_schema',
    description: 'Get schema plus up to 10 sample rows. Pass domain=设备 or a table name.',
    parameters: {
      domain: { type: 'string', description: 'Domain name' },
      table: { type: 'string', description: 'Single table' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      let picked = await loadAll(state.schemaDir)
      if (args.domain?.trim()) picked = picked.filter((t) => t.domain === args.domain.trim())
      if (args.table?.trim()) picked = picked.filter((t) => t.table.toLowerCase() === args.table.trim().toLowerCase())
      if (!picked.length) return '没有匹配的表'
      if (picked.length > 8 && !args.table) {
        return `共 ${picked.length} 张表，先看目录再指定 table：\n` + picked.map((t) => `- ${t.domain}.${t.table}  ${t.description}`).join('\n')
      }
      return picked.map(renderSchema).join('\n\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_query',
    description: 'Run one read-only SELECT against registered domain tables.',
    parameters: { sql: { type: 'string', required: true, description: 'SELECT' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const all = await loadAll(state.schemaDir)
      const allowed = new Set(all.map((x) => x.table.toLowerCase()))
      const sql = validateSelect(args.sql, allowed, state.queryLimit)
      const rows = await withMysql(state.mysql, async (conn) => {
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

  const adminHtmlPromise = readFile(path.join(HERE, 'admin.html'), 'utf8')

  const server = createServer((req, res) => {
    void handleAdmin(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: String(err instanceof Error ? err.message : err) })
    })
  })

  async function handleAdmin(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      send(res, 200, await adminHtmlPromise, 'text/html; charset=utf-8')
      return
    }
    if (req.method === 'GET' && p === '/api/config') {
      send(res, 200, { ...state.mysql, password: state.mysql.password ? '********' : '' })
      return
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req) || '{}') as Partial<MysqlConfig>
      state.mysql = mergeMysql(state.mysql, body)
      await writeRuntime(state.mysql)
      try {
        const tables = await listMysqlTables(state.mysql)
        send(res, 200, { ok: true, message: `连接成功，库中有 ${tables.length} 张表` })
      } catch (err) {
        send(res, 200, { ok: false, message: `已保存，但测试失败: ${String(err instanceof Error ? err.message : err)}` })
      }
      return
    }
    if (req.method === 'GET' && p === '/api/tables') {
      send(res, 200, { tables: await listMysqlTables(state.mysql) })
      return
    }
    if (req.method === 'GET' && p === '/api/domains') {
      const packs = await loadPacks(state.schemaDir)
      send(res, 200, {
        items: packs.map((p) => ({
          domain: p.domain,
          description: p.description,
          keywords: p.keywords || '',
          tables: p.tables.length,
        })),
      })
      return
    }
    if (req.method === 'POST' && p === '/api/domains') {
      const body = JSON.parse(await readBody(req) || '{}') as { domain?: string, description?: string, keywords?: string }
      const domain = (body.domain || '').trim()
      if (!domain) throw new Error('域名称不能为空')
      const packs = await loadPacks(state.schemaDir)
      const old = packs.find((p) => p.domain === domain)
      await savePack(state.schemaDir, {
        domain,
        description: body.description || old?.description || `${domain}业务域`,
        keywords: body.keywords || old?.keywords || '',
        tables: old?.tables || [],
      })
      send(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && p === '/api/register') {
      const body = JSON.parse(await readBody(req) || '{}') as { domain?: string, tables?: string[], sampleLimit?: number }
      const domain = (body.domain || '').trim()
      const tables = body.tables || []
      if (!domain) throw new Error('先选业务域')
      if (!tables.length) throw new Error('先勾选要注册的表')
      const limit = Number(body.sampleLimit || state.sampleLimit || 10)
      const done: string[] = []
      const failed: string[] = []
      for (const table of tables) {
        try {
          const { live, sample } = await pullLive(state.mysql, table, limit)
          await saveTable(state.schemaDir, {
            table,
            domain,
            source: 'mysql',
            description: '',
            columns: Object.fromEntries(live.map((c) => [c.name, c.comment || ''])),
            live_columns: live,
            sample_rows: sample,
            refreshed_at: new Date().toISOString(),
          })
          done.push(table)
        } catch (err) {
          failed.push(`${table}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      send(res, 200, { ok: failed.length === 0, message: `成功 ${done.length} 张` + (failed.length ? `，失败:\n${failed.join('\n')}` : '') })
      return
    }
    send(res, 404, { error: 'not found' })
  }

  server.listen(state.adminPort, '127.0.0.1', () => {
    ctx.logger?.info?.(`[nl2sql] settings admin http://127.0.0.1:${state.adminPort}`)
    console.log(`[nl2sql] 配置页 http://127.0.0.1:${state.adminPort}`)
  })
  ctx.effect(() => () => {
    server.close()
  })
}
