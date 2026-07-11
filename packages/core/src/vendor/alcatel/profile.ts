import type { DeviceProfile } from '../../types.js'

/**
 * Alcatel modem profile.
 *
 * Alcatel devices (MW45V) have no AT serial interface -- they use CDC-ECM with
 * HTTP management only. The profile has no AT config; vendorId is used solely
 * for plugin routing (profile.vendorId matches plugin.vendorId).
 */
export const alcatelProfile: DeviceProfile = {
  vendorId: 'alcatel',
  name: 'Alcatel',
}
