/** AT Console view -- raw AT command input/output */

import { isAtAdapter } from 'cellary'
import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { DeviceHandle } from '../../../backend/types.js'

const MAX_HISTORY = 20

interface ConsoleEntry {
  readonly command: string
  readonly lines: readonly string[]
  readonly status: string
}

interface AtConsoleProps {
  readonly handle: DeviceHandle
  readonly active: boolean
}

export function AtConsole({ handle, active }: AtConsoleProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<readonly ConsoleEntry[]>([])

  useInput(
    (char, key) => {
      if (busy) return

      if (key.return && input.trim() !== '') {
        const cmd = input.trim()
        setInput('')
        setBusy(true)

        const at = handle.rawAccess?.adapter('at')
        if (!isAtAdapter(at)) {
          const entry: ConsoleEntry = {
            command: cmd,
            lines: ['No AT adapter available'],
            status: 'error',
          }
          setHistory((prev) => {
            const next = [...prev, entry]
            return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
          })
          setBusy(false)
          return
        }

        at.execute(cmd)
          .then((result) => {
            const entry: ConsoleEntry = {
              command: cmd,
              lines: result.lines,
              status: result.status.type,
            }
            setHistory((prev) => {
              const next = [...prev, entry]
              return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
            })
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            const entry: ConsoleEntry = {
              command: cmd,
              lines: [msg],
              status: 'error',
            }
            setHistory((prev) => {
              const next = [...prev, entry]
              return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
            })
          })
          .finally(() => {
            setBusy(false)
          })
        return
      }

      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1))
        return
      }

      if (!key.ctrl && !key.meta && char.length > 0) {
        setInput((prev) => prev + char)
      }
    },
    { isActive: active },
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>AT Console</Text>
      </Text>
      <Text> </Text>
      {history.map((entry, i) => {
        const key = `${i}-${entry.command}`
        return (
          <Box key={key} flexDirection="column">
            <Text color="green">{`  > ${entry.command}`}</Text>
            {entry.lines.map((line) => (
              <Text key={`${key}-${line}`}>
                {'    '}
                {line}
              </Text>
            ))}
            <Text {...(entry.status === 'ok' ? { color: 'green' } : { color: 'red' })}>
              {'    '}
              {entry.status.toUpperCase()}
            </Text>
          </Box>
        )
      })}
      <Text>
        {'  '}
        <Text color="green">&gt; </Text>
        <Text>{input}</Text>
        <Text dimColor>{busy ? ' (running...)' : '_'}</Text>
      </Text>
    </Box>
  )
}
