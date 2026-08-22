/** Whether this renderer is paired with a host that can keep workflow files
 * and run journals in the vault. Remote workspaces (desktop or web) follow
 * the connected server's advertised capability: the Electron bridge delegates
 * workflow calls to the server's journalled API (#618), and older servers
 * without it stay read-only. */
export function canManageWorkflows(
  runtime: 'desktop' | 'web',
  workspaceMode: 'local' | 'remote',
  capabilities: { supportsWorkflows?: boolean }
): boolean {
  if (workspaceMode === 'remote') return capabilities.supportsWorkflows === true
  return runtime === 'desktop' || capabilities.supportsWorkflows === true
}
