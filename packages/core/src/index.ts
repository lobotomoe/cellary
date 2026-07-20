// ── Public API ────────────────────────────────────────────────────────────────

export { type AuditRecord, type AuditSink, noopAuditSink } from './audit.js'
export { type Logger, noopLogger } from './logger.js'
export {
  type ConnectOptions,
  DEFAULT_RESOLVERS,
  DEFAULT_VENDORS,
  Modem,
  type ModemOptions,
} from './modem.js'

// ── Transport ────────────────────────────────────────────────────────────────

export { EcmTransport, type EcmTransportOptions } from './transport/ecm/index.js'
export { MockTransport } from './transport/mock.js'
export { SerialTransport, type SerialTransportOptions } from './transport/serial.js'
export { UsbTransport, type UsbTransportOptions } from './transport/usb.js'
export type { UsbNetTransport } from './transport/usb-net.js'

// ── AT Protocol (channel, services, profile) ────────────────────────────────

export { ATChannel, type ATChannelOptions } from './protocols/at/channel/at-channel.js'
export { LineAssembler, type LineAssemblerEvents } from './protocols/at/channel/line-assembler.js'
export { parseLine } from './protocols/at/channel/parser.js'
export { genericProfile } from './protocols/at/profile.js'
export { CapabilitiesModule } from './protocols/at/services/capabilities.js'
export { DataModule } from './protocols/at/services/data.js'
export { DeviceModule } from './protocols/at/services/device.js'
export { NetworkModule } from './protocols/at/services/network.js'
export { PhonebookModule } from './protocols/at/services/phonebook.js'
export { RadioModule } from './protocols/at/services/radio.js'
export { SimModule } from './protocols/at/services/sim.js'
export { SmsModule } from './protocols/at/services/sms/index.js'
export { StkModule } from './protocols/at/services/stk/index.js'
export { TrafficModule } from './protocols/at/services/traffic.js'
export { UssdModule } from './protocols/at/services/ussd.js'
export { VoiceModule } from './protocols/at/services/voice.js'
export type {
  ATCommand,
  ATCommandResult,
  ATResultCode,
  ParsedLine,
  ParserContext,
  URC,
  URCHandler,
} from './protocols/at/types.js'

// ── Discovery ───────────────────────────────────────────────────────────────

export {
  DeviceObserver,
  type DeviceObserverEvents,
  type DeviceObserverOptions,
  type DeviceSessionSnapshot,
  type DeviceSeverity,
  type DeviceStateAnalysis,
  type DeviceStateResolver,
  type DiscoveredModem,
  discover,
  findModemEntry,
  findProductConfig,
  type IdentifiedDevice,
  type IdentifyOptions,
  identify,
  identifyAll,
  isModemProduct,
  type ModemWatchEvent,
  type ModeSwitchResult,
  type ProductTransport,
  type ProvisionResult,
  provision,
  registerModeswitchHelper,
  type ScsiCbwSwitch,
  type SwitchMethod,
  scanUsb,
  switchDevice,
  USB_MODEM_DATABASE,
  type UsbCycle,
  type UsbInterfaceInfo,
  type UsbModemEntry,
  type UsbProductConfig,
  type VendorControlSwitch,
  watch,
} from './discovery/index.js'

// ── Preparation ─────────────────────────────────────────────────────────────

export {
  applyRemediations,
  DEFAULT_REMEDIATION_POLICY,
  genericPrepProfile,
  type HealthCheck,
  type Limitation,
  type PrepProfile,
  type PrepReport,
  type Recoverability,
  type Remediation,
  type RemediationContext,
  type RemediationOutcome,
  type RemediationPolicy,
  type RemediationRecord,
  registrationCheck,
  resolveProfile,
  runHealthChecks,
  runPreparation,
  type StepKind,
  type StepOutcome,
  type StepRecord,
  simCheck,
} from './preparation/index.js'

// ── Lifecycle ───────────────────────────────────────────────────────────────

export {
  type ComposedStateGraph,
  compose,
  createProbe,
  type DetectionConfidence,
  type DetectionResult,
  DeviceLifecycle,
  type DeviceLifecycleOptions,
  type DeviceProbe,
  detectState,
  findBestTarget,
  findPath,
  GENERIC_DETECTORS,
  GENERIC_LAYER,
  isRefinementOf,
  type LifecycleDefinition,
  type NavigateOptions,
  type NavigationProgress,
  type NavigationResult,
  navigate,
  type PathResult,
  type ProbeFactory,
  probeFromDiscovered,
  type StateDetector,
  type StateEdge,
  type StateGraphLayer,
  type StateNode,
  type StateSeverity,
  type TransitionAction,
  type TransitionContext,
  type UsbInterfaceDescriptor,
} from './lifecycle/index.js'

// ── Firmware ────────────────────────────────────────────────────────────────

export type {
  FirmwareInfo,
  Flasher,
  FlasherOptions,
  FlashPhase,
  FlashProgress,
  FlashResult,
} from './firmware.js'

// ── Protocol adapters ────────────────────────────────────────────────────────

