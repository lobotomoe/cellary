import { describe, expect, it } from 'vitest'
import { cmeMessage, cmsMessage } from '../../../../src/protocols/at/channel/error-codes.js'

describe('cmeMessage', () => {
  it('resolves known code', () => {
    expect(cmeMessage(10)).toBe('SIM not inserted')
  })

  it('resolves SIM PIN required', () => {
    expect(cmeMessage(11)).toBe('SIM PIN required')
  })

  it('resolves no network service', () => {
    expect(cmeMessage(30)).toBe('No network service')
  })

  it('returns undefined for unknown code', () => {
    expect(cmeMessage(999999)).toBeUndefined()
  })
})

describe('cmsMessage', () => {
  it('resolves known code', () => {
    expect(cmsMessage(322)).toBe('Memory full')
  })

  it('resolves invalid text mode parameter', () => {
    expect(cmsMessage(305)).toBe('Invalid text mode parameter')
  })

  it('resolves SIM not inserted', () => {
    expect(cmsMessage(310)).toBe('SIM not inserted')
  })

  it('returns undefined for unknown code', () => {
    expect(cmsMessage(888888)).toBeUndefined()
  })
})
