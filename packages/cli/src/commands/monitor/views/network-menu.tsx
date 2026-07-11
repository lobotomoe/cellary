/** Network menu view -- operator info, scan, select */

import type { AvailableNetwork } from 'cellary'
import { Box, Text } from 'ink'
import { useState } from 'react'
import type { DeviceHandle } from '../../../backend/types.js'
import type { LogEntry } from '../monitor-types.js'
import { createTimestamp } from '../monitor-types.js'
import { useMenu } from '../use-menu.js'

const STATUS_COLOR: Record<AvailableNetwork['status'], string> = {
  current: 'green',
  available: 'cyan',
  forbidden: 'yellow',
  unknown: 'yellow',
}

interface NetworkMenuProps {
  readonly handle: DeviceHandle
  readonly active: boolean
  readonly onLog: (entry: LogEntry) => void
}

type Action = 'scan' | 'auto'

const MENU_ITEMS: readonly { readonly id: Action; readonly label: string }[] = [
  { id: 'scan', label: 'Scan operators' },
  { id: 'auto', label: 'Automatic selection' },
]

export function NetworkMenu({ handle, active, onLog }: NetworkMenuProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [networks, setNetworks] = useState<readonly AvailableNetwork[] | undefined>()
  const [error, setError] = useState<string | undefined>()

  const { selectedIndex } = useMenu({
    itemCount: MENU_ITEMS.length,
    onSelect: (i) => {
      if (busy) return
      const action = MENU_ITEMS[i]?.id
      if (action === 'scan') doScan()
      if (action === 'auto') doAuto()
    },
    active: active && !busy,
  })

  function doScan(): void {
    setBusy(true)
    setError(undefined)
    setNetworks(undefined)
    onLog({ timestamp: createTimestamp(), type: 'command', message: 'Scanning operators...' })

    handle
      .scanNetworks()
      .then((results) => {
        setNetworks(results)
        onLog({
          timestamp: createTimestamp(),
          type: 'command',
          message: `Found ${results.length} operators`,
        })
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        onLog({ timestamp: createTimestamp(), type: 'error', message: `Scan failed: ${msg}` })
      })
      .finally(() => setBusy(false))
  }

  function doAuto(): void {
    setBusy(true)
    setError(undefined)
    onLog({ timestamp: createTimestamp(), type: 'command', message: 'Selecting automatic...' })

    handle
      .selectNetworkAutomatic()
      .then(() => {
        onLog({
          timestamp: createTimestamp(),
          type: 'command',
          message: 'Automatic network selection set',
        })
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        onLog({
          timestamp: createTimestamp(),
          type: 'error',
          message: `Auto select failed: ${msg}`,
        })
      })
      .finally(() => setBusy(false))
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>Network</Text>
      </Text>
      <Text> </Text>
      {MENU_ITEMS.map((item, i) => {
        const selected = i === selectedIndex
        return (
          <Text key={item.id}>
            <Text {...(selected ? { color: 'cyan', bold: true } : {})}>
              {selected ? '> ' : '  '}
              {item.label}
            </Text>
          </Text>
        )
      })}

      {busy && (
        <>
          <Text> </Text>
          <Text dimColor> Scanning... (this may take 30-60s)</Text>
        </>
      )}

      {error !== undefined && (
        <>
          <Text> </Text>
          <Text color="red">
            {'  '}
            {error}
          </Text>
        </>
      )}

      {networks !== undefined && networks.length > 0 && (
        <>
          <Text> </Text>
          {networks.map((net) => {
            const tech = net.technology !== undefined ? ` ${net.technology}` : ''
            const flag = net.status === 'current' ? ' *' : ''
            return (
              <Text key={net.numeric} color={STATUS_COLOR[net.status]}>
                {'  '}
                {net.name ?? net.numeric} [{net.numeric}] {net.status}
                {tech}
                {flag}
              </Text>
            )
          })}
        </>
      )}

      {networks !== undefined && networks.length === 0 && (
        <>
          <Text> </Text>
          <Text dimColor> No operators found.</Text>
        </>
      )}
    </Box>
  )
}
