const test = require('node:test')
const assert = require('node:assert/strict')
const cards = require('../client/data/cards')
const C = require('../client/js/core/constants')
const { LoadoutSession } = require('../client/js/core/loadout')

test('战备仓库默认拥有当前版本全部卡牌', () => {
  const loadout = new LoadoutSession({ cards })
  assert.equal(loadout.snapshot().ownedCardIds.length, cards.length)
  assert.deepEqual(loadout.snapshot().warehouseCardIds, cards.map(card => card.cardId))
})

test('行动战备最多携带4张且背包固定显示10格', () => {
  const loadout = new LoadoutSession({ cards })
  cards.slice(0, C.LOADOUT_CARD_LIMIT).forEach(card => assert.equal(loadout.add(card.cardId).ok, true))
  assert.equal(loadout.add(cards[C.LOADOUT_CARD_LIMIT].cardId).reason, 'LOADOUT_FULL')
  assert.equal(loadout.snapshot().selectedCardIds.length, 4)
  assert.equal(loadout.snapshot().backpackSlots, 10)
})

test('放入背包的卡牌从仓库移除，取下后回到仓库', () => {
  const loadout = new LoadoutSession({ cards })
  const cardId = cards[0].cardId
  loadout.add(cardId)
  assert.equal(loadout.snapshot().warehouseCardIds.includes(cardId), false)
  loadout.remove(cardId)
  assert.equal(loadout.snapshot().warehouseCardIds.includes(cardId), true)
})
