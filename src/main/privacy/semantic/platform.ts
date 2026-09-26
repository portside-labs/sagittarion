// Where the on-device model can run: the platforms onnxruntime-node ships binaries for, with the system versions
// those binaries need (checked with otool, the DLL import tables and the glibc symbols of 1.30.0).
import os from 'node:os'

export interface PlatformInfo {
  platform: NodeJS.Platform
  arch: string
  /** os.release(): the Darwin kernel version on macOS. */
  release: string
  /** glibc version on Linux; undefined on other C libraries. */
  glibc?: string
}

function glibc(): string | undefined {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  return report?.header?.glibcVersionRuntime
}

export function currentPlatform(): PlatformInfo {
  return { platform: process.platform, arch: process.arch, release: os.release(), glibc: process.platform === 'linux' ? glibc() : undefined }
}

const atLeast = (version: string | undefined, major: number, minor = 0) => {
  const [a, b] = (version ?? '').split('.').map(Number)
  return Number.isFinite(a) && (a > major || (a === major && (b || 0) >= minor))
}

/** Null when the model can run here; otherwise why not, for Settings. */
export function unsupportedReason(p: PlatformInfo = currentPlatform()): string | null {
  switch (p.platform) {
    case 'darwin':
      // macOS 14 is Darwin 23.
      return p.arch === 'arm64' && atLeast(p.release, 23) ? null : 'The on-device model needs a Mac with Apple silicon and macOS 14 or later.'
    case 'win32':
      return p.arch === 'x64' || p.arch === 'arm64' ? null : 'The on-device model needs 64-bit Windows.'
    case 'linux':
      return (p.arch === 'x64' || p.arch === 'arm64') && atLeast(p.glibc, 2, 28) ? null : 'The on-device model needs 64-bit Linux with glibc 2.28 or later.'
    default:
      return 'The on-device model is not available on this system.'
  }
}
