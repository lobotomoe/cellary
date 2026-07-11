import type { AvailableNetwork } from 'cellary'
import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useState } from 'react'
import type { DeviceHandle } from '../../backend/types.js'
import { protocolLabel } from '../../lib/format.js'
import type { LogEntry } from './monitor-types.js'
import { createTimestamp } from './monitor-types.js'

const OPERATOR_STATUS_COLOR: Record<AvailableNetwork['status'], string> = {
  current: 'green',
  available: 'cyan',
  forbidden: 'yellow',
  unknown: 'yellow',
}

interface CommandInputProps {
  readonly handle: DeviceHandle
  readonly onLog: (entry: LogEntry) => void
  readonly onStartCall?: ((number: string) => void) | undefined
}

async function executeCommand(
  handle: DeviceHandle,
  input: string,
  onLog: (entry: LogEntry) => void,
  onStartCall?: ((number: string) => void) | undefined,
): Promise<'quit' | undefined> {
  const trimmed = input.trim()
  if (trimmed === '') return undefined

  const routing = handle.serviceRouting
  const via = (service: string): string => {
    const info = routing[service]
    if (info === undefined) return ''
    const suffix = info.contested && info.reason !== '' ? ` (${info.reason})` : ''
    return ` via ${protocolLabel(info.adapter)}${suffix}`
  }

  // Quit
  if (trimmed === 'quit' || trimmed === 'q') {
    return 'quit'
  }

  // SMS send: sms +1234567890 Hello world
  if (trimmed.startsWith('sms ')) {
    const rest = trimmed.slice(4).trim()
    const spaceIdx = rest.indexOf(' ')
    if (spaceIdx === -1) {
      onLog({ timestamp: createTimestamp(), type: 'error', message: 'Usage: sms <number> <text>' })
      return undefined
    }
    const number = rest.slice(0, spaceIdx)
    const text = rest.slice(spaceIdx + 1)
    try {
      const ref = await handle.sms.send(number, text)
      onLog({
        timestamp: createTimestamp(),
        type: 'command',
        message: `SMS sent to ${number} (ref: ${ref})${via('sms')}`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `SMS failed: ${msg}` })
    }
    return undefined
  }

  // Call: call +1234567890
  if (trimmed.startsWith('call ')) {
    const number = trimmed.slice(5).trim()
    try {
      await handle.voice.dial(number)
      onStartCall?.(number)
      onLog({
        timestamp: createTimestamp(),
        type: 'call',
        message: `Calling ${number}...${via('voice')}`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `Dial failed: ${msg}` })
    }
    return undefined
  }

  // Answer
  if (trimmed === 'answer') {
    try {
      await handle.voice.answer()
      onLog({ timestamp: createTimestamp(), type: 'call', message: `Answered call${via('voice')}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `Answer failed: ${msg}` })
    }
    return undefined
  }

  // Hangup
  if (trimmed === 'hangup') {
    try {
      await handle.voice.hangup()
      onLog({ timestamp: createTimestamp(), type: 'call', message: `Hung up${via('voice')}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `Hangup failed: ${msg}` })
    }
    return undefined
  }

  // USSD: ussd *100#
  if (trimmed.startsWith('ussd ')) {
    const code = trimmed.slice(5).trim()
    if (code === '') {
      onLog({ timestamp: createTimestamp(), type: 'error', message: 'Usage: ussd <code>' })
      return undefined
    }
    // GSM 02.90 Section 2.1: USSD strings start with * or #, end with #.
    // 3GPP TS 23.090 Section 4.1: max USSD string length is 182 characters.
    // We use 40 as a practical limit -- real USSD codes rarely exceed 20 chars.
    if (!/^[*#][*#0-9+]*#$/.test(code) || code.length > 40) {
      onLog({
        timestamp: createTimestamp(),
        type: 'error',
        message: `Invalid USSD code: ${code}  (must start with * or #, end with #, max 40 chars)`,
      })
      return undefined
    }
    onLog({
      timestamp: createTimestamp(),
      type: 'command',
      message: `USSD ${code} sent${via('ussd')} (network may briefly switch to 2G/3G)`,
    })
    try {
      const response = await handle.ussd.send(code)
      onLog({
        timestamp: createTimestamp(),
        type: 'command',
        message: `USSD ${code} -> ${response}`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `USSD ${code}: ${msg}` })
    }
    return undefined
  }

  // Network scan: net:scan
  if (trimmed === 'net:scan') {
    onLog({ timestamp: createTimestamp(), type: 'command', message: 'Scanning operators...' })
    try {
      const networks = await handle.scanNetworks()
      if (networks.length === 0) {
        onLog({ timestamp: createTimestamp(), type: 'command', message: 'No operators found.' })
      } else {
        for (const net of networks) {
          const tech = net.technology !== undefined ? ` ${net.technology}` : ''
          const flag = net.status === 'current' ? ' *' : ''
          onLog({
            timestamp: createTimestamp(),
            type: 'command',
            color: OPERATOR_STATUS_COLOR[net.status],
            message: `  ${net.name ?? net.numeric} [${net.numeric}] ${net.status}${tech}${flag}`,
          })
        }
        onLog({
          timestamp: createTimestamp(),
          type: 'command',
          message: 'Use net:select <plmn> to connect, e.g. net:select 28310',
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `Scan failed: ${msg}` })
    }
    return undefined
  }

  // Manual network selection: net:select <plmn>
  if (trimmed.startsWith('net:select ')) {
    const plmn = trimmed.slice(11).trim()
    if (plmn === '') {
      onLog({ timestamp: createTimestamp(), type: 'error', message: 'Usage: net:select <plmn>' })
      return undefined
    }
    try {
      await handle.selectNetwork(plmn)
      onLog({ timestamp: createTimestamp(), type: 'command', message: `Selected operator ${plmn}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `Select failed: ${msg}` })
    }
    return undefined
  }

  // Automatic network selection: net:auto
  if (trimmed === 'net:auto') {
    try {
      await handle.selectNetworkAutomatic()
      onLog({
        timestamp: createTimestamp(),
        type: 'command',
        message: 'Automatic network selection',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onLog({ timestamp: createTimestamp(), type: 'error', message: `Auto select failed: ${msg}` })
    }
    return undefined
  }

  onLog({
    timestamp: createTimestamp(),
    type: 'error',
    message: `Unknown command: ${trimmed}. Try: sms, call, answer, hangup, ussd, net:scan, net:select, net:auto, quit`,
  })
  return undefined
}

export function CommandInput({ handle, onLog, onStartCall }: CommandInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const { exit } = useApp()

  const handleSubmit = useCallback(() => {
    if (busy) return
    const input = value
    setValue('')
    setBusy(true)

    executeCommand(handle, input, onLog, onStartCall)
      .then((result) => {
        if (result === 'quit') {
          exit()
        }
      })
      .catch(() => {})
      .finally(() => {
        setBusy(false)
      })
  }, [handle, onLog, onStartCall, value, busy, exit])

  useInput((input, key) => {
    if (busy) return

    if (key.return) {
      handleSubmit()
      return
    }

    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1))
      return
    }

    // Only accept printable characters
    if (!key.ctrl && !key.meta && input.length > 0) {
      setValue((prev) => prev + input)
    }
  })

  return (
    <Box borderStyle="single" paddingX={1}>
      <Text>
        <Text bold color="green">
          &gt;{' '}
        </Text>
        <Text>{value}</Text>
        <Text dimColor>{busy ? ' (running...)' : ''}</Text>
      </Text>
    </Box>
  )
}
