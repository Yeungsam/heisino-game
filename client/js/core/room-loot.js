const { roomKeyForNode } = require('./room-map')
const { createSeededRng, hashSeed, randomInt } = require('./rng')

// 飞书《房间物资表》2026-11-10，按房型使用一份权重表。
const POOLS = {
  LOUNGE: [
    ['wp_003', 60], ['wp_004', 70], ['ar_004', 70], ['ar_009', 50], ['ar_010', 40], ['sk_005', 30],
    ['loot_004', 40], ['loot_010', 60], ['loot_013', 70], ['loot_014', 60], ['loot_012', 50],
    ['loot_018', 60], ['loot_023', 70], ['loot_008', 5], ['loot_002']
  ],
  STORAGE: [
    ['ar_009', 15], ['ar_010', 10], ['sk_007', 10], ['wp_003', 50], ['ar_001', 80], ['wp_002', 30],
    ['wp_004', 40], ['ar_005', 30], ['ar_006', 60], ['ar_007', 60], ['sk_003', 20], ['loot_015', 70],
    ['loot_016', 60], ['loot_004', 50], ['loot_008', 20], ['loot_020', 30], ['loot_007', 5], ['loot_002', 2]
  ],
  SECURITY: [
    ['wp_006', 20], ['loot_017', 20], ['loot_021', 10], ['loot_022', 20], ['ar_002', 20], ['ar_009', 10],
    ['sk_001', 10], ['sk_002', 10], ['sk_003', 5], ['sk_004', 5], ['sk_005', 10], ['sk_006', 10],
    ['sk_007', 10], ['sk_008', 10], ['sk_009', 15], ['sk_010', 10], ['loot_005', 30], ['loot_012', 70], ['loot_002', 5]
  ],
  MEDICAL: [
    ['loot_022', 40], ['ar_009', 40], ['wp_002', 40], ['wp_005', 20], ['wp_007', 85], ['ar_001', 60],
    ['ar_003', 20], ['ar_005', 25], ['ar_007', 40], ['sk_004', 20], ['loot_006', 3], ['loot_009', 3],
    ['loot_013', 50], ['loot_020', 50], ['loot_021', 40]
  ],
  VAULT: [
    ['loot_023', 3], ['loot_016', 3], ['wp_001', 40], ['ar_003', 55], ['ar_005', 50], ['sk_002', 40],
    ['sk_006', 70], ['loot_001', 60], ['loot_002', 60], ['loot_003', 55], ['loot_005', 50],
    ['loot_006', 50], ['loot_007', 50], ['loot_008', 75], ['loot_009', 45]
  ]
}

const TABLES = Object.fromEntries(Object.entries(POOLS).map(([type, pool]) => {
  let total = 0
  const entries = pool.map(([cardId, weight = 1]) => ({ cardId, upperBound: total += weight }))
  return [type, { total, entries }]
}))

const NORMAL_COUNT_THRESHOLDS = [20, 40, 70, 90, 100]
const VAULT_COUNT_THRESHOLDS = [40, 50, 60, 70, 100]

function drawRoomLootCount(roomNodeId, rng) {
  const type = roomKeyForNode(roomNodeId)
  if (!TABLES[type]) return 0
  const vault = type === 'VAULT'
  const thresholds = vault ? VAULT_COUNT_THRESHOLDS : NORMAL_COUNT_THRESHOLDS
  const roll = randomInt(rng, 100)
  return (vault ? 6 : 0) + thresholds.findIndex(threshold => roll < threshold)
}

function roomLootAreas(roomNodeId, seed, areaIds, { fixedCount = false } = {}) {
  const type = roomKeyForNode(roomNodeId)
  if (!TABLES[type]) return []
  // Quantity has its own random stream so it cannot shift card or area draws.
  const countRng = createSeededRng(hashSeed(`${seed}:${roomNodeId}:count`))
  const count = fixedCount ? (type === 'VAULT' ? 10 : 4) : drawRoomLootCount(roomNodeId, countRng)
  const rng = createSeededRng(hashSeed(`${seed}:${roomNodeId}:areas`))
  return Array.from({ length: count }, () => areaIds[randomInt(rng, areaIds.length)])
}

function drawRoomLootCard(roomNodeId, rng) {
  const table = TABLES[roomKeyForNode(roomNodeId)]
  if (!table) return null
  const roll = randomInt(rng, table.total)
  return table.entries.find(entry => roll < entry.upperBound).cardId
}

function stockRoomLoot(roomNodeId, seed, areas, addItem) {
  const rng = createSeededRng(hashSeed(`${seed}:${roomNodeId}:cards`))
  // Each draw uses the original pool. Repeated card IDs get distinct item instances.
  for (const areaId of areas) addItem(drawRoomLootCard(roomNodeId, rng), areaId)
}

module.exports = { roomLootAreas, drawRoomLootCount, drawRoomLootCard, stockRoomLoot }
