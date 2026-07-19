/** SIM Toolkit (STK) interactive view */

import type { StkMenu, StkProactiveEvent, StkText } from 'cellary'
import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useState } from 'react'
import type { DeviceHandle } from '../../../backend/types.js'
import { useMenu } from '../use-menu.js'

interface StkViewProps {
  readonly handle: DeviceHandle
  readonly active: boolean
}

type StkScreen =
  | { readonly kind: 'loading' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'disabled'; readonly error?: string }
  | { readonly kind: 'menu'; readonly menu: StkMenu }
  | { readonly kind: 'text'; readonly text: StkText }
  | { readonly kind: 'input'; readonly prompt: string; readonly value: string }

export function StkView({ handle, active }: StkViewProps): React.JSX.Element {
  const [screen, setScreen] = useState<StkScreen>({ kind: 'loading' })
  const [status, setStatus] = useState<string | undefined>()

  // Enable STK and listen for events
  useEffect(() => {
    const stk = handle.stk

    if (!stk.enabled) {
      stk
        .enable()
        .then(() => {
          if (stk.menu !== undefined) {
            setScreen({ kind: 'menu', menu: stk.menu })
          } else {
            // Root menu not available yet -- wait for ^STIN URC from the SIM.
            // Some modems (E8372) don't respond to STGI immediately after enable;
            // the SIM sends the Setup Menu proactive command asynchronously.
            setScreen({ kind: 'waiting' })
          }
        })
        .catch((err: unknown) => {
          setScreen({
            kind: 'disabled',
            error: err instanceof Error ? err.message : String(err),
          })
        })
    } else if (stk.menu !== undefined) {
      setScreen({ kind: 'menu', menu: stk.menu })
    } else {
      setScreen({ kind: 'waiting' })
    }

    const onEvent = (event: StkProactiveEvent): void => {
      switch (event.type) {
        case 'menu':
          setScreen({ kind: 'menu', menu: event })
          setStatus(undefined)
          break
        case 'text':
          setScreen({ kind: 'text', text: event })
          break
        case 'input':
        case 'inkey':
          setScreen({ kind: 'input', prompt: event.prompt, value: '' })
          break
        case 'notification':
          setStatus(`SIM command ${event.commandType}`)
          break
      }
    }

    const onSessionEnd = (): void => {
      // Return to main menu after session ends
      if (stk.menu !== undefined) {
        setScreen({ kind: 'menu', menu: stk.menu })
      }
      setStatus('Session ended')
      setTimeout(() => setStatus(undefined), 2000)
    }

    const onError = (error: Error): void => {
      setStatus(`Error: ${error.message}`)
      setTimeout(() => setStatus(undefined), 3000)
    }

    // Register onEvent by reference (not inline wrappers) so the off() calls in
    // cleanup actually remove these listeners — otherwise each mount leaks five.
    stk.on('menu', onEvent)
    stk.on('text', onEvent)
    stk.on('input', onEvent)
    stk.on('inkey', onEvent)
    stk.on('notification', onEvent)
    stk.on('session:end', onSessionEnd)
    stk.on('error', onError)

    return () => {
      stk.off('menu', onEvent)
      stk.off('text', onEvent)
      stk.off('input', onEvent)
      stk.off('inkey', onEvent)
      stk.off('notification', onEvent)
      stk.off('session:end', onSessionEnd)
      stk.off('error', onError)
    }
  }, [handle])

  // Render based on screen type
  switch (screen.kind) {
    case 'loading':
      return (
        <Box flexDirection="column">
          <Text>
            <Text dimColor> Menu {'>'} </Text>
            <Text bold>SIM Toolkit</Text>
          </Text>
          <Text> </Text>
          <Text dimColor> Enabling STK...</Text>
        </Box>
      )

    case 'waiting':
      return (
        <Box flexDirection="column">
          <Text>
            <Text dimColor> Menu {'>'} </Text>
            <Text bold>SIM Toolkit</Text>
          </Text>
          <Text> </Text>
          <Text dimColor> Waiting for SIM menu...</Text>
        </Box>
      )

    case 'disabled':
      return (
        <Box flexDirection="column">
          <Text>
            <Text dimColor> Menu {'>'} </Text>
            <Text bold>SIM Toolkit</Text>
          </Text>
          <Text> </Text>
          <Text color="red">
            {' '}
            STK not available{screen.error !== undefined ? `: ${screen.error}` : ''}
          </Text>
        </Box>
      )

    case 'menu':
      return <StkMenuView handle={handle} menu={screen.menu} active={active} status={status} />

    case 'text':
      return <StkTextView handle={handle} text={screen.text} active={active} />

    case 'input':
      return (
        <StkInputView
          handle={handle}
          prompt={screen.prompt}
          value={screen.value}
          active={active}
          onValueChange={(v) => setScreen({ ...screen, value: v })}
        />
      )
  }
}

