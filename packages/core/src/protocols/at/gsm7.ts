/**
 * GSM 7-bit Default Alphabet detection.
 *
 * 3GPP TS 23.038 section 6.2.1 defines the basic character set and
 * section 6.2.1.1 defines the extension table (accessed via ESC 0x1B).
 *
 * Used by SMS (encoding selection), USSD (CBS DCS), Cell Broadcast,
 * and SIM-toolkit string encoding.
 */

// GSM 7-bit Basic Character Set (3GPP TS 23.038 section 6.2.1)
// prettier-ignore
const GSM7_BASIC = new Set<string>([
  '@',
  '\u00A3',
  '$',
  '\u00A5',
  '\u00E8',
  '\u00E9',
  '\u00F9',
  '\u00EC',
  '\u00F2',
  '\u00C7',
  '\n',
  '\u00D8',
  '\u00F8',
  '\r',
  '\u00C5',
  '\u00E5',
  '\u0394',
  '_',
  '\u03A6',
  '\u0393',
  '\u039B',
  '\u03A9',
  '\u03A0',
  '\u03A8',
  '\u03A3',
  '\u0398',
  '\u039E',
  '\u00C6',
  '\u00E6',
  '\u00DF',
  '\u00C9',
  ' ',
  '!',
  '"',
  '#',
  '\u00A4',
  '%',
  '&',
  "'",
  '(',
  ')',
  '*',
  '+',
  ',',
  '-',
  '.',
  '/',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  ':',
  ';',
  '<',
  '=',
  '>',
  '?',
  '\u00A1',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
  '\u00C4',
  '\u00D6',
  '\u00D1',
  '\u00DC',
  '\u00A7',
  '\u00BF',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  '\u00E4',
  '\u00F6',
  '\u00F1',
  '\u00FC',
  '\u00E0',
])

// GSM 7-bit Extension Table characters (3GPP TS 23.038 section 6.2.1.1)
// These require an ESC prefix (0x1B) and count as 2 septets each.
// prettier-ignore
const GSM7_EXTENSION = new Set<string>([
  '\f', // form feed
  '^',
  '{',
  '}',
  '\\',
  '[',
  ']',
  '~',
  '|',
  '\u20AC', // euro sign
])

/**
 * Check if every character in the string belongs to the GSM 7-bit alphabet.
 *
 * Returns true if the text can be encoded using GSM 7-bit.
 * Returns false if any character requires UCS-2.
 */
export function isGsm7BitCompatible(text: string): boolean {
  for (const char of text) {
    if (!GSM7_BASIC.has(char) && !GSM7_EXTENSION.has(char)) {
      return false
    }
  }
  return true
}

/**
 * Count the GSM 7-bit septets a string occupies.
 *
 * Basic-alphabet characters cost one septet; extension-table characters
 * (`^ { } \ [ ] ~ |` and €) cost two (ESC + code). This is the value that must
 * be compared against the 160 / 153-septet limits — not the character count,
 * since a string of extension characters can exceed the limit at half the
 * length. Assumes `isGsm7BitCompatible(text)` is true.
 */
export function gsm7SeptetLength(text: string): number {
  let septets = 0
  for (const char of text) {
    septets += GSM7_EXTENSION.has(char) ? 2 : 1
  }
  return septets
}
