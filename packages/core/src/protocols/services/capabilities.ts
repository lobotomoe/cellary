import type { ModemCapabilities } from '../../capability-types.js'

export interface Capabilities {
  discover(): Promise<ModemCapabilities>
}
