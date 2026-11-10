const test = require('node:test')
const assert = require('node:assert/strict')
const { drawRoomLootCard } = require('../client/js/core/room-loot')
const { ROOM_TYPES } = require('../client/js/core/room-map')
const { cards } = require('../functions/heisino-account/runtime')
const searchCards = require('../functions/heisino-game/catalog')

test('房型权重区间命中正确，同类坐标共用物资池，默认权重为 1', () => {
  const loungeAt = roll => drawRoomLootCard('n_1_0', () => (roll + 0.5) / 736)
  assert.deepEqual([0, 59, 60, 129, 130, 729, 730, 734, 735].map(loungeAt), [
    'wp_003', 'wp_003', 'wp_004', 'wp_004', 'ar_004', 'loot_023', 'loot_008', 'loot_008', 'loot_002'
  ])
  const reference = { LOUNGE: ['n_1_0', 736, 15], STORAGE: ['n_3_0', 642, 18], SECURITY: ['n_3_1', 300, 19],
    MEDICAL: ['n_4_1', 536, 15], VAULT: ['n_2_2', 706, 15] }
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
      assert.ok([...seen].every(id => accountCardIds.has(id) && searchCardIds.has(id)))
    }
  }
})
