import { Box, render, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import type { DeviceHandle } from '../../backend/types.js'
import type { MessageStore } from '../../storage/types.js'
import { ActivityFeed } from './activity-feed.js'
import { CallStatus } from './call-status.js'
import { EventLog } from './event-log.js'
import { Footer } from './footer.js'
import {
  createTimestamp,
  useAutoHangup,
  useCallPoller,
  useCallState,
  useConnectionState,
  useModemEvents,
} from './hooks.js'
import type { LayoutMode, LogEntry } from './monitor-types.js'
import { RightPanel } from './right-panel.js'
import { StatusBar } from './status-bar.js'
import { useNavigation } from './use-navigation.js'

interface MonitorOptions {
  readonly verbose: boolean
  readonly backendMode: 'direct' | 'remote'
}

// ── Terminal size tracking ──────────────────────────────────────────────────

interface TerminalSize {
  readonly cols: number
  readonly rows: number
}

function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>({
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  })

  useEffect(() => {
    const onResize = (): void =>
      setSize({ cols: process.stdout.columns, rows: process.stdout.rows })
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])

  return size
}

// ── Layout breakpoints ──────────────────────────────────────────────────────

const NARROW_BREAKPOINT = 60
const WIDE_BREAKPOINT = 100

function getLayoutMode(cols: number): LayoutMode {
  if (cols < NARROW_BREAKPOINT) return 'narrow'
  if (cols < WIDE_BREAKPOINT) return 'normal'
  return 'wide'
}

// ── Content area layouts ────────────────────────────────────────────────────

/**
 * Wide layout: two columns side by side.
 * Left = activity feed, Right = navigation panel or raw log.
 */
function WideContent({
  entries,
  showRawLog,
  handle,
  nav,
  addEntry,
  startCall,
  store,
}: {
  readonly entries: readonly LogEntry[]
  readonly showRawLog: boolean
  readonly handle: DeviceHandle
  readonly nav: ReturnType<typeof useNavigation>
  readonly addEntry: (entry: LogEntry) => void
  readonly startCall: (number: string) => void
  readonly store: MessageStore
}): React.JSX.Element {
  return (
    <Box flexGrow={1} flexDirection="row">
      <Box flexDirection="column" flexGrow={1} flexBasis={0} borderStyle="single" borderRight>
        <ActivityFeed entries={entries} />
      </Box>
      <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingX={1}>
        {showRawLog ? (
          <EventLog entries={entries} />
        ) : (
          <RightPanel
            handle={handle}
            nav={nav}
            onLog={addEntry}
            onStartCall={startCall}
            store={store}
          />
        )}
      </Box>
    </Box>
  )
}

/**
 * Normal layout: single column, Tab toggles between activity feed and menu.
 */
function NormalContent({
  entries,
  showPanel,
  showRawLog,
  handle,
  nav,
  addEntry,
  startCall,
  store,
}: {
  readonly entries: readonly LogEntry[]
  readonly showPanel: boolean
  readonly showRawLog: boolean
  readonly handle: DeviceHandle
  readonly nav: ReturnType<typeof useNavigation>
  readonly addEntry: (entry: LogEntry) => void
  readonly startCall: (number: string) => void
  readonly store: MessageStore
}): React.JSX.Element {
  if (!showPanel) {
    return (
      <Box flexGrow={1} flexDirection="column" paddingX={1}>
        <ActivityFeed entries={entries} />
      </Box>
    )
  }

  return (
    <Box flexGrow={1} flexDirection="column" paddingX={1}>
      {showRawLog ? (
        <EventLog entries={entries} />
      ) : (
        <RightPanel
          handle={handle}
          nav={nav}
          onLog={addEntry}
          onStartCall={startCall}
          store={store}
        />
      )}
    </Box>
  )
}

/**
 * Narrow layout: single full-width screen.
 * Home = activity feed. Enter/m pushes into menu navigation.
 * When nav depth > 1, show the current view instead of activity feed.
 */
function NarrowContent({
  entries,
  showRawLog,
  inMenu,
  handle,
  nav,
  addEntry,
  startCall,
  store,
}: {
  readonly entries: readonly LogEntry[]
  readonly showRawLog: boolean
  readonly inMenu: boolean
  readonly handle: DeviceHandle
  readonly nav: ReturnType<typeof useNavigation>
  readonly addEntry: (entry: LogEntry) => void
  readonly startCall: (number: string) => void
  readonly store: MessageStore
}): React.JSX.Element {
  if (!inMenu) {
    return (
      <Box flexGrow={1} flexDirection="column" paddingX={1}>
        {showRawLog ? <EventLog entries={entries} /> : <ActivityFeed entries={entries} />}
      </Box>
    )
  }

  return (
    <Box flexGrow={1} flexDirection="column" paddingX={1}>
      <RightPanel
        handle={handle}
        nav={nav}
        onLog={addEntry}
        onStartCall={startCall}
        store={store}
      />
    </Box>
  )
}

// ── App ─────────────────────────────────────────────────────────────────────

