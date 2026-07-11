/** Root menu for the right panel */

import { Box, Text } from 'ink'
import type { MenuItem, ViewId } from '../navigation.js'
import { useMenu } from '../use-menu.js'

const MENU_ITEMS: readonly (MenuItem & { readonly view: ViewId })[] = [
  { id: 'sms', label: 'SMS', hint: 'messages', view: 'sms-menu' },
  { id: 'signal', label: 'Signal', hint: 'detailed metrics', view: 'signal-detail' },
  { id: 'ussd', label: 'USSD', hint: 'send codes', view: 'ussd-prompt' },
  { id: 'network', label: 'Network', hint: 'operator, scan', view: 'network-menu' },
  { id: 'data', label: 'Data', hint: 'connection, APN', view: 'data-status' },
  { id: 'device', label: 'Device', hint: 'IMEI, firmware', view: 'device-info' },
  { id: 'stk', label: 'SIM Toolkit', hint: 'SIM applications', view: 'stk' },
  { id: 'diagnostics', label: 'Diagnostics', hint: 'service routing', view: 'diagnostics' },
  { id: 'at', label: 'AT Console', hint: 'raw commands', view: 'at-console' },
]

interface MainMenuProps {
  readonly active: boolean
  readonly onNavigate: (view: ViewId) => void
}

export function MainMenu({ active, onNavigate }: MainMenuProps): React.JSX.Element {
  const { selectedIndex } = useMenu({
    itemCount: MENU_ITEMS.length,
    onSelect: (i) => {
      const item = MENU_ITEMS[i]
      if (item !== undefined) onNavigate(item.view)
    },
    active,
  })

  return (
    <Box flexDirection="column">
      {MENU_ITEMS.map((item, i) => {
        const selected = i === selectedIndex
        return (
          <Text key={item.id}>
            <Text {...(selected ? { color: 'cyan', bold: true } : {})}>
              {selected ? '> ' : '  '}
              {item.label}
            </Text>
            {item.hint !== undefined && <Text dimColor>{`  ${item.hint}`}</Text>}
          </Text>
        )
      })}
    </Box>
  )
}