export type {
  ActiveCall,
  CallWaitingStatus,
  Capabilities,
  CpuFrequency,
  Data,
  Device,
  InteractiveStream,
  Network,
  Phonebook,
  ProtocolAdapter,
  Radio,
  ServiceCapability,
  ServiceName,
  ServiceRouteInfo,
  Sim,
  Sms,
  Stk,
  System,
  Thermal,
  ThermalReading,
  Traffic,
  Ussd,
  VendorEvent,
  VendorPlugin,
  VendorProbe,
  Voice,
} from './protocols/adapter.js'
export { AtAdapter, isAtAdapter } from './protocols/at/index.js'

// ── ADB Protocol ─────────────────────────────────────────────────────────────

export type {
  AdbAdapterOptions,
  AdbAtBridge,
  DeviceUnlocker,
  ImeiProvider,
  ShellResult,
} from './protocols/adb/index.js'
export {
  ADB_DEFAULT_PORT,
  AdbAdapter,
  AdbConnection,
  AdbShell,
  connectAdbOverUsb,
  probeAdb,
} from './protocols/adb/index.js'

// ── Vendors ──────────────────────────────────────────────────────────────────

export {
  BALONG_DETECTORS,
  BALONG_LAYER,
  createHuaweiLifecycle,
  E3372_DETECTORS,
  E3372_LAYER,
  E8372_DETECTORS,
  E8372_LAYER,
  HiLinkAdapter,
  HUAWEI_DETECTORS,
  HUAWEI_LAYER,
  HUAWEI_PID_COUNT,
  type HuaweiLifecycleOptions,
  type HuaweiPidInfo,
  hasEcmCapability,
  huaweiE3372,
  huaweiE8372,
  huaweiLifecycle,
  huaweiPlugin,
  huaweiProfile,
  huaweiResolver,
  isKnownHuaweiModemPid,
  lookupHuaweiPid,
} from './vendor/huawei/index.js'

export {
  msm8916OemPlugin,
  msm8916OemResolver,
} from './vendor/msm8916-oem/index.js'

export {
  MF656_PID_MODEM,
  MF656_PID_STORAGE,
  mf656Model,
  ZTE_VID,
  ztePlugin,
  zteProfile,
  zteResolver,
  zteUsbEntry,
} from './vendor/zte/index.js'

// ── Fleet ────────────────────────────────────────────────────────────────────

export {
  type DeviceReadiness,
  ModemPool,
  type PoolEventMap,
  type PooledDevice,
  type PoolOptions,
  type ReadyStage,
} from './fleet/index.js'

// ── Errors ───────────────────────────────────────────────────────────────────

export {
  ATError,
  CellaryError,
  ChannelDisposedError,
  ChannelUnresponsiveError,
  DiscoveryError,
  NotSupportedError,
  ParseError,
  PreparationError,
  StkError,
  TimeoutError,
  TransportError,
} from './errors.js'

// ── Data ─────────────────────────────────────────────────────────────────

export {
  isNumericPlmn,
  parseMcc,
  resolveCountry,
  resolveOperatorName,
} from './data/mcc.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type {
  AtConfig,
  AtConfigPatches,
  AvailableNetwork,
  BatteryInfo,
  BatteryStatus,
  CallEndReason,
  CallEvent,
  CallForwardingRule,
  CallForwardMode,
  CallForwardReason,
  CallState,
  CapabilityOverrides,
  ClirSetting,
  ClirStatus,
  ClockInfo,
  ConnectionProgress,
  DataCapabilities,
  DataConnectionState,
  DataConnectionStatus,
  DeviceInfo,
  DeviceProfile,
  DeviceProfilePatches,
  EDrxAccessType,
  EDrxConfig,
  EDrxDynamicParams,
  EpsQosParams,
  ExtendedErrorReport,
  FunctionalityMode,
  IndicatorChangeEvent,
  IndicatorDescriptor,
  IndicatorReport,
  ModelInfo,
  ModemCapabilities,
  ModemDriver,
  ModemEventMap,
  MoSsNotification,
  MtSsNotification,
  NetworkCapabilities,
  NumberFormat,
  OperatorNameEntry,
  PdpAuthType,
  PdpContext,
  PdpDynamicParams,
  PhoneActivityStatus,
  PhonebookEntry,
  PhonebookStorage,
  PhonebookStorageInfo,
  PinRetryInfo,
  PreferredOperator,
  PsmConfig,
  RegistrationInfo,
  RegistrationStatus,
  SignalInfo,
  SignallingConnectionMode,
  SignallingConnectionStatus,
  SimCapabilities,
  SimInfo,
  SimState,
  SimStateEvent,
  SmsCapabilities,
  SmsCount,
  SmsMessage,
  SmsNotification,
  SsNotificationEvent,
  StkCapabilities,
  TrafficStats,
  Transport,
  TransportConfig,
  UeOperationMode,
  UnsolicitedMessage,
  UssdCapabilities,
  VoiceCapabilities,
  WirelessServiceMode,
} from './types.js'

// ── STK Types ──────────────────────────────────────────────────────────────

export type {
  StkCommandTypes,
  StkConfig,
  StkResponseCodes,
} from './protocols/at/types.js'
export type {
  StkEventMap,
  StkInkeyPrompt,
  StkInputPrompt,
  StkMenu,
  StkMenuItem,
  StkNotification,
  StkProactiveEvent,
  StkText,
} from './stk-types.js'
export { huaweiStkConfig } from './vendor/huawei/stk-config.js'
