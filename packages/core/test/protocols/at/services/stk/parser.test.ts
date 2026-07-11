import { describe, expect, it } from 'vitest'
import { ParseError } from '../../../../../src/errors.js'
import { huaweiStkConfig } from '../../../../../src/vendor/huawei/stk-config.js'

const parseStgiResponse = huaweiStkConfig.parseResponse
const STK_CMD_DISPLAY_TEXT = huaweiStkConfig.commandTypes.displayText
const STK_CMD_GET_INKEY = huaweiStkConfig.commandTypes.getInkey
const STK_CMD_GET_INPUT = huaweiStkConfig.commandTypes.getInput
const STK_CMD_SELECT_ITEM = huaweiStkConfig.commandTypes.selectItem
const STK_CMD_SETUP_MENU = huaweiStkConfig.commandTypes.setupMenu

describe('parseStgiResponse', () => {
  // Huawei sequential types: Setup Menu = 11, Select Item = 5,
  // Display Text = 1, Get Inkey = 2, Get Input = 3

  describe('Setup Menu / Select Item', () => {
    it('parses a menu with multiple items', () => {
      const lines = [
        '^STGI: 11,3,"Main Menu"',
        '^STGI: 1,"Balance"',
        '^STGI: 2,"Internet"',
        '^STGI: 3,"Services"',
      ]

      const result = parseStgiResponse(STK_CMD_SETUP_MENU, lines)

      expect(result).toEqual({
        type: 'menu',
        title: 'Main Menu',
        items: [
          { id: 1, label: 'Balance' },
          { id: 2, label: 'Internet' },
          { id: 3, label: 'Services' },
        ],
      })
    })

    it('parses Select Item with same format', () => {
      const lines = ['^STGI: 5,2,"Choose Plan"', '^STGI: 1,"Monthly"', '^STGI: 2,"Weekly"']

      const result = parseStgiResponse(STK_CMD_SELECT_ITEM, lines)

      expect(result).toEqual({
        type: 'menu',
        title: 'Choose Plan',
        items: [
          { id: 1, label: 'Monthly' },
          { id: 2, label: 'Weekly' },
        ],
      })
    })

    it('parses a menu with a single item', () => {
      const lines = ['^STGI: 11,1,"Options"', '^STGI: 1,"OK"']

      const result = parseStgiResponse(STK_CMD_SETUP_MENU, lines)

      expect(result).toEqual({
        type: 'menu',
        title: 'Options',
        items: [{ id: 1, label: 'OK' }],
      })
    })

    it('parses a menu with empty title', () => {
      const lines = ['^STGI: 11,1,""', '^STGI: 1,"Item"']

      const result = parseStgiResponse(STK_CMD_SETUP_MENU, lines)

      expect(result.type).toBe('menu')
      expect(result).toHaveProperty('title', '')
    })

    it('throws ParseError on empty lines', () => {
      expect(() => parseStgiResponse(STK_CMD_SETUP_MENU, [])).toThrow(ParseError)
    })

    it('throws ParseError on malformed header', () => {
      expect(() => parseStgiResponse(STK_CMD_SETUP_MENU, ['GARBAGE'])).toThrow(ParseError)
    })

    it('throws ParseError on malformed item line', () => {
      const lines = ['^STGI: 11,1,"Menu"', 'NOT_A_MENU_ITEM']

      expect(() => parseStgiResponse(STK_CMD_SETUP_MENU, lines)).toThrow(ParseError)
    })
  })

  describe('Display Text', () => {
    it('parses a standard display text', () => {
      const lines = ['^STGI: 1,0,"Welcome to UCOM",0']

      const result = parseStgiResponse(STK_CMD_DISPLAY_TEXT, lines)

      expect(result).toEqual({
        type: 'text',
        text: 'Welcome to UCOM',
        clearMode: 0,
        priority: 0,
      })
    })

    it('parses high-priority auto-clear text', () => {
      const lines = ['^STGI: 1,1,"Balance: $5.00",1']

      const result = parseStgiResponse(STK_CMD_DISPLAY_TEXT, lines)

      expect(result).toEqual({
        type: 'text',
        text: 'Balance: $5.00',
        clearMode: 1,
        priority: 1,
      })
    })

    it('parses empty text', () => {
      const lines = ['^STGI: 1,0,"",0']

      const result = parseStgiResponse(STK_CMD_DISPLAY_TEXT, lines)

      expect(result).toEqual({
        type: 'text',
        text: '',
        clearMode: 0,
        priority: 0,
      })
    })

    it('throws ParseError on empty lines', () => {
      expect(() => parseStgiResponse(STK_CMD_DISPLAY_TEXT, [])).toThrow(ParseError)
    })

    it('throws ParseError on malformed response', () => {
      expect(() => parseStgiResponse(STK_CMD_DISPLAY_TEXT, ['^STGI: 1,0'])).toThrow(ParseError)
    })
  })

  describe('Get Input', () => {
    it('parses a digits-only input prompt', () => {
      const lines = ['^STGI: 3,1,10,0,0,"Enter PIN"']

      const result = parseStgiResponse(STK_CMD_GET_INPUT, lines)

      expect(result).toEqual({
        type: 'input',
        prompt: 'Enter PIN',
        minLength: 1,
        maxLength: 10,
        mode: 0,
        format: 0,
      })
    })

    it('parses an alphanumeric UCS2 input prompt', () => {
      const lines = ['^STGI: 3,0,160,1,1,"Enter message"']

      const result = parseStgiResponse(STK_CMD_GET_INPUT, lines)

      expect(result).toEqual({
        type: 'input',
        prompt: 'Enter message',
        minLength: 0,
        maxLength: 160,
        mode: 1,
        format: 1,
      })
    })

    it('throws ParseError on empty lines', () => {
      expect(() => parseStgiResponse(STK_CMD_GET_INPUT, [])).toThrow(ParseError)
    })

    it('throws ParseError on malformed response', () => {
      expect(() => parseStgiResponse(STK_CMD_GET_INPUT, ['^STGI: 3,1,10'])).toThrow(ParseError)
    })
  })

  describe('Get Inkey', () => {
    it('parses a digit-only inkey prompt', () => {
      const lines = ['^STGI: 2,0,0,"Press a key"']

      const result = parseStgiResponse(STK_CMD_GET_INKEY, lines)

      expect(result).toEqual({
        type: 'inkey',
        prompt: 'Press a key',
        mode: 0,
        format: 0,
      })
    })

    it('parses a yes/no inkey prompt', () => {
      const lines = ['^STGI: 2,2,0,"Confirm?"']

      const result = parseStgiResponse(STK_CMD_GET_INKEY, lines)

      expect(result).toEqual({
        type: 'inkey',
        prompt: 'Confirm?',
        mode: 2,
        format: 0,
      })
    })

    it('throws ParseError on empty lines', () => {
      expect(() => parseStgiResponse(STK_CMD_GET_INKEY, [])).toThrow(ParseError)
    })

    it('throws ParseError on malformed response', () => {
      expect(() => parseStgiResponse(STK_CMD_GET_INKEY, ['^STGI: 2,0'])).toThrow(ParseError)
    })
  })

  describe('unsupported command type', () => {
    it('throws ParseError for unknown command type', () => {
      expect(() => parseStgiResponse(99, ['some data'])).toThrow(ParseError)
      expect(() => parseStgiResponse(99, ['some data'])).toThrow('Unsupported STK command type: 99')
    })
  })
})
