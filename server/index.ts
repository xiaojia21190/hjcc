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
// 实测一轮全量抓取 160–300s，板块补抓失败时逼近 5 分钟；这里给进度条一个接近真实耗时的参考。
const REFERENCE_DURATION_MS = 240_000

type FetchStatus = {
  state: 'fetching' | 'idle'
  startedAt: string | null
  updatedAt: string | null
  /** 当前 dashboard.json 的 updatedAt；fetch 成功后更新，供前端区分“跑完但没变”与“仍在跑” */
  dataUpdatedAt?: string | null
  /** 最近一次 fetch 的结果；null 表示从未跑过或正在首次运行 */
  lastRun?: {
    exitCode: number | null
    startedAt: string
    finishedAt: string
    durationMs: number
    dataUpdatedAt: string | null
  } | null
}

let fetchStatus: FetchStatus = {
  state: 'idle',
  startedAt: null,
  updatedAt: null,
  lastRun: null,
}

function isFetching() {
  return fetchStatus.state === 'fetching'
}

let currentRunStartedAt: string | null = null
let currentRunStartedMs: number | null = null
let preRunDataUpdatedAt: string | null = null

function markFetching() {
  const now = new Date().toISOString()
  currentRunStartedAt = now
  currentRunStartedMs = Date.now()
  preRunDataUpdatedAt = fetchStatus.dataUpdatedAt ?? null
  fetchStatus = { ...fetchStatus, state: 'fetching', startedAt: now, updatedAt: now }
}

function markIdle(exitCode: number | null) {
  const finishedAt = new Date().toISOString()
  const durationMs =
    currentRunStartedMs != null ? Date.now() - currentRunStartedMs : null
  const lastRun =
    currentRunStartedAt != null && durationMs != null
      ? {
          exitCode,
          startedAt: currentRunStartedAt,
          finishedAt,
          durationMs,
          dataUpdatedAt: fetchStatus.dataUpdatedAt ?? null,
        }
      : null
  fetchStatus = {
    state: 'idle',
    startedAt: null,
    updatedAt: finishedAt,
    dataUpdatedAt: fetchStatus.dataUpdatedAt ?? null,
    lastRun,
  }
  currentRunStartedAt = null
  currentRunStartedMs = null
  preRunDataUpdatedAt = null
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
          // 抓取成功后读取新快照的 updatedAt，供前端区分“跑完了但数据没变”与“仍在跑”
          if (code === 0) {
            try {
              const raw = await readFile(DATA_FILE, 'utf-8')
              const parsed = JSON.parse(raw) as { updatedAt?: string }
              fetchStatus.dataUpdatedAt = parsed.updatedAt ?? null
              // 同步到 public
              await mkdir(join(ROOT, 'public'), { recursive: true })
              await writeFile(PUBLIC_FILE, raw, 'utf-8')
            } catch {
              /* ignore */
            }
          }
          markIdle(code)
          console.log('refresh finished', code)
        })
        .catch((e) => {
          markIdle(1)
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
