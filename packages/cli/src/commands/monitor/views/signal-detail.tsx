/** Signal detail view with live metrics and sparkline */

import { Box, Text } from 'ink'
import type { DeviceHandle } from '../../../backend/types.js'
import {
  connectionQualityLabel,
  formatSignalDetails,
  signalColor,
  signalQualityLabel,
  signalSparkline,
} from '../../../lib/signal-format.js'
import { useRegistration, useSignal, useSignalHistory, useTemperature } from '../hooks.js'

interface SignalDetailProps {
  readonly handle: DeviceHandle
}

function Row({
  label,
  value,
  color,
}: {
  readonly label: string
  readonly value: string
  readonly color?: string
}): React.JSX.Element {
  return (
    <Text>
      <Text dimColor>{label.padEnd(14)}</Text>
      {color !== undefined ? <Text color={color}>{value}</Text> : <Text>{value}</Text>}
    </Text>
  )
}

export function SignalDetail({ handle }: SignalDetailProps): React.JSX.Element {
  const signal = useSignal(handle, 5_000)
  const history = useSignalHistory(signal)
  const reg = useRegistration(handle)
  const temperature = useTemperature(handle)

  if (signal === undefined) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Waiting for signal data...</Text>
      </Box>
    )
  }

  const color = signalColor(signal.rssi)
  const quality = signalQualityLabel(signal.rssi, signal.rsrp)
  const connQuality = connectionQualityLabel(signal.sinr)
  const details = formatSignalDetails(signal)
  const tech = signal.technology ?? reg?.technology

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>Signal</Text>
      </Text>
      <Text> </Text>
      <Row
        label="  RSSI"
        value={signal.rssi !== undefined ? `${signal.rssi} dBm` : 'N/A'}
        color={color}
      />
      <Row label="  Quality" value={quality} color={color} />
      {signal.rsrp !== undefined && <Row label="  RSRP" value={`${signal.rsrp} dBm`} />}
      {signal.rsrq !== undefined && <Row label="  RSRQ" value={`${signal.rsrq} dB`} />}
      {signal.sinr !== undefined && (
        <Row
          label="  SINR"
          value={`${signal.sinr} dB${connQuality !== undefined ? ` (${connQuality})` : ''}`}
        />
      )}
      {signal.band !== undefined && <Row label="  Band" value={signal.band} />}
      {tech !== undefined && <Row label="  Technology" value={tech} />}
      {signal.bitErrorRate !== 99 && <Row label="  BER" value={String(signal.bitErrorRate)} />}
      {temperature !== undefined && <Row label="  Temperature" value={`${temperature} C`} />}
      {reg?.locationAreaCode !== undefined && <Row label="  LAC" value={reg.locationAreaCode} />}
      {reg?.cellId !== undefined && <Row label="  Cell ID" value={reg.cellId} />}
      {details !== undefined && (
        <>
          <Text> </Text>
          <Text dimColor> {details}</Text>
        </>
      )}
      {history.length > 1 && (
        <>
          <Text> </Text>
          <Text dimColor> History: </Text>
          <Text color={color}> {signalSparkline(history)}</Text>
        </>
      )}
    </Box>
  )
}
