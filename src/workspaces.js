import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export async function canonicalRoot(path) {
  const resolved = resolve(path)
  await mkdir(resolved, { recursive: true })
  return realpath(resolved)
}

export async function resolveInside(root, requested) {
  if (await realpath(root) !== root) throw new Error('configured root changed through a symlink')
  if (typeof requested !== 'string' || !requested || isAbsolute(requested)) throw new Error('path must be relative to its configured root')
  const normalized = requested.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '..' || part === '')) throw new Error('path traversal is not allowed')
  const candidate = resolve(root, normalized)
  const rel = relative(root, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path is outside configured root')
  let cursor = candidate
  while (cursor !== root) {
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink()) {
        const actual = await realpath(cursor)
        const escape = relative(root, actual)
        if (escape === '..' || escape.startsWith(`..${sep}`) || isAbsolute(escape)) throw new Error('symlink escapes configured root')
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    cursor = resolve(cursor, '..')
  }
  return candidate
}
