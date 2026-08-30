/**
 * 轻量 API 服务：提供 dashboard 数据 + 触发重新抓取
 */
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import type { Readable } from 'stream'

const ROOT = join(import.meta.dir, '..')
const DATA_FILE = join(ROOT, 'data', 'dashboard.json')
const PUBLIC_FILE = join(ROOT, 'public', 'dashboard.json')
const PORT = Number(process.env.PORT || 8787)
// 实测一轮全量抓取 160–300s，板块补抓失败时逼近 5 分钟；这里给进度条一个接近真实耗时的参考。
const REFERENCE_DURATION_MS = 240_000
// fetch 子进程硬超时：15 分钟。数据源卡住（如东财接口无响应）时不能无限等。
const FETCH_TIMEOUT_MS = 15 * 60 * 1000
// 日志环形缓冲：保留最近 200 行，供前端实时查看抓取进度
const LOG_BUFFER_MAX = 200
let logBuffer: string[] = []

function appendLog(line: string) {
  const ts = new Date().toISOString().slice(11, 19)
  logBuffer.push(`[${ts}] ${line}`)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX)
}

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
let fetchTimeoutHandle: ReturnType<typeof setTimeout> | null = null

function markFetching() {
  const now = new Date().toISOString()
  currentRunStartedAt = now
  currentRunStartedMs = Date.now()
  preRunDataUpdatedAt = fetchStatus.dataUpdatedAt ?? null
  logBuffer = []
  appendLog('fetch started')
  fetchStatus = { ...fetchStatus, state: 'fetching', startedAt: now, updatedAt: now }
  // 硬超时：防止数据源卡死导致 fetch 永不结束
  fetchTimeoutHandle = setTimeout(() => {
    appendLog(`fetch timeout after ${FETCH_TIMEOUT_MS / 1000}s, killing child process`)
    killChild()
  }, FETCH_TIMEOUT_MS)
}

function markIdle(exitCode: number | null) {
  if (fetchTimeoutHandle) {
    clearTimeout(fetchTimeoutHandle)
    fetchTimeoutHandle = null
  }
  const finishedAt = new Date().toISOString()
  const durationMs =
    currentRunStartedMs != null ? Date.now() - currentRunStartedMs : null
  appendLog(`fetch finished, exit=${exitCode}, duration=${durationMs ?? '?'}ms`)
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

let currentChild: ReturnType<typeof spawn> | null = null

function killChild() {
  if (currentChild && !currentChild.killed) {
    try { currentChild.kill('SIGKILL') } catch { /* already dead */ }
  }
}

function runFetch(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'scripts/fetch-data.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    currentChild = child

    // 逐行捕获 stdout/stderr，写入环形缓冲
    let pendingOut = ''
    let pendingErr = ''
    const drainStream = (stream: Readable, isErr: boolean) => {
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        const buf = isErr ? (pendingErr += text) : (pendingOut += text)
        // 按换行切分，保留最后不完整行
        const lines = buf.split('\n')
        const last = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) {
            appendLog(line)
            console.log(line)
          }
        }
        if (isErr) pendingErr = last
        else pendingOut = last
      })
    }
    drainStream(child.stdout!, false)
    drainStream(child.stderr!, true)

    child.on('error', (e) => {
      appendLog(`spawn error: ${e.message}`)
      currentChild = null
      reject(e)
    })
    child.on('exit', (code) => {
      // 冲刷残留行
      if (pendingOut.trim()) appendLog(pendingOut)
      if (pendingErr.trim()) appendLog(`[stderr] ${pendingErr}`)
      currentChild = null
      resolve(code ?? 1)
    })
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

    if (url.pathname === '/api/refresh/log' && req.method === 'GET') {
      return Response.json(
        { lines: logBuffer, fetching: isFetching() },
        { headers: { ...cors, 'Cache-Control': 'no-cache' } },
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
