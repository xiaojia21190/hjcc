import { describe, expect, test } from 'bun:test'

const packageJson = await Bun.file(
  `${import.meta.dir.replace(/\\scripts$/, '')}/package.json`,
).json() as {
  scripts: Record<string, string>
}

describe('development startup scripts', () => {
  test('抓取完成后才启动 API 与 Vite', () => {
    expect(packageJson.scripts.fetch).toBe('bun run scripts/fetch-data.ts')
    expect(packageJson.scripts.server).toBe('bun run server/index.ts')
    expect(packageJson.scripts.dev).toContain(
      'bun run fetch && concurrently',
    )
    expect(packageJson.scripts.dev).toContain('"bun run server"')
    expect(packageJson.scripts.dev).toContain('"bun run dev:vite"')
  })
})
