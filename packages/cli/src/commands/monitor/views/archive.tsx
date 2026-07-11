/** Archive view -- browse locally stored SMS messages */

import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { ArchivedMessage, MessageStore } from '../../../storage/types.js'
import { useMenu } from '../use-menu.js'

const PAGE_SIZE = 20

interface ArchiveViewProps {
  readonly store: MessageStore
  readonly active: boolean
}

export function ArchiveView({ store, active }: ArchiveViewProps): React.JSX.Element {
  const [selected, setSelected] = useState<ArchivedMessage | undefined>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [revision, setRevision] = useState(0)

  // Re-read on revision change (after delete)
  const messages = store.listArchived({ limit: PAGE_SIZE, offset: 0 })
  const total = store.archivedCount()
  // Force dependency on revision to re-render
  void revision

  const { selectedIndex } = useMenu({
    itemCount: messages.length,
    onSelect: (i) => {
      if (confirmDelete) return
      const msg = messages[i]
      if (msg !== undefined) setSelected(msg)
    },
    active: active && selected === undefined && !confirmDelete,
  })

  useInput(
    (input) => {
      // Reading a message -- Esc goes back to list
      if (selected !== undefined) {
        if (input === 'd') {
          setConfirmDelete(true)
        }
        return
      }

      // Confirm delete
      if (confirmDelete) {
        if (input === 'y') {
          const target = selected ?? messages[selectedIndex]
          if (target !== undefined) {
            store.deleteArchived(target.id)
            setRevision((r) => r + 1)
          }
          setConfirmDelete(false)
          setSelected(undefined)
        }
        if (input === 'n' || input === 'N') {
          setConfirmDelete(false)
        }
        return
      }

      // List view
      if (input === 'd' && messages.length > 0) {
        setConfirmDelete(true)
      }
    },
    { isActive: active },
  )

  // Handle Esc separately to close detail view
  useInput(
    (_input, key) => {
      if (key.escape && selected !== undefined) {
        if (confirmDelete) {
          setConfirmDelete(false)
        } else {
          setSelected(undefined)
        }
      }
    },
    { isActive: active && selected !== undefined },
  )

  // Detail view
  if (selected !== undefined) {
    const date = new Date(selected.timestamp)
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>
            {' '}
            SMS {'>'} Archive {'>'}{' '}
          </Text>
          <Text bold>Message</Text>
        </Text>
        <Text> </Text>
        <Text>
          <Text dimColor>{'  From:     '}</Text>
          <Text bold>{selected.from}</Text>
        </Text>
        <Text>
          <Text dimColor>{'  Date:     '}</Text>
          <Text>{date.toLocaleString()}</Text>
        </Text>
        <Text>
          <Text dimColor>{'  Storage:  '}</Text>
          <Text>{selected.storage === 'SM' ? 'SIM card' : selected.storage}</Text>
        </Text>
        <Text> </Text>
        <Text>
          {'  '}
          {selected.text}
        </Text>
        {confirmDelete && (
          <>
            <Text> </Text>
            <Text color="yellow"> Delete from archive? (y/n)</Text>
          </>
        )}
      </Box>
    )
  }

  // Empty state
  if (messages.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor> SMS {'>'} </Text>
          <Text bold>Archive</Text>
        </Text>
        <Text> </Text>
        <Text dimColor> No archived messages.</Text>
        <Text dimColor> Press 'a' on a SIM message to archive it.</Text>
      </Box>
    )
  }

  // List view
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> SMS {'>'} </Text>
        <Text bold>Archive ({total})</Text>
      </Text>
      <Text> </Text>
      {messages.map((msg, i) => {
        const isSelected = i === selectedIndex
        const preview = msg.text.length > 30 ? `${msg.text.substring(0, 30)}...` : msg.text
        return (
          <Text key={msg.id} wrap="truncate">
            <Text {...(isSelected ? { color: 'cyan', bold: true } : {})}>
              {isSelected ? '> ' : '  '}
            </Text>
            <Text {...(isSelected ? { bold: true } : {})}>{msg.from}</Text>
            <Text dimColor> {preview}</Text>
          </Text>
        )
      })}
      {confirmDelete && (
        <>
          <Text> </Text>
          <Text color="yellow">
            {'  '}Delete {messages[selectedIndex]?.from ?? '?'} from archive? (y/n)
          </Text>
        </>
      )}
    </Box>
  )
}
