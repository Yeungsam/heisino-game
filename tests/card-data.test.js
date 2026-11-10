const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const clientCards = require('../client/data/cards')
const { RETIRED_CARD_IDS, assertActiveCardIds } = require('../client/js/core/retired-cards')

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
    assert.equal(projected.rarity, source.rarity)
    assert.equal(projected.attackMultiplier, source.attack_multiplier)
    assert.equal(Object.hasOwn(projected, 'maxDurability'), false)
    assert.equal(Object.hasOwn(source, 'durability'), false)
    assert.equal(projected.dataStatus, source.data_status)
    assert.equal(projected.description, source.description)
    assert.equal(projected.assetPath, source.assets.card_art_path)
    const expectedValue = source.economy.fixed_value ?? source.economy.purchase_price
    assert.equal(projected.value, expectedValue)
  })
})

test('客户端和云端目录包含四类 51 张卡牌', () => {
  const counts = sourceCards.reduce((result, card) => {
    result[card.category] = (result[card.category] || 0) + 1
    return result
  }, {})

  assert.equal(sourceCards.length, 51)
  assert.deepEqual(counts, { WEAPON: 7, ARMOR: 13, LOOT: 23, SKILL: 8 })
  assert.deepEqual(require('../functions/heisino-cards/cards.json').cards, sourceCards)
  sourceCards.forEach(card => {
    assert.match(card.assets.sha256, /^[a-f0-9]{64}$/)
    assert.match(card.assets.card_art_path, /^\/assets\/cards\/[a-z0-9_]+\.jpg$/)
    assert.ok(card.source.ocr_text.length > 0)
  })
})

test('停用的两个技能 ID 永久保留，目录校验拒绝复用和重复编号', () => {
  assert.ok(RETIRED_CARD_IDS.includes('sk_002') && RETIRED_CARD_IDS.includes('sk_003'))
  const activeIds = sourceCards.map(card => card.card_id)
  assert.doesNotThrow(() => assertActiveCardIds(activeIds))
  for (const id of RETIRED_CARD_IDS) assert.throws(() => assertActiveCardIds([...activeIds, id]), /Retired card ID/)
  assert.throws(() => assertActiveCardIds([...activeIds, activeIds[0]]), /Duplicate card ID/)
})
