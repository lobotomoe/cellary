import { Box, Text } from 'ink'
import type { CallStage, CallState } from './hooks.js'
import { useCallTimer } from './hooks.js'

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const paddedSeconds = seconds.toString().padStart(2, '0')
  return `${minutes}:${paddedSeconds}`
}

/** Stage labels for outgoing calls */
const OUTGOING_STAGE_LABEL: Record<CallStage, string> = {
  dialing: 'DIALING', // ATD sent, waiting for modem
  setup: 'CALLING', // ^ORIG: modem began CS setup
  alerting: 'RINGING', // ^CONF: network confirmed, remote phone ringing
  active: 'IN CALL', // ^CONN: answered
}

/** Status hints per stage */
const OUTGOING_STAGE_HINT: Record<CallStage, string> = {
  dialing: 'waiting for modem...',
  setup: 'modem setting up call...',
  alerting: 'remote phone is ringing',
  active: '',
}

export function CallStatus({
  callState,
}: {
  readonly callState: CallState
}): React.JSX.Element | null {
  const elapsed = useCallTimer(callState)

  if (!callState.active) return null

  const number = callState.number ?? 'unknown'

  // Incoming calls -- simple display
  if (callState.direction === 'incoming') {
    return (
      <Box paddingX={1} gap={2}>
        <Text color="yellow" bold>
          INCOMING {number} [{formatDuration(elapsed)}]
        </Text>
        <Text dimColor>
          <Text bold color="cyan">
            a
          </Text>{' '}
          answer{' '}
          <Text bold color="cyan">
            h
          </Text>{' '}
          hangup
        </Text>
      </Box>
    )
  }

  // Outgoing calls -- stage-aware display
  const label = OUTGOING_STAGE_LABEL[callState.stage]
  const stageHint = OUTGOING_STAGE_HINT[callState.stage]
  const isConnected = callState.stage === 'active'
  const isStuck = !isConnected && elapsed >= 15
  let callColor = 'yellow'
  if (isStuck) callColor = 'red'
  else if (isConnected) callColor = 'green'

  return (
    <Box paddingX={1} gap={2}>
      <Text color={callColor} bold>
        {label} {number} [{formatDuration(elapsed)}]
      </Text>
      {stageHint !== '' && <Text dimColor>{stageHint}</Text>}
      {!isConnected && (
        <Text dimColor>
          <Text bold color="cyan">
            h
          </Text>{' '}
          hangup
        </Text>
      )}
    </Box>
  )
}
