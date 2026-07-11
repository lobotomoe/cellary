/** Diagnostics view -- service routing and protocol info */

import { Box, Text } from 'ink'
import type { DeviceHandle } from '../../../backend/types.js'

interface DiagnosticsProps {
  readonly handle: DeviceHandle
}

export function DiagnosticsView({ handle }: DiagnosticsProps): React.JSX.Element {
  const routing = handle.serviceRouting
  const protocols = handle.protocols
  const modelName = handle.model?.name

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>Diagnostics</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text dimColor>{'  Protocols'.padEnd(18)}</Text>
        <Text>{protocols.join(', ')}</Text>
      </Text>
      {modelName !== undefined && (
        <Text>
          <Text dimColor>{'  Model'.padEnd(18)}</Text>
          <Text>{modelName}</Text>
        </Text>
      )}
      <Text> </Text>
      <Text bold> Service Routing</Text>
      <Text> </Text>
      {Object.entries(routing).map(([name, info]) => (
        <Text key={name}>
          <Text dimColor>
            {'  '}
            {name.padEnd(16)}
          </Text>
          <Text color="cyan">{info.adapter}</Text>
          {info.reason !== '' && <Text dimColor> ({info.reason})</Text>}
          {info.contested && <Text color="yellow"> *</Text>}
        </Text>
      ))}
    </Box>
  )
}
