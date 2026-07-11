/**
 * Built-in vendor plugin and resolver registry.
 *
 * Centralizes all vendor-specific imports so that modem.ts has zero
 * direct vendor knowledge. The Modem class imports from here, not
 * from individual vendor directories.
 */

import type { DeviceStateResolver } from './discovery/observer-types.js'
import type { VendorPlugin } from './protocols/adapter.js'
import { alcatelPlugin } from './vendor/alcatel/index.js'
import { huaweiPlugin } from './vendor/huawei/index.js'
import { huaweiResolver } from './vendor/huawei/resolver.js'
import { msm8916OemPlugin } from './vendor/msm8916-oem/index.js'
import { msm8916OemResolver } from './vendor/msm8916-oem/resolver.js'
import { ztePlugin } from './vendor/zte/index.js'
import { zteResolver } from './vendor/zte/resolver.js'

/** Built-in vendor plugins. Covers all hardware vendors supported out of the box. */
export const DEFAULT_VENDORS: ReadonlyMap<string, VendorPlugin> = new Map([
  [alcatelPlugin.vendorId, alcatelPlugin],
  [huaweiPlugin.vendorId, huaweiPlugin],
  [msm8916OemPlugin.vendorId, msm8916OemPlugin],
  [ztePlugin.vendorId, ztePlugin],
])

/** Built-in device state resolvers for the DeviceObserver. */
export const DEFAULT_RESOLVERS: readonly DeviceStateResolver[] = [
  huaweiResolver,
  msm8916OemResolver,
  zteResolver,
]
