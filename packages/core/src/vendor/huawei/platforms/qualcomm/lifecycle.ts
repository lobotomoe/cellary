/**
 * Qualcomm platform lifecycle layer.
 *
 * Platform-level layer for Huawei's pre-Balong Qualcomm modems (E173, etc.).
 *
 * It currently adds no new states or transitions: the E173's usable state
 * (`stick`) and its storage -> stick edge already live in the Huawei vendor
 * layer. The layer exists so that Qualcomm platform detectors outrank generic
 * detectors (layer order = detector priority), and as the home for future
 * Qualcomm-specific states such as QDL/EDL (9008) download mode.
 *
 * Composed after HUAWEI_LAYER, as a sibling of BALONG_LAYER.
 */

import type { StateGraphLayer } from '../../../../lifecycle/types.js'

export const QUALCOMM_LAYER: StateGraphLayer = {
  name: 'qualcomm',
  nodes: [],
  edges: [],
}
