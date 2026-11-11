const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const { assertActiveCardIds } = require('../client/js/core/retired-cards')
assertActiveCardIds(require('../data/cards.json').cards.map(card => card.card_id))
const target = path.join(root, 'functions/heisino-account/runtime')
fs.mkdirSync(path.join(target, 'core'), { recursive: true })
for (const name of ['game-engine', 'combat', 'constants', 'rng', 'inventory', 'room-map', 'room-loot', 'retired-cards']) {
  fs.copyFileSync(path.join(root, `client/js/core/${name}.js`), path.join(target, `core/${name}.js`))
}
fs.copyFileSync(path.join(root, 'data/cards.json'), path.join(target, 'cards.json'))
console.log('Built account function runtime from shared rules and card catalog.')

const searchTarget = path.join(root, 'functions/heisino-game/runtime')
fs.mkdirSync(searchTarget, { recursive: true })
for (const name of ['room-map', 'room-loot', 'rng', 'retired-cards', 'constants']) {
  fs.copyFileSync(path.join(root, `client/js/core/${name}.js`), path.join(searchTarget, `${name}.js`))
}
fs.copyFileSync(path.join(root, 'data/cards.json'), path.join(searchTarget, 'cards.json'))
console.log('Built search function runtime from shared room rules.')
