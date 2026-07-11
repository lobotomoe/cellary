import type { TrafficStats } from '../../../types.js'
import type { Traffic } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { TrafficQueryConfig } from '../types.js'

/**
 * Traffic statistics via vendor-specific AT commands.
 *
 * No 3GPP standard exists for traffic counters -- this module delegates
 * entirely to a vendor-provided TrafficQueryConfig (command + parser).
 */
export class TrafficModule implements Traffic {
  constructor(
    private readonly channel: ATChannel,
    private readonly config: TrafficQueryConfig,
  ) {}

  async session(): Promise<TrafficStats> {
    const result = await this.channel.execute(this.config.command)
    const parsed = this.config.parse(result.lines)
    return parsed.session
  }

  async monthly(): Promise<TrafficStats> {
    const result = await this.channel.execute(this.config.command)
    const parsed = this.config.parse(result.lines)
    return parsed.total
  }
}
