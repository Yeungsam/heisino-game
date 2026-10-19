const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const clientCards = require('../client/data/cards')

const sourcePath = path.join(__dirname, '..', 'data', 'cards.json')
const sourceCards = JSON.parse(fs.readFileSync(sourcePath, 'utf8')).cards

test('微信小游戏卡牌投影与主配置保持一致', () => {
  assert.equal(clientCards.length, sourceCards.length)
  sourceCards.forEach(source => {
    const projected = clientCards.find(card => card.cardId === source.card_id)
    assert.ok(projected, `缺少客户端卡牌 ${source.card_id}`)
    assert.equal(projected.name, source.name)
    assert.equal(projected.kind, source.kind)
    assert.equal(projected.category, source.category)
    assert.equal(projected.attackMultiplier, source.attack_multiplier)
    assert.equal(projected.maxDurability, source.durability.max)
    assert.equal(projected.dataStatus, source.data_status)
    const expectedValue = source.economy.fixed_value ?? source.economy.purchase_price
    assert.equal(projected.value, expectedValue)
  })
})
