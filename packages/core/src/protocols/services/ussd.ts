export interface Ussd {
  send(code: string): Promise<string>
  cancel(): Promise<void>
}
