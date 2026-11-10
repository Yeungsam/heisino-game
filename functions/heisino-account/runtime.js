// Local development uses the source of truth. The build script creates a
// self-contained runtime/ directory inside this function for deployment.
const fs = require('node:fs')
const path = require('node:path')
const local = fs.existsSync(path.join(__dirname, '../../client/js/core/game-engine.js'))
const core = local ? require('../../client/js/core/game-engine') : require('./runtime/core/game-engine')
const bundled = path.join(__dirname, 'runtime/cards.json')
const raw = JSON.parse(fs.readFileSync(local ? path.join(__dirname, '../../data/cards.json') : bundled, 'utf8'))
const cards = raw.cards.map(card => ({
  cardId: card.card_id, name: card.name, kind: card.kind, category: card.category, rarity: card.rarity,
  attackMultiplier: card.attack_multiplier, defenseMultiplier: card.defense_multiplier,
  value: card.economy.fixed_value ?? card.economy.purchase_price ?? 0
}))
const constants = local ? require('../../client/js/core/constants') : require('./runtime/core/constants')
const retired = local ? require('../../client/js/core/retired-cards') : require('./runtime/core/retired-cards')
module.exports = { ...core, ...retired, cards, constants }
