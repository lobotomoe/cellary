/** Contextual footer with dynamic keybindings */

import { Box, Text } from 'ink'
import type { LayoutMode } from './monitor-types.js'
import type { ViewId } from './navigation.js'

interface Keybinding {
  readonly key: string
  readonly label: string
}

const KEYBINDINGS: Record<ViewId, readonly Keybinding[]> = {
  activity: [
    { key: 'Enter', label: 'menu' },
    { key: 'Tab', label: 'raw log' },
    { key: 'q', label: 'quit' },
  ],
  'main-menu': [
    { key: 'j/k', label: 'navigate' },
    { key: 'Enter', label: 'select' },
    { key: 'Tab', label: 'raw log' },
    { key: 'q', label: 'quit' },
  ],
  'sms-menu': [
    { key: 'j/k', label: 'navigate' },
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
  ],
  'sms-inbox': [
    { key: 'j/k', label: 'navigate' },
    { key: 'Enter', label: 'read' },
    { key: 'a', label: 'archive' },
    { key: 'd', label: 'delete' },
    { key: 'Esc', label: 'back' },
  ],
  'sms-compose': [
    { key: 'Enter', label: 'send' },
    { key: 'Esc', label: 'cancel' },
  ],
  'sms-read': [
    { key: 'a', label: 'archive' },
    { key: 'd', label: 'delete' },
    { key: 'Esc', label: 'back' },
  ],
  'signal-detail': [{ key: 'Esc', label: 'back' }],
  'ussd-prompt': [
    { key: 'Enter', label: 'send' },
    { key: 'Esc', label: 'back' },
  ],
  'network-menu': [
    { key: 'j/k', label: 'navigate' },
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
  ],
  'data-status': [{ key: 'Esc', label: 'back' }],
  'device-info': [{ key: 'Esc', label: 'back' }],
  stk: [
    { key: 'j/k', label: 'navigate' },
    { key: 'Enter', label: 'select' },
    { key: 'Esc', label: 'back' },
  ],
  diagnostics: [{ key: 'Esc', label: 'back' }],
  'at-console': [
    { key: 'Enter', label: 'execute' },
    { key: 'Esc', label: 'back' },
  ],
}

/** Overrides for normal mode: main-menu gets Tab for switching panels */
const NORMAL_MAIN_MENU: readonly Keybinding[] = [
  { key: 'j/k', label: 'navigate' },
  { key: 'Enter', label: 'select' },
  { key: 'Tab', label: 'activity' },
  { key: 'q', label: 'quit' },
]

const NORMAL_ACTIVITY: readonly Keybinding[] = [
  { key: 'Tab', label: 'menu' },
  { key: 'q', label: 'quit' },
]

/** Narrow mode: when inside menu, no Tab available */
const NARROW_MENU: readonly Keybinding[] = [
  { key: 'j/k', label: 'navigate' },
  { key: 'Enter', label: 'select' },
  { key: 'Esc', label: 'back' },
]

interface FooterProps {
  readonly currentView: ViewId
  readonly confirmingExit?: boolean | undefined
  readonly layout?: LayoutMode | undefined
  readonly showPanel?: boolean | undefined
}

export function Footer({
  currentView,
  confirmingExit,
  layout,
  showPanel,
}: FooterProps): React.JSX.Element {
  let bindings: readonly Keybinding[]

  if (layout === 'narrow' && currentView !== 'activity') {
    // Inside menu in narrow mode: use view bindings but replace Tab (not functional here)
    const viewBindings = KEYBINDINGS[currentView] ?? NARROW_MENU
    bindings = viewBindings.filter((b) => b.key !== 'Tab')
  } else if (layout === 'normal') {
    if (!showPanel || currentView === 'activity') {
      bindings = NORMAL_ACTIVITY
    } else if (currentView === 'main-menu') {
      bindings = NORMAL_MAIN_MENU
    } else {
      bindings = KEYBINDINGS[currentView] ?? KEYBINDINGS['main-menu']
    }
  } else {
    bindings = KEYBINDINGS[currentView] ?? KEYBINDINGS['main-menu']
  }

  return (
    <Box
      paddingX={1}
      paddingBottom={1}
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      {confirmingExit ? (
        <Text wrap="truncate">
          <Text color="yellow" bold>
            Quit?
          </Text>
          {'  '}
          <Text bold color="cyan">
            y
          </Text>
          <Text dimColor> yes</Text>
          {'  '}
          <Text bold color="cyan">
            n
          </Text>
          <Text dimColor> no</Text>
        </Text>
      ) : (
        <Text wrap="truncate">
          {bindings.map((binding, i) => (
            <Text key={binding.key}>
              {i > 0 && ' '}
              <Text bold color="cyan">
                {binding.key}
              </Text>
              <Text dimColor>{` ${binding.label}`}</Text>
            </Text>
          ))}
        </Text>
      )}
    </Box>
  )
}
