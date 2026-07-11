/**
 * Huawei USB PID database extracted from official macOS kext.
 *
 * Source: HuaweiDataCardDriver_10_9.kext (MobileConnectDriver.pkg inside Mobile Partner.app)
 * Contains per-PID interface role mappings from IOKitPersonalities.
 *
 * Kext plugins and their roles:
 * - HuaweiDataCardACMData: serial ports (PCUI, Modem, Diag, GPS, etc.)
 * - HuaweiDataCardECMControl: CDC-ECM network control (HiLink/NDIS)
 * - MBBEthernetData: NCM/RNDIS network (newer Balong 711+ platform)
 */

export const HUAWEI_VENDOR_ID = 0x12d1

/** Interface role assignments for a Huawei USB product ID. */
export interface HuaweiPidInfo {
  /** PCUI (AT command) interface number. Undefined if no AT port. */
  readonly pcui?: number | undefined
  /** CDC-ECM control interface number. Undefined if no NDIS/ECM. */
  readonly ecm?: number | undefined
}

/**
 * PID -> interface role mapping.
 * Keys are USB product IDs (number), values describe interface assignments.
 *
 * Only PIDs with at least one known interface role are included.
 * PIDs with ECM entries have HiLink/NDIS networking capability.
 */
const PID_DB: ReadonlyMap<number, HuaweiPidInfo> = new Map([
  // -- Legacy AT-only modems (no NDIS) ----------------------------------------
  // Pattern: Modem(0) Diag(1) PCUI(2) or variants
  [0x1001, { pcui: 2 }],
  [0x1003, { pcui: 1 }],
  [0x1004, { pcui: 2 }],
  [0x1401, { pcui: 2 }],
  [0x1403, { pcui: 0 }],
  [0x1405, { pcui: 0 }],
  [0x1406, { pcui: 2 }],
  [0x1408, { pcui: 0 }],
  [0x1409, { pcui: 2 }],
  [0x140a, { pcui: 2 }],
  [0x140b, { pcui: 2 }],
  [0x140c, { pcui: 3 }],
  [0x140e, { pcui: 2 }],
  [0x1411, { pcui: 2 }],
  [0x1412, { pcui: 2 }],
  [0x1413, { pcui: 3 }],
  [0x1414, { pcui: 2 }],
  [0x1415, { pcui: 2 }],
  [0x1416, { pcui: 2 }],
  [0x1417, { pcui: 3 }],
  [0x1418, { pcui: 2 }],
  [0x1419, { pcui: 2 }],
  [0x141a, { pcui: 1 }],
  [0x141b, { pcui: 1 }],
  [0x141c, { pcui: 0 }],
  [0x141d, { pcui: 1 }],
  [0x141e, { pcui: 1 }],
  [0x141f, { pcui: 0 }],
  [0x1420, { pcui: 1 }],
  [0x1421, { pcui: 0 }],
  [0x1422, { pcui: 2 }],
  [0x1424, { pcui: 2 }],
  [0x1425, { pcui: 2 }],
  [0x142b, { pcui: 1 }],

  // -- AT + ECM combo (HiLink-compatible) -------------------------------------
  [0x1404, { pcui: 2, ecm: 5 }],
  [0x1407, { pcui: 1, ecm: 4 }],
  [0x142c, { pcui: 2, ecm: 3 }],
  [0x142d, { pcui: 2, ecm: 3 }],
  [0x142e, { pcui: 0, ecm: 1 }],
  [0x142f, { pcui: 2, ecm: 3 }],
  [0x1430, { pcui: 0, ecm: 1 }],
  [0x1431, { pcui: 0, ecm: 3 }],
  [0x1432, { pcui: 0, ecm: 2 }],
  [0x1433, { pcui: 4, ecm: 1 }],
  [0x1434, { pcui: 2, ecm: 6 }],
  [0x1435, { pcui: 0, ecm: 2 }],
  [0x1436, { pcui: 4, ecm: 1 }],
  [0x1437, { pcui: 3, ecm: 0 }],
  [0x1438, { pcui: 2, ecm: 4 }],
  [0x1439, { pcui: 3, ecm: 6 }],
  [0x143a, { pcui: 3, ecm: 1 }],
  [0x143b, { pcui: 3, ecm: 1 }],
  [0x143c, { pcui: 4, ecm: 1 }],
  [0x143d, { pcui: 2 }],
  [0x143e, { pcui: 3, ecm: 1 }],
  [0x1447, { pcui: 0 }],
  [0x1448, { pcui: 1 }],
  [0x144a, { pcui: 2 }],
  [0x144b, { pcui: 4, ecm: 1 }],
  [0x144c, { pcui: 2 }],
  [0x144d, { pcui: 4, ecm: 1 }],
  [0x1444, { pcui: 0, ecm: 1 }],
  [0x1445, { pcui: 0, ecm: 1 }],
  [0x144e, { pcui: 0, ecm: 1 }],
  [0x144f, { pcui: 0, ecm: 1 }],
  [0x1450, { pcui: 2 }],
  [0x1451, { pcui: 2 }],
  [0x1452, { pcui: 2 }],
  [0x1453, { pcui: 2 }],
  [0x1454, { pcui: 2 }],
  [0x1455, { pcui: 2 }],
  [0x1456, { pcui: 2 }],
  [0x1457, { pcui: 2 }],
  [0x1458, { pcui: 2 }],
  [0x1459, { pcui: 2 }],
  [0x145a, { pcui: 2 }],
  [0x145b, { pcui: 2 }],
  [0x145c, { pcui: 2 }],
  [0x145d, { pcui: 2 }],
  [0x145e, { pcui: 2 }],
  [0x145f, { pcui: 2 }],
  [0x1460, { pcui: 2 }],
  [0x1461, { pcui: 2 }],
  [0x1462, { pcui: 2 }],
  [0x1463, { pcui: 2 }],
  [0x1464, { pcui: 2, ecm: 1 }],
  [0x1465, { pcui: 2, ecm: 1 }],
  [0x1466, { pcui: 2, ecm: 1 }],
  [0x1467, { pcui: 2, ecm: 1 }],
  [0x1468, { pcui: 2, ecm: 1 }],
  [0x1469, { pcui: 2, ecm: 1 }],
  [0x146a, { pcui: 2, ecm: 1 }],
  [0x146b, { pcui: 2, ecm: 1 }],
  [0x146c, { pcui: 2, ecm: 1 }],
  [0x146d, { pcui: 2, ecm: 1 }],
  [0x146e, { pcui: 2, ecm: 1 }],
  [0x146f, { pcui: 2, ecm: 1 }],
  [0x1470, { pcui: 2, ecm: 1 }],
  [0x1471, { pcui: 2, ecm: 1 }],
  [0x1472, { pcui: 2, ecm: 1 }],
  [0x1473, { pcui: 2, ecm: 1 }],
  [0x1474, { pcui: 2, ecm: 1 }],
  [0x1475, { pcui: 2, ecm: 1 }],
  [0x1476, { pcui: 2, ecm: 1 }],
  [0x1477, { pcui: 2, ecm: 1 }],
  [0x1478, { pcui: 2, ecm: 1 }],
  [0x1479, { pcui: 2, ecm: 1 }],
  [0x147a, { pcui: 2, ecm: 1 }],
  [0x147b, { pcui: 2, ecm: 1 }],
  [0x147c, { pcui: 2, ecm: 1 }],
  [0x147d, { pcui: 2, ecm: 1 }],
  [0x147e, { pcui: 2, ecm: 1 }],
  [0x147f, { pcui: 2, ecm: 1 }],
  [0x1480, { pcui: 2, ecm: 1 }],
  [0x1481, { pcui: 2, ecm: 1 }],
  [0x1482, { pcui: 2, ecm: 5 }],
  [0x1483, { pcui: 2, ecm: 5 }],
  [0x1484, { pcui: 2, ecm: 5 }],
  [0x1485, { pcui: 2, ecm: 5 }],
  [0x1486, { pcui: 2, ecm: 5 }],
  [0x1491, { pcui: 2, ecm: 3 }],
  [0x1492, { pcui: 2, ecm: 3 }],
  [0x1493, { pcui: 2, ecm: 3 }],
  [0x1494, { pcui: 2, ecm: 3 }],
  [0x1495, { pcui: 2, ecm: 3 }],
  [0x1496, { pcui: 2, ecm: 3 }],
  [0x1497, { pcui: 2, ecm: 3 }],
  [0x1498, { pcui: 2, ecm: 3 }],
  [0x1499, { pcui: 2, ecm: 3 }],
  [0x149a, { pcui: 2, ecm: 3 }],
  [0x149b, { pcui: 2, ecm: 2 }],
  [0x149c, { pcui: 2, ecm: 2 }],
  [0x149d, { pcui: 2, ecm: 2 }],
  [0x149e, { pcui: 2, ecm: 2 }],
  [0x149f, { pcui: 2, ecm: 2 }],
  [0x14a0, { pcui: 2, ecm: 2 }],
  [0x14a1, { pcui: 2, ecm: 2 }],
  [0x14a2, { pcui: 2, ecm: 2 }],
  [0x14a3, { pcui: 2, ecm: 2 }],
  [0x14a4, { pcui: 2, ecm: 2 }],
  [0x14a5, { pcui: 3, ecm: 1 }],
  [0x14a6, { pcui: 3, ecm: 1 }],
  [0x14a7, { pcui: 3, ecm: 1 }],
  [0x14ab, { pcui: 2, ecm: 1 }],
  [0x14ac, { pcui: 0, ecm: 1 }],
  [0x14ae, { pcui: 0, ecm: 1 }],
  [0x14af, { pcui: 0, ecm: 1 }],
  [0x14b0, { pcui: 0, ecm: 1 }],
  [0x14b1, { pcui: 0, ecm: 1 }],
  [0x14b8, { pcui: 2, ecm: 2 }],
  [0x14d0, { ecm: 2 }],
  [0x14d2, { pcui: 2, ecm: 1 }],
  [0x14d3, { pcui: 2 }],
  [0x14d4, { pcui: 2, ecm: 2 }],
  [0x14d6, { pcui: 0, ecm: 1 }],

  // -- AT-only stick modes (0x1506 range) -------------------------------------
  [0x1506, { pcui: 0 }],
  [0x1507, { pcui: 0 }],
  [0x1508, { pcui: 0 }],
  [0x1509, { pcui: 0 }],
  [0x150a, { pcui: 0 }],
  [0x150b, { pcui: 0 }],
  [0x150c, { pcui: 0 }],
  [0x150d, { pcui: 0 }],
  [0x150e, { pcui: 0 }],
  [0x150f, { pcui: 0 }],
  [0x1510, { pcui: 0, ecm: 1 }],
  [0x1511, { pcui: 0, ecm: 1 }],
  [0x1512, { pcui: 0, ecm: 1 }],
  [0x1513, { pcui: 0 }],
  [0x1514, { pcui: 0, ecm: 1 }],
  [0x1515, { ecm: 3 }],
  [0x1516, { pcui: 0, ecm: 1 }],
  [0x1517, { pcui: 0, ecm: 1 }],
  [0x1518, { pcui: 0, ecm: 1 }],
  [0x1519, { pcui: 0 }],
  [0x151b, { pcui: 0 }],
  [0x151c, { pcui: 0 }],
  [0x151d, { pcui: 0 }],
  [0x151e, { pcui: 0 }],
  [0x151f, { pcui: 0 }],

  // -- Newer AT-only (odd PIDs, 0x156d+ range) --------------------------------
  [0x156d, { pcui: 0 }],
  [0x156e, { pcui: 0 }],
  [0x156f, { pcui: 0 }],
  [0x1593, { pcui: 0 }],
  [0x1595, { pcui: 0 }],
  [0x1596, { pcui: 0 }],
  [0x159c, { pcui: 0 }],
  [0x159e, { pcui: 0 }],
  [0x15a0, { pcui: 0 }],
  [0x15a2, { pcui: 0 }],
  [0x15a4, { pcui: 0 }],
  [0x15a6, { pcui: 0 }],
  [0x15a8, { pcui: 0 }],
  [0x15aa, { pcui: 0 }],
  [0x15b0, { pcui: 0 }],
  [0x15b1, { pcui: 0 }],
  [0x15b2, { pcui: 0 }],
  [0x15b3, { pcui: 0 }],
  [0x15b4, { pcui: 0 }],
  [0x15b6, { pcui: 0 }],
  [0x15b7, { pcui: 0 }],
  [0x15b8, { pcui: 0 }],
  [0x15b9, { pcui: 0 }],
  [0x15ba, { pcui: 0 }],
  [0x15d1, { pcui: 0 }],
  [0x15d3, { pcui: 0 }],
  [0x15d5, { pcui: 0 }],
  [0x15d7, { pcui: 0 }],
  [0x15d9, { pcui: 0 }],
  [0x15db, { pcui: 0 }],
  [0x15dd, { pcui: 0 }],
  [0x15df, { pcui: 0 }],
  [0x15e1, { pcui: 0 }],
  [0x15e3, { pcui: 0 }],

  // -- 0x1c0x range ------------------------------------------------------------
  // 0x1c05 is the Qualcomm E173's 3-port modem mode (shared PID -- see
  // vendor/huawei/platforms/qualcomm). The rest are Balong 711+ platform
  // (NDIS/NCM via MBBEthernetData).
  [0x1c05, { pcui: 2 }],
  [0x1c06, { pcui: 2, ecm: 3 }],
  [0x1c07, { pcui: 0 }],
  [0x1c08, { pcui: 1 }],
  [0x1c09, { pcui: 0, ecm: 1 }],
  [0x1c0a, { pcui: 0, ecm: 2 }],
  [0x1c0c, { pcui: 3, ecm: 1 }],
  [0x1c0d, { pcui: 2 }],
  [0x1c0e, { pcui: 3, ecm: 1 }],
  [0x1c0f, { pcui: 3, ecm: 1 }],
  [0x1c10, { pcui: 2 }],
  [0x1c11, { pcui: 2 }],
  [0x1c12, { pcui: 2 }],
  [0x1c13, { pcui: 2 }],
  [0x1c14, { pcui: 3, ecm: 1 }],
  [0x1c15, { pcui: 3, ecm: 1 }],
  [0x1c16, { pcui: 3, ecm: 1 }],
  [0x1c17, { pcui: 1, ecm: 0 }],
  [0x1c18, { pcui: 2, ecm: 0 }],
  [0x1c19, { pcui: 2 }],
  [0x1c1a, { pcui: 3 }],
  [0x1c1c, { pcui: 0 }],
  [0x1c1d, { pcui: 3, ecm: 1 }],
  [0x1c1e, { pcui: 2, ecm: 3 }],
  [0x1c1f, { pcui: 0, ecm: 2 }],
  [0x1c21, { pcui: 2, ecm: 3 }],
  [0x1c22, { pcui: 0, ecm: 2 }],
  [0x1c23, { pcui: 0 }],

  // -- TD-SCDMA/CDMA devices (0x1d0x range) -----------------------------------
  [0x1d03, { pcui: 5 }],
  [0x1d09, { pcui: 5 }],
  [0x1d0d, { pcui: 5 }],
  [0x1d0f, { pcui: 5 }],
  [0x1d10, { pcui: 5 }],
  [0x1d17, { pcui: 5 }],
  [0x1d18, { pcui: 5 }],
  [0x1d19, { pcui: 5 }],
  [0x1d50, { pcui: 1 }],
  [0x1d51, { pcui: 3 }],
  [0x1d52, { pcui: 1 }],
  [0x1d53, { pcui: 1 }],
  [0x1d54, { pcui: 3 }],
  [0x1d55, { pcui: 3 }],

  // -- Debug/bare AT (0x2000+ range) ------------------------------------------
  [0x2020, { pcui: 0 }],
  [0x2021, { pcui: 0 }],
  [0x2022, { pcui: 0 }],
])

/**
 * Look up interface role assignments for a Huawei USB product ID.
 *
 * Returns undefined if the PID is not in the kext database.
 * A defined result means the PID was found in Huawei's official macOS driver
 * and interface assignments are known.
 */
export function lookupHuaweiPid(productId: number): HuaweiPidInfo | undefined {
  return PID_DB.get(productId)
}

/**
 * Check if a product ID is a known Huawei modem-mode PID.
 * Returns true if the PID appears in the kext database (any role).
 */
export function isKnownHuaweiModemPid(productId: number): boolean {
  return PID_DB.has(productId)
}

/**
 * Check if a product ID has HiLink/NDIS capability (ECM interface present).
 */
export function hasEcmCapability(productId: number): boolean {
  const info = PID_DB.get(productId)
  return info?.ecm !== undefined
}

/** Total number of PIDs in the database. */
export const HUAWEI_PID_COUNT = PID_DB.size
