/** Left panel: human-readable event feed */

import { Box, Text } from 'ink'
import type { LogEntry } from './monitor-types.js'

const TYPE_COLORS: Record<LogEntry['type'], string | undefined> = {
  call: 'yellow',
  sms: 'green',
  network: 'cyan',
  sim: 'magenta',
  ussd: 'blue',
  command: undefined,
  error: 'red',
}

const MAX_VISIBLE = 30

interface ActivityFeedProps {
  readonly entries: readonly LogEntry[]
  /** Available height in rows (used to limit visible entries) */
  readonly height?: number | undefined
}

export function ActivityFeed({ entries, height }: ActivityFeedProps): React.JSX.Element {
  const maxVisible = height !== undefined && height > 0 ? height : MAX_VISIBLE
  const visible = entries.length > maxVisible ? entries.slice(entries.length - maxVisible) : entries

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
        const color = entry.color ?? TYPE_COLORS[entry.type]
        const time = entry.timestamp.substring(0, 8) // HH:MM:SS (drop ms)
        const key = `${entry.timestamp}-${i}`
        return (
          <Text key={key} wrap="truncate">
            <Text dimColor>{time}</Text>
            {'  '}
            {color !== undefined ? (
              <Text color={color}>{entry.message}</Text>
            ) : (
              <Text>{entry.message}</Text>
            )}
          </Text>
        )
      })}
    </Box>
  )
}
