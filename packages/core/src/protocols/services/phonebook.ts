import type { NumberFormat } from './voice.js'

// ─── Phonebook Domain Types ─────────────────────────────────────────────────

/** Phonebook memory storage location. */
export type PhonebookStorage =
  | 'sim' // SIM card phonebook
  | 'device' // device (MT) memory
  | 'dialedCalls' // dialled calls list
  | 'missedCalls' // missed (unanswered) calls list
  | 'receivedCalls' // received calls list
  | 'ownNumbers' // SIM own numbers (MSISDN)
  | 'fixedDialing' // SIM fixed dialling phonebook

/** Phonebook storage info returned when selecting storage. */
export interface PhonebookStorageInfo {
  /** Currently selected storage */
  readonly storage: PhonebookStorage
  /** Number of entries currently used */
  readonly used: number
  /** Total capacity of the storage */
  readonly total: number
}

/** A single phonebook entry. */
export interface PhonebookEntry {
  /** 1-based index in the phonebook */
  readonly index: number
  /** Phone number */
  readonly number: string
  /** Number format (international includes country code prefix) */
  readonly format: NumberFormat
  /** Contact name */
  readonly name: string
}

// ─── Phonebook Service Interface ─────────────────────────────────────────────

/**
 * Phonebook (contacts) access.
 *
 * Supports reading, writing, and searching phonebook entries in various
 * storage locations (SIM, device memory, call logs).
 */
export interface Phonebook {
  /**
   * Select phonebook memory storage and query its capacity.
   *
   * @param storage - Storage location ('sim', 'device', 'dialedCalls', etc.)
   */
  selectStorage(storage: PhonebookStorage): Promise<PhonebookStorageInfo>

  /**
   * Read phonebook entries by index range.
   *
   * @param start - First index to read (1-based)
   * @param end - Last index to read (inclusive)
   */
  read(start: number, end: number): Promise<PhonebookEntry[]>

  /** Find phonebook entries by name substring. */
  find(text: string): Promise<PhonebookEntry[]>

  /**
   * Write a phonebook entry at a specific index.
   *
   * Number format (international/national) is auto-detected from the number
   * string: numbers starting with '+' are international, others national.
   *
   * @param index - 1-based index to write to
   * @param number - Phone number (e.g. "+37494123456" or "094123456")
   * @param name - Contact name
   */
  write(index: number, number: string, name: string): Promise<void>

  /** Delete a phonebook entry by index. */
  delete(index: number): Promise<void>
}
