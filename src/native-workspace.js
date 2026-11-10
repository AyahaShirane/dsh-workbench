/** Register an existing Session's canonical CWD and account its native identity. */
export async function accountNativeSession(ctx, path, sessionId) {
  const controller=ctx.get('workspaceController')
  if(!controller?.create) return false
  const {workspace}=await controller.create({path})
  const registry=ctx.get('workspaceRegistry')
  if(!registry?.get) throw Error('native Workspace registry is unavailable')
  const entity=registry.get(workspace.workspaceId)
  if(!entity?.attachSession) throw Error('native Workspace entity cannot account Sessions')
  await entity.attachSession(sessionId)
  return workspace
}
