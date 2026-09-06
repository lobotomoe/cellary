/** SMS sub-menu, unified inbox, compose, and read views */

import type { SmsCount, SmsMessage } from 'cellary'
import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DeviceHandle } from '../../../backend/types.js'
import type { ArchivedMessage, MessageStore } from '../../../storage/types.js'
import type { ViewId } from '../navigation.js'
import { useMenu } from '../use-menu.js'

// ── Unified message type ────────────────────────────────────────────────────

type InboxItem =
  | { readonly source: 'sim'; readonly msg: SmsMessage }
  | { readonly source: 'archive'; readonly msg: ArchivedMessage }

function itemTimestamp(item: InboxItem): Date | undefined {
  if (item.source === 'sim') return item.msg.timestamp
  return item.msg.timestamp !== '' ? new Date(item.msg.timestamp) : undefined
}

function itemFrom(item: InboxItem): string {
  return item.source === 'sim' ? item.msg.address : item.msg.from
}

function itemText(item: InboxItem): string {
  return item.msg.text
}

function itemStatus(item: InboxItem): string {
  return item.msg.status
}

function itemKey(item: InboxItem): string {
  if (item.source === 'sim') return `sim-${item.msg.index}`
  return `arc-${item.msg.id}`
}

function formatShortDate(date: Date | undefined): string {
  if (date === undefined) return '  --  '
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hours}:${minutes}`
}

// ── SMS Menu (sub-menu) ──────────────────────────────────────────────────────

interface SmsMenuProps {
  readonly active: boolean
  readonly onNavigate: (view: ViewId) => void
}

interface SmsMenuItem {
  readonly id: string
  readonly label: string
  readonly view: ViewId
}

const SMS_MENU_ITEMS: readonly SmsMenuItem[] = [
  { id: 'inbox', label: 'Inbox', view: 'sms-inbox' },
  { id: 'compose', label: 'Send SMS', view: 'sms-compose' },
]

export function SmsMenu({ active, onNavigate }: SmsMenuProps): React.JSX.Element {
  const { selectedIndex } = useMenu({
    itemCount: SMS_MENU_ITEMS.length,
    onSelect: (i) => {
      const item = SMS_MENU_ITEMS[i]
      if (item !== undefined) onNavigate(item.view)
    },
    active,
  })

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>SMS</Text>
      </Text>
      <Text> </Text>
      {SMS_MENU_ITEMS.map((item, i) => {
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
    </Box>
  )
}

// ── SMS Inbox (unified: SIM + archive) ───────────────────────────────────────

interface SmsInboxProps {
  readonly handle: DeviceHandle
  readonly store: MessageStore
  readonly active: boolean
  readonly onReadMessage: (index: number) => void
}

function useSmsInbox(handle: DeviceHandle): {
  messages: readonly SmsMessage[]
  count: SmsCount | undefined
  loading: boolean
  refresh: () => void
} {
  const [messages, setMessages] = useState<readonly SmsMessage[]>([])
  const [count, setCount] = useState<SmsCount | undefined>()
  const [loading, setLoading] = useState(true)

  const refresh = useCallback((): void => {
    setLoading(true)
    handle.sms
      .list('all')
      .then((msgs) => {
        setMessages(msgs)
      })
      .catch(() => {
        setMessages([])
      })
      .finally(() => setLoading(false))

    handle.sms
      .count?.()
      .then((c) => setCount(c))
      .catch(() => {})
  }, [handle])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { messages, count, loading, refresh }
}

export function SmsInbox({
  handle,
  store,
  active,
  onReadMessage,
}: SmsInboxProps): React.JSX.Element {
  const { messages: simMessages, count, loading, refresh } = useSmsInbox(handle)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | undefined>()
  const [revision, setRevision] = useState(0)

  // Load archived messages
  const archivedMessages = store.listArchived({ limit: 100, offset: 0 })
  void revision // force re-read on revision change

  // Merge SIM + archived into unified list sorted by date (newest first)
  const items: readonly InboxItem[] = useMemo(() => {
    const simItems: InboxItem[] = simMessages.map((msg) => ({ source: 'sim', msg }))
    const archiveItems: InboxItem[] = archivedMessages.map((msg) => ({ source: 'archive', msg }))
    const all = [...simItems, ...archiveItems]
    all.sort((a, b) => (itemTimestamp(b)?.getTime() ?? 0) - (itemTimestamp(a)?.getTime() ?? 0))
    return all
  }, [simMessages, archivedMessages])

  const { selectedIndex } = useMenu({
    itemCount: items.length,
    onSelect: (i) => {
      if (confirmDelete) return
      const item = items[i]
      if (item === undefined) return
      if (item.source === 'sim') {
        onReadMessage(item.msg.index)
      }
      // Archive items open inline (no separate read view needed for now)
    },
    active: active && !deleting && !confirmDelete,
  })

  useInput(
    (input) => {
      if (confirmDelete) {
        if (input === 'y') {
          const item = items[selectedIndex]
          if (item === undefined) return
          setConfirmDelete(false)
          setDeleting(true)

          if (item.source === 'sim') {
            handle.sms
              .delete(item.msg.index)
              .then(() => refresh())
              .catch(() => {})
              .finally(() => setDeleting(false))
          } else {
            store.deleteArchived(item.msg.id)
            setRevision((r) => r + 1)
            setDeleting(false)
          }
        }
        if (input === 'n' || input === 'N') {
          setConfirmDelete(false)
        }
        return
      }
      if (input === 'r') {
        refresh()
        setRevision((r) => r + 1)
      }
      if (input === 'd' && !deleting && items.length > 0) {
        setConfirmDelete(true)
      }
      if (input === 'a' && !deleting) {
        const item = items[selectedIndex]
        if (item === undefined || item.source !== 'sim') return
        const msg = item.msg
        store.archiveMessage({
          from: msg.address,
          text: msg.text,
          timestamp: msg.timestamp,
          status: msg.status,
          storage: 'SM',
        })
        // Archive = save + delete from SIM
        setDeleting(true)
        handle.sms
          .delete(msg.index)
          .then(() => {
            setStatusMsg('Archived')
            setRevision((r) => r + 1)
            refresh()
            setTimeout(() => setStatusMsg(undefined), 1500)
          })
          .catch(() => {
            setStatusMsg('Saved but failed to remove from SIM')
            setTimeout(() => setStatusMsg(undefined), 2000)
          })
          .finally(() => setDeleting(false))
      }
    },
    { isActive: active },
  )

  if (loading) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading messages...</Text>
      </Box>
    )
  }

  const capacityStr =
    count !== undefined
      ? `${simMessages.length}/${count.capacity} SIM`
      : `${simMessages.length} SIM`
  const archiveStr = archivedMessages.length > 0 ? `, ${archivedMessages.length} archived` : ''

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor> SMS {'>'} </Text>
          <Text bold>Inbox (0)</Text>
        </Text>
        <Text> </Text>
        <Text dimColor> No messages. Press 'r' to refresh.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> SMS {'>'} </Text>
        <Text bold>
          Inbox ({capacityStr}
          {archiveStr})
        </Text>
      </Text>
      <Text> </Text>
      {items.map((item, i) => {
        const selected = i === selectedIndex
        const text = itemText(item)
        const preview = text.length > 25 ? `${text.substring(0, 25)}...` : text
        const unread = itemStatus(item) === 'unread'
        const date = formatShortDate(itemTimestamp(item))
        const isArchived = item.source === 'archive'
        return (
          <Text key={itemKey(item)} wrap="truncate">
            <Text {...(selected ? { color: 'cyan', bold: true } : {})}>
              {selected ? '> ' : '  '}
            </Text>
            {unread && (
              <Text color="green" bold>
                *{' '}
              </Text>
            )}
            <Text dimColor>{date} </Text>
            <Text {...(selected ? { bold: true } : { dimColor: !unread })}>{itemFrom(item)}</Text>
            {isArchived && <Text dimColor> [saved]</Text>}
            <Text dimColor> {preview}</Text>
          </Text>
        )
      })}
      {confirmDelete &&
        (() => {
          const selectedItem = items[selectedIndex]
          const deleteFrom = selectedItem !== undefined ? itemFrom(selectedItem) : '?'
          return (
            <>
              <Text> </Text>
              <Text color="yellow"> Delete message from {deleteFrom}? (y/n)</Text>
            </>
          )
        })()}
      {deleting && (
        <>
          <Text> </Text>
          <Text dimColor> Deleting...</Text>
        </>
      )}
      {statusMsg !== undefined && (
        <>
          <Text> </Text>
          <Text color="green"> {statusMsg}</Text>
        </>
      )}
    </Box>
  )
}

// ── SMS Read ─────────────────────────────────────────────────────────────────

interface SmsReadProps {
  readonly handle: DeviceHandle
  readonly store: MessageStore
  readonly messageIndex: number
  readonly active: boolean
  readonly onDeleted: () => void
}

export function SmsRead({
  handle,
  store,
  messageIndex,
  active,
  onDeleted,
}: SmsReadProps): React.JSX.Element {
  const [message, setMessage] = useState<SmsMessage | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useInput(
    (input) => {
      if (confirmDelete) {
        if (input === 'y') {
          setConfirmDelete(false)
          setDeleting(true)
          handle.sms
            .delete(messageIndex)
            .then(() => onDeleted())
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err))
              setDeleting(false)
            })
        }
        if (input === 'n' || input === 'N') {
          setConfirmDelete(false)
        }
        return
      }
      if (input === 'd' && !deleting && message !== undefined) {
        setConfirmDelete(true)
      }
      if (input === 'a' && !deleting && message !== undefined) {
        store.archiveMessage({
          from: message.address,
          text: message.text,
          timestamp: message.timestamp,
          status: message.status,
          storage: 'SM',
        })
        // Archive = save + delete from SIM
        setDeleting(true)
        handle.sms
          .delete(messageIndex)
          .then(() => onDeleted())
          .catch((err: unknown) => {
            setError(
              `Saved but failed to remove from SIM: ${err instanceof Error ? err.message : String(err)}`,
            )
            setDeleting(false)
          })
      }
    },
    { isActive: active },
  )

  useEffect(() => {
    let mounted = true
    handle.sms
      .read(messageIndex)
      .then((msg) => {
        if (mounted) setMessage(msg)
      })
      .catch((err: unknown) => {
        if (mounted) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      mounted = false
    }
  }, [handle, messageIndex])

  if (error !== undefined) {
    return (
      <Box paddingX={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    )
  }

  if (message === undefined) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading message...</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>
          {' '}
          SMS {'>'} Inbox {'>'}{' '}
        </Text>
        <Text bold>Message #{message.index}</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text dimColor>{message.direction === 'outgoing' ? '  To:    ' : '  From:  '}</Text>
        <Text bold>{message.address}</Text>
      </Text>
      <Text>
        <Text dimColor>{'  Date:  '}</Text>
        <Text>{message.timestamp !== undefined ? message.timestamp.toLocaleString() : '--'}</Text>
      </Text>
      <Text> </Text>
      <Text>
        {'  '}
        {message.text}
      </Text>
      {confirmDelete && (
        <>
          <Text> </Text>
          <Text color="yellow"> Delete this message? (y/n)</Text>
        </>
      )}
      {deleting && (
        <>
          <Text> </Text>
          <Text dimColor> Deleting...</Text>
        </>
      )}
    </Box>
  )
}

// ── SMS Compose ──────────────────────────────────────────────────────────────

interface SmsComposeProps {
  readonly handle: DeviceHandle
  readonly active: boolean
  readonly onBack: () => void
}

export function SmsCompose({ handle, active, onBack }: SmsComposeProps): React.JSX.Element {
  const [number, setNumber] = useState('')
  const [text, setText] = useState('')
  const [field, setField] = useState<'number' | 'text'>('number')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | undefined>()

  useInput(
    (input, key) => {
      if (busy) return

      if (key.tab) {
        setField((prev) => (prev === 'number' ? 'text' : 'number'))
        return
      }

      if (key.return && field === 'text' && number !== '' && text !== '') {
        setBusy(true)
        setResult(undefined)
        handle.sms
          .send(number, text)
          .then((ref) => {
            setResult(`Sent (ref: ${ref})`)
            setTimeout(() => onBack(), 1500)
          })
          .catch((err: unknown) => {
            setResult(`Failed: ${err instanceof Error ? err.message : String(err)}`)
          })
          .finally(() => setBusy(false))
        return
      }

      if (key.backspace || key.delete) {
        if (field === 'number') setNumber((prev) => prev.slice(0, -1))
        else setText((prev) => prev.slice(0, -1))
        return
      }

      if (!key.ctrl && !key.meta && input.length > 0) {
        if (field === 'number') setNumber((prev) => prev + input)
        else setText((prev) => prev + input)
      }
    },
    { isActive: active },
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> SMS {'>'} </Text>
        <Text bold>Send SMS</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text {...(field === 'number' ? { color: 'cyan' } : { dimColor: true })}>{'  To:   '}</Text>
        <Text>{number}</Text>
        {field === 'number' && <Text dimColor>_</Text>}
      </Text>
      <Text>
        <Text {...(field === 'text' ? { color: 'cyan' } : { dimColor: true })}>{'  Text: '}</Text>
        <Text>{text}</Text>
        {field === 'text' && <Text dimColor>_</Text>}
      </Text>
      {busy && <Text dimColor>{'  '}Sending...</Text>}
      {result !== undefined && (
        <Text color={result.startsWith('Sent') ? 'green' : 'red'}>
          {'  '}
          {result}
        </Text>
      )}
      <Text> </Text>
      <Text dimColor>{'  '}Tab to switch fields, Enter to send</Text>
    </Box>
  )
}