function App({
  handle,
  verbose,
  store,
  backendMode,
}: {
  readonly handle: DeviceHandle
  readonly verbose: boolean
  readonly store: MessageStore
  readonly backendMode: 'direct' | 'remote'
}): React.JSX.Element {
  const connection = useConnectionState(handle)
  const { entries, addEntry } = useModemEvents(handle)
  const { callState, startCall, resetCall } = useCallState(handle, addEntry)
  useAutoHangup(handle, callState, addEntry, resetCall)
  useCallPoller(handle, callState, addEntry, resetCall)
  const nav = useNavigation()
  const { exit } = useApp()
  const [showRawLog, setShowRawLog] = useState(false)
  const [showPanel, setShowPanel] = useState(true)
  const [confirmingExit, setConfirmingExit] = useState(false)

  const { cols, rows } = useTerminalSize()
  const mode = getLayoutMode(cols)

  // In narrow mode, nav depth > 1 means we're in the menu system
  const narrowInMenu = mode === 'narrow' && nav.depth > 1

  // Persist log entries to SQLite
  useEffect(() => {
    if (entries.length === 0) return
    const last = entries[entries.length - 1]
    if (last !== undefined) {
      store.appendLog({ timestamp: last.timestamp, type: last.type, message: last.message })
    }
  }, [entries, store])

  // Global input handling
  useInput((input, key) => {
    // Exit confirmation dialog
    if (confirmingExit) {
      if (input === 'y' || input === 'Y') {
        exit()
      } else {
        setConfirmingExit(false)
      }
      return
    }

    // Call shortcuts: 'a' to answer, 'h' to hangup
    const onHomeScreen = mode === 'narrow' ? !narrowInMenu : nav.current.id === 'main-menu'

    if (callState.active && onHomeScreen) {
      if (input === 'a' && callState.direction === 'incoming') {
        handle.voice.answer().catch(() => {})
        addEntry({ timestamp: createTimestamp(), type: 'call', message: 'Answered call' })
        return
      }
      if (input === 'h') {
        handle.voice.hangup().catch(() => {})
        addEntry({ timestamp: createTimestamp(), type: 'call', message: 'Hung up' })
        resetCall()
        return
      }
    }

    // Ctrl+C or q -> ask for confirmation (from any navigation depth).
    // The y/n confirmation dialog prevents accidental exits.
    if ((key.ctrl && input === 'c') || input === 'q') {
      setConfirmingExit(true)
      return
    }

    // Narrow mode: Enter or 'm' on home screen -> push into menu
    if (mode === 'narrow' && !narrowInMenu) {
      if (key.return || input === 'm') {
        nav.push('main-menu')
        return
      }
      // Tab toggles raw log on narrow home screen
      if (key.tab) {
        setShowRawLog((prev) => !prev)
        return
      }
    }

    // Normal mode: Tab toggles between activity feed and menu panel
    if (mode === 'normal') {
      if (key.tab) {
        setShowPanel((prev) => !prev)
        return
      }
    }

    // Wide mode: Tab toggles raw log (existing behavior)
    if (mode === 'wide' && key.tab && nav.current.id === 'main-menu') {
      setShowRawLog((prev) => !prev)
      return
    }

    // Escape: go back
    if (key.escape) {
      if (showRawLog) {
        setShowRawLog(false)
        return
      }
      // In normal mode, if panel is showing and we're at main-menu, switch back to activity
      if (mode === 'normal' && showPanel && nav.current.id === 'main-menu') {
        setShowPanel(false)
        return
      }
      nav.pop()
      return
    }
  })

  // Determine footer context
  const footerView = mode === 'narrow' && !narrowInMenu ? 'activity' : nav.current.id

  return (
    <Box flexDirection="column" height={rows}>
      <StatusBar
        handle={handle}
        verbose={verbose}
        connection={connection}
        compact={mode === 'narrow'}
        backendMode={backendMode}
      />

      <CallStatus callState={callState} />

      {mode === 'wide' && (
        <WideContent
          entries={entries}
          showRawLog={showRawLog}
          handle={handle}
          nav={nav}
          addEntry={addEntry}
          startCall={startCall}
          store={store}
        />
      )}

      {mode === 'normal' && (
        <NormalContent
          entries={entries}
          showPanel={showPanel}
          showRawLog={showRawLog}
          handle={handle}
          nav={nav}
          addEntry={addEntry}
          startCall={startCall}
          store={store}
        />
      )}

      {mode === 'narrow' && (
        <NarrowContent
          entries={entries}
          showRawLog={showRawLog}
          inMenu={narrowInMenu}
          handle={handle}
          nav={nav}
          addEntry={addEntry}
          startCall={startCall}
          store={store}
        />
      )}

      <Footer
        currentView={footerView}
        confirmingExit={confirmingExit}
        layout={mode}
        showPanel={showPanel}
      />
    </Box>
  )
}

// Alternate screen buffer: takes over the full terminal, restores on exit.
// Same behavior as vim, htop, less — previous terminal content restored on quit.
const ALT_SCREEN_ENTER = '\x1b[?1049h'
const ALT_SCREEN_LEAVE = '\x1b[?1049l'

export async function renderMonitor(handle: DeviceHandle, options: MonitorOptions): Promise<void> {
  const { openStore } = await import('../../storage/sqlite.js')
  const store = openStore()

  process.stdout.write(ALT_SCREEN_ENTER)

  const instance = render(
    <App
      handle={handle}
      verbose={options.verbose}
      store={store}
      backendMode={options.backendMode}
    />,
    {
      exitOnCtrlC: false,
    },
  )
  await instance.waitUntilExit()

  process.stdout.write(ALT_SCREEN_LEAVE)
  store.close()
}
