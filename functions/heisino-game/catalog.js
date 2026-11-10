const fs = require('node:fs')
const path = require('node:path')
const source = path.join(__dirname, '../../data/cards.json')
const { cards } = require(fs.existsSync(source) ? source : './runtime/cards.json')

module.exports = cards.map(card => ({ cardId: card.card_id, kind: card.kind, category: card.category }))
