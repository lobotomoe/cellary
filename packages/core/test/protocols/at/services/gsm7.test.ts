import { describe, expect, it } from 'vitest'
import { isGsm7BitCompatible } from '../../../../src/protocols/at/gsm7.js'

describe('isGsm7BitCompatible()', () => {
  it('accepts plain ASCII letters and digits', () => {
    expect(isGsm7BitCompatible('Hello World 123')).toBe(true)
  })

  it('accepts GSM 7-bit punctuation and symbols', () => {
    expect(isGsm7BitCompatible('!@#$%&*()_+-=<>?/.,;:\'"')).toBe(true)
  })

  it('accepts GSM 7-bit special characters', () => {
    // pound, yen, inverted ?, section, etc.
    expect(isGsm7BitCompatible('\u00A3\u00A5\u00BF\u00A7')).toBe(true)
  })

  it('accepts GSM 7-bit accented characters', () => {
    expect(isGsm7BitCompatible('\u00E8\u00E9\u00F9\u00EC\u00F2\u00E0')).toBe(true)
  })

  it('accepts GSM 7-bit extension table characters', () => {
    expect(isGsm7BitCompatible('^{}[]~|\\')).toBe(true)
  })

  it('accepts euro sign (extension table)', () => {
    expect(isGsm7BitCompatible('\u20AC')).toBe(true)
  })

  it('accepts empty string', () => {
    expect(isGsm7BitCompatible('')).toBe(true)
  })

  it('accepts newline and carriage return', () => {
    expect(isGsm7BitCompatible('line1\nline2\r')).toBe(true)
  })

  it('rejects Cyrillic characters', () => {
    expect(isGsm7BitCompatible('\u041F\u0440\u0438\u0432\u0435\u0442')).toBe(false)
  })

  it('rejects Armenian characters', () => {
    expect(isGsm7BitCompatible('\u0531\u0532\u0533')).toBe(false)
  })

  it('rejects emoji', () => {
    expect(isGsm7BitCompatible('\u{1F600}')).toBe(false)
  })

  it('rejects mixed ASCII + non-GSM character', () => {
    expect(isGsm7BitCompatible('Hello \u041C\u0438\u0440')).toBe(false)
  })

  it('rejects CJK characters', () => {
    expect(isGsm7BitCompatible('\u4F60\u597D')).toBe(false)
  })

  it('rejects Arabic characters', () => {
    expect(isGsm7BitCompatible('\u0645\u0631\u062D\u0628\u0627')).toBe(false)
  })

  it('rejects Persian characters', () => {
    // "salam" in Persian
    expect(isGsm7BitCompatible('\u0633\u0644\u0627\u0645')).toBe(false)
  })

  it('rejects Hebrew characters', () => {
    // "shalom" in Hebrew
    expect(isGsm7BitCompatible('\u05E9\u05DC\u05D5\u05DD')).toBe(false)
  })

  it('rejects Chinese characters', () => {
    // "hello" in Chinese
    expect(isGsm7BitCompatible('\u4F60\u597D\u4E16\u754C')).toBe(false)
  })

  it('rejects emoji (surrogate pair)', () => {
    expect(isGsm7BitCompatible('\u{1F44D}')).toBe(false) // thumbs up
  })

  it('rejects mixed ASCII + emoji', () => {
    expect(isGsm7BitCompatible('Hello \u{1F600}')).toBe(false)
  })
})
