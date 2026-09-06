/**
 * Host-side audit persistence, published as the `@cellary/daemon/audit`
 * subpath so the CLI's direct backend records device comms with the same
 * durable sink and directory layout the daemon uses.
 */

export { AUDIT_FILE_NAME, type AuditPathEnv, resolveAuditFile } from './audit-config.js'
export { FileAuditSink, type FileAuditSinkOptions } from './audit-sink.js'
