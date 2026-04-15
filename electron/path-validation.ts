import path from 'path'

const isWindows = process.platform === 'win32'

function normalize(p: string): string {
  return isWindows ? path.resolve(p).toLowerCase() : path.resolve(p)
}

function stripFileUrl(fileUrl: string): string {
  try {
    const parsed = new URL(fileUrl)
    if (parsed.protocol !== 'file:') return fileUrl

    const host = parsed.hostname.toLowerCase()
    let pathname = decodeURIComponent(parsed.pathname || '')

    if (isWindows) {
      if (host && host !== 'localhost') {
        // UNC path: file://server/share/path -> \\server\share\path
        return `\\\\${host}${pathname.replace(/\//g, '\\')}`
      }
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
      return pathname.replace(/\//g, '\\')
    }

    if (host && host !== 'localhost') {
      return `//${host}${pathname}`
    }
    return pathname
  } catch {
    // Fallback for malformed URLs (keep previous behavior)
    let raw = fileUrl
    if (raw.startsWith('file:///')) raw = raw.slice(8)
    else if (raw.startsWith('file://')) raw = raw.slice(7)
    return decodeURIComponent(raw).replace(/\//g, path.sep)
  }
}

function resolveInputPath(inputPath: string): string {
  const cleaned = inputPath.startsWith('file://') ? stripFileUrl(inputPath) : inputPath
  return path.resolve(cleaned)
}

const approvedPaths = new Set<string>()

export function approvePath(filePath: string): void {
  if (!filePath) return
  approvedPaths.add(normalize(resolveInputPath(filePath)))
}

export function validatePath(inputPath: string, allowedRoots: string[]): string {
  const resolved = resolveInputPath(inputPath)
  const norm = normalize(resolved)

  for (const root of allowedRoots.map(normalize)) {
    if (norm === root || norm.startsWith(root + path.sep)) return resolved
  }

  let found = false
  approvedPaths.forEach((approved) => {
    if (norm === approved || norm.startsWith(approved + path.sep)) found = true
  })
  if (found) return resolved

  throw new Error(`Path not allowed: ${inputPath}`)
}
