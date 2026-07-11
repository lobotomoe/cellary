/** Device info view -- IMEI, firmware, SIM details */

import type { DeviceInfo as DeviceInfoData, SimInfo } from 'cellary'
import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import type { DeviceHandle } from '../../../backend/types.js'

interface DeviceInfoProps {
  readonly handle: DeviceHandle
}

function Row({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}): React.JSX.Element {
  return (
    <Text>
      <Text dimColor>{label.padEnd(16)}</Text>
      <Text>{value}</Text>
    </Text>
  )
}

interface DeviceInfoState {
  readonly data?: DeviceInfoData | undefined
  readonly error?: string | undefined
}

function useDeviceInfo(handle: DeviceHandle): DeviceInfoState {
  const [state, setState] = useState<DeviceInfoState>({})

  useEffect(() => {
    let active = true
    handle.device
      .info()
      .then((data) => {
        if (active) setState({ data })
      })
      .catch((err: unknown) => {
        if (active) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          setState({ error: message })
        }
      })
    return () => {
      active = false
    }
  }, [handle])

  return state
}

interface SimInfoState {
  readonly data?: SimInfo | undefined
  readonly error?: string | undefined
}

function useSimInfo(handle: DeviceHandle): SimInfoState {
  const [state, setState] = useState<SimInfoState>({})

  useEffect(() => {
    let active = true
    handle.sim
      .info()
      .then((data) => {
        if (active) setState({ data })
      })
      .catch((err: unknown) => {
        if (active) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          setState({ error: message })
        }
      })
    return () => {
      active = false
    }
  }, [handle])

  return state
}

export function DeviceInfoView({ handle }: DeviceInfoProps): React.JSX.Element {
  const { data: device, error } = useDeviceInfo(handle)
  const sim = useSimInfo(handle)
  const modelName = handle.model?.name

  if (error !== undefined) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color="red">Failed to load device info</Text>
        <Text dimColor>{error}</Text>
      </Box>
    )
  }

  if (device === undefined) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading device info...</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor> Menu {'>'} </Text>
        <Text bold>Device</Text>
      </Text>
      <Text> </Text>
      {modelName !== undefined && <Row label="  Model" value={modelName} />}
      <Row label="  Manufacturer" value={device.manufacturer ?? 'Unknown'} />
      {device.revision !== undefined && <Row label="  Revision" value={device.revision} />}
      {device.imei !== undefined && <Row label="  IMEI" value={device.imei} />}

      {sim.data !== undefined && (
        <>
          <Text> </Text>
          <Text bold> SIM</Text>
          <Text> </Text>
          {sim.data.imsi !== undefined && <Row label="  IMSI" value={sim.data.imsi} />}
          {sim.data.iccid !== undefined && <Row label="  ICCID" value={sim.data.iccid} />}
          <Row label="  State" value={sim.data.state} />
        </>
      )}
      {sim.error !== undefined && (
        <>
          <Text> </Text>
          <Text bold> SIM</Text>
          <Text> </Text>
          <Text dimColor> {sim.error}</Text>
        </>
      )}

      <Text> </Text>
      <Text dimColor> Protocols: {handle.protocols.join(', ')}</Text>
    </Box>
  )
}
