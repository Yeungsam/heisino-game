const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'runtime'].includes(entry.name)) continue
    const name = path.join(directory, entry.name)
    if (entry.isDirectory()) visit(name)
    else if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', name], { stdio: 'inherit' })
  }
}
for (const directory of ['client', 'server', 'functions', 'scripts']) visit(path.join(root, directory))