// ── STK Menu ────────────────────────────────────────────────────────────────

interface StkMenuViewProps {
  readonly handle: DeviceHandle
  readonly menu: StkMenu
  readonly active: boolean
  readonly status: string | undefined
}

function StkMenuView({ handle, menu, active, status }: StkMenuViewProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const { selectedIndex } = useMenu({
    itemCount: menu.items.length,
    onSelect: (i) => {
      const item = menu.items[i]
      if (item === undefined || busy) return
      setBusy(true)
      handle.stk
        .select(item.id)
        .catch(() => {})
        .finally(() => setBusy(false))
    },
    active: active && !busy,
  })

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>SIM Toolkit</Text>
      </Text>
      <Text> </Text>
      <Text bold> {menu.title}</Text>
      <Text> </Text>
      {menu.items.map((item, i) => {
        const selected = i === selectedIndex
        return (
          <Text key={item.id}>
            <Text {...(selected ? { color: 'cyan', bold: true } : {})}>
              {selected ? '> ' : '  '}
              {item.label}
            </Text>
          </Text>
        )
      })}
      {busy && (
        <>
          <Text> </Text>
          <Text dimColor> Loading...</Text>
        </>
      )}
      {status !== undefined && (
        <>
          <Text> </Text>
          <Text dimColor> {status}</Text>
        </>
      )}
    </Box>
  )
}

// ── STK Text ────────────────────────────────────────────────────────────────

interface StkTextViewProps {
  readonly handle: DeviceHandle
  readonly text: StkText
  readonly active: boolean
}

function StkTextView({ handle, text, active }: StkTextViewProps): React.JSX.Element {
  useInput(
    (_input, key) => {
      if (key.return) {
        handle.stk.confirm().catch(() => {})
      }
    },
    { isActive: active },
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>
          {' '}
          Menu {'>'} SIM Toolkit {'>'}{' '}
        </Text>
        <Text bold>Message</Text>
      </Text>
      <Text> </Text>
      <Text> {text.text}</Text>
      <Text> </Text>
      <Text dimColor> Press Enter to continue</Text>
    </Box>
  )
}

// ── STK Input ───────────────────────────────────────────────────────────────

interface StkInputViewProps {
  readonly handle: DeviceHandle
  readonly prompt: string
  readonly value: string
  readonly active: boolean
  readonly onValueChange: (value: string) => void
}

function StkInputView({
  handle,
  prompt,
  value,
  active,
  onValueChange,
}: StkInputViewProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const submit = useCallback(() => {
    if (value === '' || busy) return
    setBusy(true)
    handle.stk
      .input(value)
      .catch(() => {})
      .finally(() => setBusy(false))
  }, [handle, value, busy])

  useInput(
    (input, key) => {
      if (busy) return
      if (key.return) {
        submit()
        return
      }
      if (key.backspace || key.delete) {
        onValueChange(value.slice(0, -1))
        return
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        onValueChange(value + input)
      }
    },
    { isActive: active },
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>
          {' '}
          Menu {'>'} SIM Toolkit {'>'}{' '}
        </Text>
        <Text bold>Input</Text>
      </Text>
      <Text> </Text>
      <Text> {prompt}</Text>
      <Text> </Text>
      <Text>
        <Text color="cyan">{'  > '}</Text>
        <Text>{value}</Text>
        <Text dimColor>_</Text>
      </Text>
      {busy && <Text dimColor> Sending...</Text>}
    </Box>
  )
}
