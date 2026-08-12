import { describe, expect, test } from 'bun:test'
import * as format from './format'

type DateTimeFormatter = (value: string | null | undefined) => string

function getFormatter(): DateTimeFormatter {
  const formatter = (format as { formatDateTime?: DateTimeFormatter }).formatDateTime
  expect(typeof formatter).toBe('function')
  return formatter as DateTimeFormatter
}

describe('formatDateTime', () => {
  test('将 UTC 时间转换为北京时间', () => {
    expect(getFormatter()('2026-08-12T00:04:15.634Z')).toBe(
      '2026-08-12 08:04:15',
    )
  })

  test('空时间显示占位符', () => {
    expect(getFormatter()(null)).toBe('—')
  })
})
