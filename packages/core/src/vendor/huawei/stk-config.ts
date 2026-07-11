/**
 * Huawei-specific STK protocol configuration.
 *
 * Huawei modems use vendor-specific sequential numbering (0-12) for
 * ^STIN / ^STGI / ^STGR, not the 3GPP BER-TLV tag values (0x21-0x25).
 *
 * Type range confirmed via AT^STGI=? => (0-12) on E8372H-153.
 * See also Huawei AT Command Interface Specification for MU709/ME909.
 */

import { ParseError } from '../../errors.js'
import type { StkConfig } from '../../protocols/at/types.js'
import type {
  StkInkeyPrompt,
  StkInputPrompt,
  StkMenu,
  StkMenuItem,
  StkProactiveEvent,
  StkText,
} from '../../stk-types.js'

// -- Huawei command type numbering ────────────────────────────────────────────

const HUAWEI_COMMAND_TYPES = {
  refresh: 0,
  displayText: 1,
  getInkey: 2,
  getInput: 3,
  playTone: 4,
  selectItem: 5,
  sendSms: 6,
  sendSs: 7,
  sendUssd: 8,
  setupCall: 9,
  setupIdleText: 10,
  setupMenu: 11,
  setupEventList: 12,
} as const

const HUAWEI_RESPONSE_CODES = {
  ok: 0,
  backward: 1,
  noResponse: 2,
  endSession: 3,
} as const

// -- Response parser ──────────────────────────────────────────────────────────

// Menu / Select Item:
//   ^STGI: <cmdType>,<itemCount>,"Title"
//   ^STGI: <id>,"Label"
const MENU_HEADER_REGEX = /\^STGI:\s*\d+,\d+,"([^"]*)"$/
const MENU_ITEM_REGEX = /\^STGI:\s*(\d+),"([^"]*)"$/

// Display Text: ^STGI: <cmdType>,<clearMode>,"Text",<priority>
const DISPLAY_TEXT_REGEX = /\^STGI:\s*\d+,(\d+),"([^"]*)",(\d+)$/

// Get Input: ^STGI: <cmdType>,<minLen>,<maxLen>,<mode>,<format>,"Prompt"
const GET_INPUT_REGEX = /\^STGI:\s*\d+,(\d+),(\d+),(\d+),(\d+),"([^"]*)"$/

// Get Inkey: ^STGI: <cmdType>,<mode>,<format>,"Prompt"
const GET_INKEY_REGEX = /\^STGI:\s*\d+,(\d+),(\d+),"([^"]*)"$/

function parseMenu(lines: readonly string[]): StkMenu {
  const firstLine = lines[0]
  if (firstLine === undefined) {
    throw new ParseError('Empty ^STGI response for menu', '')
  }

  const headerMatch = MENU_HEADER_REGEX.exec(firstLine)
  if (!headerMatch) {
    throw new ParseError('Unexpected menu header format', firstLine)
  }

  const [, title] = headerMatch
  if (title === undefined) {
    throw new ParseError('Missing menu title', firstLine)
  }

  const items: StkMenuItem[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    const itemMatch = MENU_ITEM_REGEX.exec(line)
    if (!itemMatch) {
      throw new ParseError('Unexpected menu item format', line)
    }

    const [, idStr, label] = itemMatch
    if (idStr === undefined || label === undefined) {
      throw new ParseError('Missing menu item fields', line)
    }

    items.push({ id: Number.parseInt(idStr, 10), label })
  }

  return { type: 'menu', title, items }
}

function parseDisplayText(lines: readonly string[]): StkText {
  const line = lines[0]
  if (line === undefined) {
    throw new ParseError('Empty ^STGI response for display text', '')
  }

  const match = DISPLAY_TEXT_REGEX.exec(line)
  if (!match) {
    throw new ParseError('Unexpected display text format', line)
  }

  const [, clearModeStr, text, priorityStr] = match
  if (clearModeStr === undefined || text === undefined || priorityStr === undefined) {
    throw new ParseError('Missing display text fields', line)
  }

  return {
    type: 'text',
    text,
    clearMode: Number.parseInt(clearModeStr, 10),
    priority: Number.parseInt(priorityStr, 10),
  }
}

function parseGetInput(lines: readonly string[]): StkInputPrompt {
  const line = lines[0]
  if (line === undefined) {
    throw new ParseError('Empty ^STGI response for get input', '')
  }

  const match = GET_INPUT_REGEX.exec(line)
  if (!match) {
    throw new ParseError('Unexpected get input format', line)
  }

  const [, minStr, maxStr, modeStr, formatStr, prompt] = match
  if (
    minStr === undefined ||
    maxStr === undefined ||
    modeStr === undefined ||
    formatStr === undefined ||
    prompt === undefined
  ) {
    throw new ParseError('Missing get input fields', line)
  }

  return {
    type: 'input',
    prompt,
    minLength: Number.parseInt(minStr, 10),
    maxLength: Number.parseInt(maxStr, 10),
    mode: Number.parseInt(modeStr, 10),
    format: Number.parseInt(formatStr, 10),
  }
}

function parseGetInkey(lines: readonly string[]): StkInkeyPrompt {
  const line = lines[0]
  if (line === undefined) {
    throw new ParseError('Empty ^STGI response for get inkey', '')
  }

  const match = GET_INKEY_REGEX.exec(line)
  if (!match) {
    throw new ParseError('Unexpected get inkey format', line)
  }

  const [, modeStr, formatStr, prompt] = match
  if (modeStr === undefined || formatStr === undefined || prompt === undefined) {
    throw new ParseError('Missing get inkey fields', line)
  }

  return {
    type: 'inkey',
    prompt,
    mode: Number.parseInt(modeStr, 10),
    format: Number.parseInt(formatStr, 10),
  }
}

/**
 * Parse a Huawei ^STGI response into a typed StkProactiveEvent.
 */
function parseHuaweiStgiResponse(commandType: number, lines: readonly string[]): StkProactiveEvent {
  switch (commandType) {
    case HUAWEI_COMMAND_TYPES.setupMenu:
    case HUAWEI_COMMAND_TYPES.selectItem:
      return parseMenu(lines)
    case HUAWEI_COMMAND_TYPES.displayText:
      return parseDisplayText(lines)
    case HUAWEI_COMMAND_TYPES.getInput:
      return parseGetInput(lines)
    case HUAWEI_COMMAND_TYPES.getInkey:
      return parseGetInkey(lines)
    default:
      throw new ParseError(`Unsupported STK command type: ${commandType}`, lines.join('\n'))
  }
}

// -- Export ────────────────────────────────────────────────────────────────────

export const huaweiStkConfig: StkConfig = {
  commandTypes: HUAWEI_COMMAND_TYPES,
  responseCodes: HUAWEI_RESPONSE_CODES,
  sessionEndType: 254,
  parseResponse: parseHuaweiStgiResponse,
}
