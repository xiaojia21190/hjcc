/**
 * 轻量 API 服务：提供 dashboard 数据 + 触发重新抓取
 */
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'

const ROOT = join(import.meta.dir, '..')
const DATA_FILE = join(ROOT, 'data', 'dashboard.json')
const PUBLIC_FILE = join(ROOT, 'public', 'dashboard.json')
const PORT = Number(process.env.PORT || 8787)
const REFERENCE_DURATION_MS = 90_000

type FetchStatus = {
  state: 'fetching' | 'idle'
  startedAt: string | null
  updatedAt: string | null
}

let fetchStatus: FetchStatus = {
  state: 'idle',
  startedAt: null,
  updatedAt: null,
}

function isFetching() {
  return fetchStatus.state === 'fetching'
}

function markFetching() {
  const now = new Date().toISOString()
  fetchStatus = { state: 'fetching', startedAt: now, updatedAt: now }
}

function markIdle() {
  fetchStatus = {
    state: 'idle',
    startedAt: null,
    updatedAt: new Date().toISOString(),
  }
}

async function loadDashboard(): Promise<unknown> {
  const path = existsSync(DATA_FILE)
    ? DATA_FILE
    : existsSync(PUBLIC_FILE)
      ? PUBLIC_FILE
      : null
  if (!path) {
    return {
      updatedAt: null,
      categories: [],
      etfs: [],
      marketActiveCapHistory: [],
      marketActiveCapSource: '',
      summary: {
        totalHuijinMarketValue: null,
        latestActiveCapYi: null,
        latestActiveCapDate: null,
        etfCount: 0,
        latestReportDate: null,
      },
      message: '暂无数据，请先执行 bun run fetch',
    }
  }
  const text = await readFile(path, 'utf-8')
  return JSON.parse(text)
}

function runFetch(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'scripts/fetch-data.ts'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    if (url.pathname === '/api/health') {
      return Response.json(
        { ok: true, fetching: isFetching(), hasData: existsSync(DATA_FILE) },
        { headers: cors },
      )
    }

    if (url.pathname === '/api/refresh/status' && req.method === 'GET') {
      return Response.json(
        { ...fetchStatus, referenceDurationMs: REFERENCE_DURATION_MS },
        { headers: cors },
      )
    }

    if (url.pathname === '/api/dashboard') {
      const data = await loadDashboard()
      return Response.json(data, {
        headers: {
          ...cors,
          'Cache-Control': 'no-cache',
        },
      })
    }

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (isFetching()) {
        return Response.json(
          { ok: false, message: '正在抓取中' },
          { status: 409, headers: cors },
        )
      }
      markFetching()
      // 异步抓取
      runFetch()
        .then(async (code) => {
          markIdle()
          if (code === 0) {
            // 同步到 public
            try {
              await mkdir(join(ROOT, 'public'), { recursive: true })
              const raw = await readFile(DATA_FILE, 'utf-8')
              await writeFile(PUBLIC_FILE, raw, 'utf-8')
            } catch {
              /* ignore */
            }
          }
          console.log('refresh finished', code)
        })
        .catch((e) => {
          markIdle()
          console.error(e)
        })
      return Response.json(
        { ok: true, message: '已开始后台刷新' },
        { headers: cors },
      )
    }

    return new Response('Not Found', { status: 404, headers: cors })
  },
})

console.log(`API server http://127.0.0.1:${PORT}`)
