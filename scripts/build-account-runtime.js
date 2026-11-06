const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const target = path.join(root, 'functions/heisino-account/runtime')
fs.mkdirSync(path.join(target, 'core'), { recursive: true })
for (const name of ['game-engine', 'combat', 'constants', 'rng', 'inventory']) {
  fs.copyFileSync(path.join(root, `client/js/core/${name}.js`), path.join(target, `core/${name}.js`))
}
fs.copyFileSync(path.join(root, 'data/cards.json'), path.join(target, 'cards.json'))
console.log('Built account function runtime from shared rules and card catalog.')
