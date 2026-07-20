import { describe, expect, it } from 'vitest'

import { buildLogTransport } from '../../src/lib/logger.js'

const LOG_FILE = '/tmp/cellary-cli-test.log'

describe('buildLogTransport', () => {
  it('keeps the file log at info (never trace) without verbose', () => {
    const { level, targets } = buildLogTransport(false, LOG_FILE)

    expect(level).toBe('info')
    expect(targets).toHaveLength(1)
    expect(targets[0]?.target).toBe('pino/file')
    expect(targets[0]?.level).toBe('info')
    expect(targets[0]?.options).toMatchObject({ destination: LOG_FILE })
  })

  it('raises the file log to trace and adds a pretty stderr mirror with verbose', () => {
    const { level, targets } = buildLogTransport(true, LOG_FILE)

    expect(level).toBe('trace')
    expect(targets).toHaveLength(2)

    expect(targets[0]?.target).toBe('pino/file')
    expect(targets[0]?.level).toBe('trace')

    expect(targets[1]?.target).toBe('pino-pretty')
    expect(targets[1]?.level).toBe('trace')
    expect(targets[1]?.options).toMatchObject({ destination: 2 })
  })
})
