import type { SignalInfo } from 'cellary'
import { Box, Text } from 'ink'
import type { DeviceHandle } from '../../backend/types.js'
import { protocolLabel } from '../../lib/format.js'
import {
  connectionQualityLabel,
  registrationColor,
  SIGNAL_EMPTY,
  signalBarParts,
  signalColor,
  signalQualityLabel,
} from '../../lib/signal-format.js'
import type { ConnectionState } from './hooks.js'
import { useOperator, usePhoneNumber, useRegistration, useSignal, useTemperature } from './hooks.js'

const SEP = ' \u00B7 ' // middle dot separator

/**
 * Format signal display text (after the bars).
 *
 * Default: human-readable quality labels ("Good signal, Stable connection").
 * Verbose: raw metrics (RSSI, RSRP, SINR, band).
 */
function formatSignalDisplay(signal: SignalInfo, verbose: boolean): string {
  if (verbose) {
    const rssiLabel = signal.rssi !== undefined ? `${signal.rssi} dBm` : 'N/A'
    const parts = [rssiLabel]
    if (signal.rsrp !== undefined) parts.push(`RSRP ${signal.rsrp}`)
    if (signal.sinr !== undefined) parts.push(`SINR ${signal.sinr}`)
    if (signal.band !== undefined) parts.push(signal.band)
    return parts.join('  ')
  }

  const parts = [signalQualityLabel(signal.rssi, signal.rsrp)]
  const connQuality = connectionQualityLabel(signal.sinr)
  if (connQuality !== undefined) parts.push(connQuality)
  return parts.join(', ')
}

function registrationLabel(status: string): string {
  switch (status) {
    case 'home':
      return 'Home'
    case 'roaming':
      return 'Roaming'
    case 'searching':
      return 'Searching...'
    case 'denied':
      return 'Denied'
    case 'notRegistered':
      return 'Not registered'
    default:
      return 'Unknown'
  }
}

interface StatusBarProps {
  readonly handle: DeviceHandle
  readonly verbose: boolean
  readonly connection: ConnectionState
  readonly compact?: boolean | undefined
  readonly backendMode: 'direct' | 'remote'
}

export function StatusBar({
  handle,
  verbose,
  connection,
  compact,
  backendMode,
}: StatusBarProps): React.JSX.Element {
  // All hooks called unconditionally (React rules of hooks)
  const signal = useSignal(handle)
  const reg = useRegistration(handle)
  const operator = useOperator(handle)
  const phoneNumber = usePhoneNumber(handle)
  const temperature = useTemperature(handle)

  const deviceName = handle.model?.name

  // Disconnected state — show reconnection message
  if (connection !== 'connected') {
    const message =
      connection === 'reconnecting'
        ? 'Device disconnected — reconnecting...'
        : 'Device disconnected — plug in to reconnect'

    return (
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold>
          <Text dimColor>{SIGNAL_EMPTY}</Text> <Text color="red">{message}</Text>
        </Text>
        <Text dimColor>{deviceName ?? 'Unknown device'}</Text>
      </Box>
    )
  }

  // Service capability badges
  const routing = handle.serviceRouting
  const badges: string[] = []
  if (routing.voice !== undefined) badges.push('Voice')
  if (routing.sms !== undefined) badges.push('SMS')
  if (routing.data !== undefined) badges.push('Data')
  if (routing.ussd !== undefined) badges.push('USSD')

  // Connected state — normal display
  const color = signal !== undefined ? signalColor(signal.rssi) : undefined
  const tech = signal?.technology ?? reg?.technology
  const signalText = signal !== undefined ? formatSignalDisplay(signal, verbose) : 'No signal'
  const protocols = handle.protocols.map(protocolLabel).join(' | ')

  const signalMeter =
    signal !== undefined && signal.rssi !== undefined ? (
      <SignalMeter rssi={signal.rssi} color={color} />
    ) : (
      <Text dimColor>{SIGNAL_EMPTY}</Text>
    )

  // Network info parts separated by middle dot
  const networkParts: React.JSX.Element[] = []
  if (operator !== undefined) {
    networkParts.push(<Text key="op">{operator}</Text>)
  }
  if (reg !== undefined) {
    const regColor = registrationColor(reg.status)
    networkParts.push(
      <Text key="reg">
        <Text color={regColor}>{'\u25CF'}</Text>
        {` ${registrationLabel(reg.status)}`}
      </Text>,
    )
  }
  if (phoneNumber !== undefined) {
    networkParts.push(<Text key="phone">{phoneNumber}</Text>)
  }

  // Compact mode: stacked lines for narrow terminals
  if (compact) {
    return (
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold>
          {signalMeter}
          {` ${signalText}`}
          {tech !== undefined ? ` ${tech}` : ''}
        </Text>
        <Text>
          {networkParts.map((part, i) => (
            <Text key={part.key}>
              {i > 0 && SEP}
              {part}
            </Text>
          ))}
        </Text>
        {badges.length > 0 && <Text dimColor>{badges.join(' | ')}</Text>}
        <Text dimColor>{backendMode === 'remote' ? 'via daemon' : 'direct'}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>
        {signalMeter}
        {` ${signalText}`}
        {tech !== undefined ? ` ${tech}` : ''}
        {networkParts.length > 0 && SEP}
        {networkParts.map((part, i) => (
          <Text key={part.key}>
            {i > 0 && SEP}
            {part}
          </Text>
        ))}
      </Text>
      <Text dimColor>
        {deviceName ?? 'Unknown device'}
        {badges.length > 0 ? `   ${badges.join(' | ')}` : ''}
        {verbose && temperature !== undefined ? `   ${temperature}\u00B0C` : ''}
        {verbose && reg?.locationAreaCode !== undefined ? `   LAC ${reg.locationAreaCode}` : ''}
        {verbose && reg?.cellId !== undefined ? ` Cell ${reg.cellId}` : ''}
        {verbose && protocols !== '' ? `   [${protocols}]` : ''}
        {`   ${backendMode === 'remote' ? 'via daemon' : 'direct'}`}
      </Text>
    </Box>
  )
}

/** Ascending signal bars with active (colored) and inactive (dim) parts. */
function SignalMeter({
  rssi,
  color,
}: {
  readonly rssi: number
  readonly color: string | undefined
}): React.JSX.Element {
  const { active, inactive } = signalBarParts(rssi)
  return (
    <Text>
      <Text {...(color !== undefined ? { color } : {})}>{active}</Text>
      <Text dimColor>{inactive}</Text>
    </Text>
  )
}
