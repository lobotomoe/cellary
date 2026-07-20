/**
 * Per-method authorization for the daemon IPC surface.
 *
 * The socket is gid-gated (DMN-C1), but within that group every method was
 * equally callable -- including system.shell and the interactive shell stream,
 * which are arbitrary command execution on the device. This adds a capability
 * gate so the most dangerous methods are refused unless the operator explicitly
 * enables them, turning a flat "any group member can do anything" into defense
 * in depth: a too-permissive socket no longer implies device RCE.
 */

import type { RpcMethod } from './ipc/protocol.js'

export interface AuthzPolicy {
  /** Allow arbitrary shell access: system.shell and the interactive shell stream. */
  readonly allowShell: boolean
}

export class MethodForbiddenError extends Error {
  override readonly name = 'MethodForbiddenError'
}

/**
 * Methods that grant arbitrary shell / command execution on the device.
 * `stream.open` is included because its only stream type is an interactive
 * shell (see main.ts) -- opening it is equivalent to system.shell.
 */
const SHELL_METHODS = new Set<string>(['system.shell', 'stream.open'] satisfies RpcMethod[])

/**
 * Throw MethodForbiddenError if `method` is disabled by the policy.
 *
 * Only privileged methods are restricted here; everything else passes through
 * (method existence and per-device leases are enforced downstream). Keeping the
 * gate at the dispatch boundary means a new privileged method is denied by
 * default the moment it is added to a capability set.
 */
export function assertMethodAllowed(method: string, policy: AuthzPolicy): void {
  if (!policy.allowShell && SHELL_METHODS.has(method)) {
    throw new MethodForbiddenError(
      `Method '${method}' is disabled: it grants arbitrary shell access to the device. ` +
        'Set CELLARY_ALLOW_SHELL=true on the daemon to enable it.',
    )
  }
}
