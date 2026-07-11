/** Right panel: view router based on navigation stack */

import { Text } from 'ink'
import type { DeviceHandle } from '../../backend/types.js'
import type { MessageStore } from '../../storage/types.js'
import type { LogEntry } from './monitor-types.js'
import type { Navigation } from './use-navigation.js'
import { AtConsole } from './views/at-console.js'
import { DataStatusView } from './views/data-status.js'
import { DeviceInfoView } from './views/device-info.js'
import { DiagnosticsView } from './views/diagnostics.js'
import { MainMenu } from './views/main-menu.js'
import { NetworkMenu } from './views/network-menu.js'
import { SignalDetail } from './views/signal-detail.js'
import { SmsCompose, SmsInbox, SmsMenu, SmsRead } from './views/sms-menu.js'
import { StkView } from './views/stk.js'
import { UssdPrompt } from './views/ussd-prompt.js'

interface RightPanelProps {
  readonly handle: DeviceHandle
  readonly nav: Navigation
  readonly onLog: (entry: LogEntry) => void
  readonly onStartCall?: ((number: string) => void) | undefined
  readonly store: MessageStore
}

export function RightPanel({
  handle,
  nav,
  onLog,
  onStartCall: _onStartCall,
  store,
}: RightPanelProps): React.JSX.Element {
  const { id: viewId, params } = nav.current

  switch (viewId) {
    case 'main-menu':
      return <MainMenu active onNavigate={(view) => nav.push(view)} />

    case 'sms-menu':
      return <SmsMenu active onNavigate={(view) => nav.push(view)} />

    case 'sms-inbox':
      return (
        <SmsInbox
          handle={handle}
          store={store}
          active
          onReadMessage={(index) => nav.push('sms-read', { smsIndex: index })}
        />
      )

    case 'sms-compose':
      return <SmsCompose handle={handle} active onBack={() => nav.pop()} />

    case 'sms-read':
      return (
        <SmsRead
          handle={handle}
          store={store}
          messageIndex={params?.smsIndex ?? 0}
          active
          onDeleted={() => nav.pop()}
        />
      )

    case 'signal-detail':
      return <SignalDetail handle={handle} />

    case 'ussd-prompt':
      return <UssdPrompt handle={handle} active onLog={onLog} />

    case 'network-menu':
      return <NetworkMenu handle={handle} active onLog={onLog} />

    case 'data-status':
      return <DataStatusView handle={handle} />

    case 'device-info':
      return <DeviceInfoView handle={handle} />

    case 'diagnostics':
      return <DiagnosticsView handle={handle} />

    case 'stk':
      return <StkView handle={handle} active />

    case 'at-console':
      return <AtConsole handle={handle} active />

    default:
      return <Text dimColor>Unknown view</Text>
  }
}
