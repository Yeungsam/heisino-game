const fs = require('node:fs')
const path = require('node:path')
const prices = require('../data/card-prices.json')

const root = path.resolve(__dirname, '..')
const source = path.join(root, 'data/cards.json')
const { projectCard } = require('../client/js/core/card-projection')

function writeCatalog(catalog) {
  const ids = new Set(catalog.cards.map(card => card.card_id))
  for (const id of Object.keys(prices)) if (!ids.has(id)) throw new Error(`Unknown priced card: ${id}`)
  for (const card of catalog.cards) {
    const [grade, value, restriction] = prices[card.card_id] || []
    if (!['A', 'B', 'S', 'SS'].includes(grade) || !Number.isSafeInteger(value) || value < 1 ||
        (restriction !== undefined && restriction !== 'DROP_ONLY')) throw new Error(`Invalid economy: ${card.card_id}`)
    const onSale = !restriction && ['A', 'B'].includes(grade) && ['WEAPON', 'ARMOR', 'SKILL'].includes(card.category)
    const purchasePrice = onSale ? value * 6 / 5 : null
    if (onSale && !Number.isSafeInteger(purchasePrice)) throw new Error(`Non-integer purchase price: ${card.card_id}`)
    card.economy = {
      currency: 'GOLD', grade, value_source: card.kind === 'LOOT' ? 'FIXED_LOOT_VALUE' : 'TRADE_VALUE',
      purchase_price: purchasePrice, fixed_value: value
    }
    if (card.kind === 'LOOT') card.description = `物资卡，撤离结算价值${value} Gold。`
  }
  const json = `${JSON.stringify(catalog, null, 2)}\n`
  fs.writeFileSync(source, json)
  fs.writeFileSync(path.join(root, 'functions/heisino-cards/cards.json'), json)
  const projection = catalog.cards.map(projectCard)
  fs.writeFileSync(path.join(root, 'client/data/cards.js'),
    `// Generated from data/cards.json.\nmodule.exports = ${JSON.stringify(projection, null, 2)}\n`)
}

if (require.main === module) writeCatalog({ ...require(source), generated_at: new Date().toISOString() })
module.exports = { writeCatalog }
