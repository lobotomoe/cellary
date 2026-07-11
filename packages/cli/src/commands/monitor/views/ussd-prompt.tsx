/** USSD prompt view -- enter and send USSD codes */

import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { DeviceHandle } from '../../../backend/types.js'
import type { LogEntry } from '../monitor-types.js'
import { createTimestamp } from '../monitor-types.js'

const USSD_REGEX = /^[*#][*#0-9+]*#$/
const MAX_USSD_LEN = 40

interface UssdPromptProps {
  readonly handle: DeviceHandle
  readonly active: boolean
  readonly onLog: (entry: LogEntry) => void
}

export function UssdPrompt({ handle, active, onLog }: UssdPromptProps): React.JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [response, setResponse] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  useInput(
    (input, key) => {
      if (busy) return

      if (key.return && code !== '') {
        if (!USSD_REGEX.test(code) || code.length > MAX_USSD_LEN) {
          setError('Must start with * or #, end with #, max 40 chars')
          return
        }
        setError(undefined)
        setResponse(undefined)
        setBusy(true)

        const ussdCode = code
        onLog({ timestamp: createTimestamp(), type: 'command', message: `USSD ${ussdCode} sent` })

        handle.ussd
          .send(ussdCode)
          .then((result) => {
            setResponse(result)
            onLog({ timestamp: createTimestamp(), type: 'ussd', message: `USSD: ${result}` })
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            setError(msg)
            onLog({ timestamp: createTimestamp(), type: 'error', message: `USSD failed: ${msg}` })
          })
          .finally(() => {
            setBusy(false)
          })
        return
      }

      if (key.backspace || key.delete) {
        setCode((prev) => prev.slice(0, -1))
        return
      }

      if (!key.ctrl && !key.meta && input.length > 0) {
        setCode((prev) => prev + input)
      }
    },
    { isActive: active },
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>USSD</Text>
      </Text>
      <Text> </Text>
      <Text>
        {'  '}
        <Text dimColor>Code: </Text>
        <Text>{code}</Text>
        <Text dimColor>{busy ? ' (sending...)' : '_'}</Text>
      </Text>
      {error !== undefined && (
        <Text color="red">
          {'  '}
          {error}
        </Text>
      )}
      {response !== undefined && (
        <>
          <Text> </Text>
          <Text color="green">
            {'  '}
            {response}
          </Text>
        </>
      )}
      <Text> </Text>
      <Text dimColor>{'  '}Example: *100#, *111#</Text>
    </Box>
  )
}
