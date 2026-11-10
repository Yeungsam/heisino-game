const test = require('node:test')
const assert = require('node:assert/strict')
const { drawRoomLootCard, drawRoomLootCount } = require('../client/js/core/room-loot')
const { ROOM_TYPES } = require('../client/js/core/room-map')
const { cards } = require('../functions/heisino-account/runtime')
const searchCards = require('../functions/heisino-game/catalog')
const { isRetiredCard } = require('../client/js/core/retired-cards')

test('全部 100 个随机落点精确匹配普通房间和金库的掉落数量概率', () => {
  const expected = {
    SPAWN: { 0: 100 }, EXIT: { 0: 100 }, VAULT: { 6: 40, 7: 10, 8: 10, 9: 10, 10: 30 }
  }
  const ordinary = { 0: 20, 1: 20, 2: 30, 3: 20, 4: 10 }
  for (const [y, row] of ROOM_TYPES.entries()) {
    for (const [x, type] of row.entries()) {
      const counts = {}
      for (let roll = 0; roll < 100; roll++) {
        const count = drawRoomLootCount(`n_${x}_${y}`, () => (roll + 0.5) / 100)
        counts[count] = (counts[count] || 0) + 1
      }
      assert.deepEqual(counts, expected[type] || ordinary)
    }
  }
})

test('房型权重区间命中正确，同类坐标共用物资池，默认权重为 1', () => {
  const loungeAt = roll => drawRoomLootCard('n_1_0', () => (roll + 0.5) / 736)
  assert.deepEqual([0, 59, 60, 129, 130, 729, 730, 734, 735].map(loungeAt), [
    'wp_003', 'wp_003', 'wp_004', 'wp_004', 'ar_004', 'loot_023', 'loot_008', 'loot_008', 'loot_002'
  ])
  const reference = { LOUNGE: ['n_1_0', 736, 15], STORAGE: ['n_3_0', 622, 17], SECURITY: ['n_3_1', 285, 17],
    MEDICAL: ['n_4_1', 536, 15], VAULT: ['n_2_2', 666, 14] }
  const accountCardIds = new Set(cards.map(card => card.cardId))
  const searchCardIds = new Set(searchCards.map(card => card.cardId))
  for (const [y, row] of ROOM_TYPES.entries()) {
    for (const [x, type] of row.entries()) {
      const node = `n_${x}_${y}`
      const pool = reference[type]
      if (!pool) {
        assert.equal(drawRoomLootCard(node, () => 0), null)
        continue
      }
      const [referenceNode, total, size] = pool
      const seen = new Set()
      for (let roll = 0; roll < total; roll++) {
        const rng = () => (roll + 0.5) / total
        const cardId = drawRoomLootCard(node, rng)
        assert.equal(cardId, drawRoomLootCard(referenceNode, rng))
        seen.add(cardId)
      }
      assert.equal(seen.size, size)
      assert.ok([...seen].every(id => !isRetiredCard(id) && accountCardIds.has(id) && searchCardIds.has(id)))
    }
  }
})
