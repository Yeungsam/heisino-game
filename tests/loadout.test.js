const test = require('node:test')
const assert = require('node:assert/strict')
const cards = require('../client/data/cards')
const C = require('../client/js/core/constants')
const { LoadoutSession } = require('../client/js/core/loadout')
const quantities = Object.fromEntries(cards.map(card => [card.cardId, 1]))

test('账号实际拥有的卡牌中，战备仓库仅展示武器、防具和技能', () => {
  const loadout = new LoadoutSession({ cards, quantities })
  assert.equal(loadout.snapshot().ownedCardIds.length, cards.length)
  const eligibleCardIds = cards.filter(card => card.category !== 'LOOT').map(card => card.cardId)
  assert.deepEqual(loadout.snapshot().warehouseCardIds, eligibleCardIds)
  assert.ok(loadout.snapshot().warehouseCardIds.includes('ar_013'))
})

test('物资卡不能通过战备逻辑放入行动背包', () => {
  const loadout = new LoadoutSession({ cards, quantities })
  const lootCard = cards.find(card => card.category === 'LOOT')
  assert.equal(loadout.add(lootCard.cardId).reason, 'LOADOUT_CATEGORY_NOT_ALLOWED')
  assert.deepEqual(loadout.snapshot().selectedCardIds, [])
})

test('行动战备最多携带4张且背包固定显示10格', () => {
  const loadout = new LoadoutSession({ cards, quantities })
  cards.slice(0, C.LOADOUT_CARD_LIMIT).forEach(card => assert.equal(loadout.add(card.cardId).ok, true))
  assert.equal(loadout.add(cards[C.LOADOUT_CARD_LIMIT].cardId).reason, 'LOADOUT_FULL')
  assert.equal(loadout.snapshot().selectedCardIds.length, 4)
  assert.equal(loadout.snapshot().backpackSlots, 10)
})

test('放入背包的卡牌从仓库移除，取下后回到仓库', () => {
  const loadout = new LoadoutSession({ cards, quantities })
  const cardId = cards[0].cardId
  loadout.add(cardId)
  assert.equal(loadout.snapshot().warehouseCardIds.includes(cardId), false)
  loadout.remove(cardId)
  assert.equal(loadout.snapshot().warehouseCardIds.includes(cardId), true)
})
