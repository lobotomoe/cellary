import { Box, Text } from 'ink'
import type { LogEntry } from './monitor-types.js'

const TYPE_LABELS: Record<LogEntry['type'], string> = {
  call: 'CALL',
  sms: 'SMS',
  network: 'NET',
  sim: 'SIM',
  ussd: 'USSD',
  command: 'CMD',
  error: 'ERR',
}

const TYPE_COLORS: Record<LogEntry['type'], string | undefined> = {
  call: 'yellow',
  sms: 'green',
  network: 'cyan',
  sim: 'magenta',
  ussd: 'blue',
  command: undefined,
  error: 'red',
}

const MAX_VISIBLE_ENTRIES = 20

function EntryMessage({ entry }: { readonly entry: LogEntry }): React.JSX.Element {
  const color = entry.color ?? TYPE_COLORS[entry.type]
  return color !== undefined ? (
    <Text color={color}>{entry.message}</Text>
  ) : (
    <Text>{entry.message}</Text>
  )
}

export function EventLog({
  entries,
}: {
  readonly entries: readonly LogEntry[]
}): React.JSX.Element {
  const visible =
    entries.length > MAX_VISIBLE_ENTRIES
      ? entries.slice(entries.length - MAX_VISIBLE_ENTRIES)
      : entries

  if (visible.length === 0) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <Text dimColor>Waiting for events...</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map((entry, i) => {
        const label = TYPE_LABELS[entry.type]
        const key = `${entry.timestamp}-${i}`
        return (
          <Text key={key}>
            <Text dimColor>{entry.timestamp}</Text>
            {'  '}
            <Text bold>{label.padEnd(4)}</Text>
            {'  '}
            <EntryMessage entry={entry} />
          </Text>
        )
      })}
    </Box>
  )
}
