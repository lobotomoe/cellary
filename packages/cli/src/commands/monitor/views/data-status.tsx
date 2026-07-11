/** Data connection status view -- PS attach, PDP contexts */

import type { DataConnectionStatus, PdpContext } from 'cellary'
import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import type { DeviceHandle } from '../../../backend/types.js'

interface DataStatusProps {
  readonly handle: DeviceHandle
}

function Row({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}): React.JSX.Element {
  return (
    <Text>
      <Text dimColor>{label.padEnd(16)}</Text>
      <Text>{value}</Text>
    </Text>
  )
}

interface DataState {
  readonly status: DataConnectionStatus
  readonly contexts: PdpContext[]
}

function useDataState(handle: DeviceHandle): DataState | undefined {
  const [state, setState] = useState<DataState | undefined>()

  useEffect(() => {
    let active = true
    Promise.all([handle.data.status(), handle.data.contexts()])
      .then(([status, contexts]) => {
        if (active) setState({ status, contexts })
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [handle])

  return state
}

function stateColor(state: string): string {
  switch (state) {
    case 'connected':
      return 'green'
    case 'connecting':
    case 'disconnecting':
      return 'yellow'
    case 'disconnected':
      return 'red'
    default:
      return 'white'
  }
}

export function DataStatusView({ handle }: DataStatusProps): React.JSX.Element {
  const data = useDataState(handle)

  if (data === undefined) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading data status...</Text>
      </Box>
    )
  }

  const { status, contexts } = data

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>Data</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text dimColor>{'  Connection'.padEnd(16)}</Text>
        <Text color={stateColor(status.state)}>{status.state}</Text>
      </Text>
      <Row label="  PS Attached" value={status.attached ? 'yes' : 'no'} />

      {contexts.length > 0 && (
        <>
          <Text> </Text>
          <Text bold> PDP Contexts</Text>
          <Text> </Text>
          <Text dimColor>
            {' '}
            {'CID'.padEnd(6)}
            {'Type'.padEnd(10)}
            {'APN'.padEnd(20)}
            {'Active'.padEnd(10)}IP
          </Text>
          {contexts.map((ctx) => (
            <Text key={ctx.cid}>
              {'  '}
              <Text>{String(ctx.cid).padEnd(6)}</Text>
              <Text>{ctx.pdpType.padEnd(10)}</Text>
              <Text>{(ctx.apn || '-').padEnd(20)}</Text>
              <Text color={ctx.active ? 'green' : 'red'}>
                {(ctx.active ? 'yes' : 'no').padEnd(10)}
              </Text>
              <Text>{ctx.address ?? '-'}</Text>
            </Text>
          ))}
        </>
      )}
    </Box>
  )
}
