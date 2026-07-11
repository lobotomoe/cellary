import type { ModemCapabilities } from '../../types.js'

export interface Capabilities {
  discover(): Promise<ModemCapabilities>
}
