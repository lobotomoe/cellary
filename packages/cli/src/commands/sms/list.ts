import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'
import { formatTable } from '../../lib/format.js'

/** Status filter values matching core API */
const SMS_STATUSES = ['all', 'unread', 'read', 'sent', 'unsent'] as const

type SmsStatus = (typeof SMS_STATUSES)[number]

function isSmsStatus(value: string): value is SmsStatus {
  return SMS_STATUSES.some((s) => s === value)
}

export default defineCommand({
  meta: {
    name: 'list',
    description: 'List SMS messages',
  },
  args: {
    status: {
      type: 'string',
      alias: 's',
      description: 'Filter by status: all, unread, read, sent, unsent (default: all)',
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      const statusFilter = args.status ?? 'all'
      if (!isSmsStatus(statusFilter)) {
        throw new Error(
          `Invalid status "${statusFilter}". Valid values: ${SMS_STATUSES.join(', ')}`,
        )
      }

      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const messages = await handle.sms.list(statusFilter)

        if (messages.length === 0) {
          process.stdout.write('No messages.\n')
          return
        }

        // Peer = sender for incoming, recipient for outgoing (status conveys which).
        const headers = ['#', 'Status', 'Peer', 'Date', 'Text']
        const rows = messages.map((m) => [
          String(m.index),
          m.status,
          m.address,
          formatTimestamp(m.timestamp),
          truncate(m.text, 40),
        ])

        process.stdout.write(formatTable(headers, rows))
        process.stdout.write('\n')
      })
    })
  },
})

function formatTimestamp(date: Date | undefined): string {
  if (date === undefined) return '-'
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${d} ${h}:${mi}`
}

const MAX_TRUNCATED_LENGTH = 37

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, MAX_TRUNCATED_LENGTH)}...`
}
