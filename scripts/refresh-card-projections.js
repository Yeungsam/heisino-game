// Mechanical migration: retain original OCR evidence, remove obsolete gameplay fields.
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/cards.json'), 'utf8'))
for (const card of catalog.cards) {
  delete card.durability
  if (card.category === 'WEAPON') card.description = `武器卡，攻击倍率${Math.round(card.attack_multiplier * 100)}%。`
  if (card.category === 'ARMOR') card.description = '防具卡，防御倍率等待玩法数值确认。'
}
require('./sync-card-economy').writeCatalog(catalog)
const schemaPath = path.join(root, 'data/cards.schema.json')
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
schema.$defs.card.required = schema.$defs.card.required.filter(key => key !== 'durability')
delete schema.$defs.card.properties.durability
fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n')
