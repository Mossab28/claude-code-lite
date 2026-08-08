'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Locate an executable on PATH, on any platform.
 *
 * `command -v` only exists in a POSIX shell, and shelling out for this is both
 * slower and wrong on Windows. Twenty lines of PATH walking keeps the
 * dependency count at zero and the behaviour identical everywhere.
 */
function which (name) {
  const isWindows = process.platform === 'win32'
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const extensions = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext)
      try {
        const stat = fs.statSync(candidate)
        if (!stat.isFile()) continue
        if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // Not here, or not executable. Keep looking.
      }
    }
  }
  return null
}

module.exports = { which }
