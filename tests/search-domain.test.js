const test = require('node:test')
const assert = require('node:assert/strict')
const cards = require('../functions/heisino-game/catalog')
const {
  SEARCH_DURATION_MS,
  REVEAL_INTERVAL_MS,
  ROOM_AREA_CAPACITY,
  ROOM_AREA_IDS,
  MemorySearchStore,
  SearchGameService
} = require('../functions/heisino-game/search-domain')

function fixture() {
  let time = 1000
  const store = new MemorySearchStore()
  const service = new SearchGameService({
    cards,
    store,
    now: () => time
  })
  return { service, store, advance(ms) { time += ms }, now() { return time } }
}

function roomArea(game, roomNodeId, predicate = area => area.itemCount > 0) {
  return game.rooms.find(room => room.nodeId === roomNodeId).areas.find(predicate)
}

test('独立搜索建局保留随机数量，首次进入按计划生成，空房重进保持为空', async () => {
  const { service, store } = fixture()
  const game = await service.createGame({ gameId: 'game-room-counts', playerId: 'P1', loadoutCardIds: ['wp_001'], seed: 'counts' })
  const countByNode = Object.fromEntries(game.rooms.map(room => [room.nodeId, room.itemCount]))
  assert.equal(countByNode.n_1_0, 0)
  assert.equal(countByNode.n_0_0, 0)
  assert.equal(countByNode.n_4_0, 0)
  assert.equal(countByNode.n_0_4, 0)
  assert.equal(countByNode.n_2_2, 7)
  assert.equal(countByNode.n_4_4, 0)
  assert.equal(game.schemaVersion, 2)
  assert.deepEqual(game.rooms[0].areas.map(area => area.areaId), ROOM_AREA_IDS)
  game.rooms.forEach(room => assert.equal(room.areas.reduce((sum, area) => sum + area.itemCount, 0), room.itemCount))
  assert.equal(game.player.inventory.length, 1)
  assert.equal((await store.get(game.gameId)).items.length, 1)
  for (const [index, [roomNodeId, count]] of Object.entries(countByNode).entries()) {
    const visited = await service.startVisit({ gameId: game.gameId, playerId: 'P1', roomNodeId, turn: index + 1 })
    assert.equal(visited.room.unpickedCount, count)
    assert.deepEqual(visited.room.areas.map(area => area.itemCount), game.rooms[index].areas.map(area => area.itemCount))
    assert.deepEqual(visited.room.visibleItems, [])
  }
  const stored = await store.get(game.gameId)
  assert.equal(Object.hasOwn(stored.rooms.n_1_0, 'lootAreas'), false)
  const returned = await service.startVisit({ gameId: game.gameId, playerId: 'P1', roomNodeId: 'n_1_0', turn: 26 })
  assert.equal(returned.room.unpickedCount, 0)
})

test('服务端建局时不接受物资卡作为战备', async () => {
  const { service } = fixture()
  const game = await service.createGame({
    gameId: 'game-loadout-categories',
    playerId: 'P1',
    loadoutCardIds: ['wp_001', 'loot_001', 'ar_001', 'sk_001']
  })
  assert.deepEqual(game.player.inventory.map(item => item.cardId), ['wp_001', 'ar_001', 'sk_001'])
})

test('区域搜索每2秒曝光1件并持续展示该区域全部物品', async () => {
  const { service, advance } = fixture()
  const game = await service.createGame({ gameId: 'game-reveal', playerId: 'P1', loadoutCardIds: [], seed: 'reveal' })
  const area = roomArea(game, 'n_1_0')
  const started = await service.startVisit({ gameId: 'game-reveal', playerId: 'P1', roomNodeId: 'n_1_0', turn: 1, requestId: 'visit-1' })
  await service.observe({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId, areaId: area.areaId, requestId: 'observe-1' })

  advance(REVEAL_INTERVAL_MS - 1)
  let state = await service.getVisit({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.room.visibleItems.length, 0)
  advance(1)
  state = await service.getVisit({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.room.activeArea.visibleItems.length, 1)
  advance(REVEAL_INTERVAL_MS * area.itemCount)
  state = await service.getVisit({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.room.activeArea.visibleItems.length, area.itemCount)
  assert.equal(state.room.activeArea.unsearchedCount, 0)
})

test('允许进入0件物品的区域并保持有效搜索状态', async () => {
  const { service, advance } = fixture()
  const game = await service.createGame({ gameId: 'game-empty-area', playerId: 'P1', loadoutCardIds: [], seed: 'empty-area' })
  const targetRoom = game.rooms.find(room => room.areas.some(area => area.itemCount === 0))
  const emptyArea = targetRoom.areas.find(area => area.itemCount === 0)
  const started = await service.startVisit({ gameId: game.gameId, playerId: 'P1', roomNodeId: targetRoom.nodeId, turn: 1 })
  await service.observe({ gameId: game.gameId, playerId: 'P1', visitId: started.visit.visitId, areaId: emptyArea.areaId })
  advance(REVEAL_INTERVAL_MS)
  const state = await service.getVisit({ gameId: game.gameId, playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.visit.status, 'ACTIVE')
  assert.equal(state.room.activeArea.areaId, emptyArea.areaId)
  assert.equal(state.room.activeArea.itemCount, 0)
  assert.deepEqual(state.room.activeArea.visibleItems, [])
})

test('已曝光未拾取物可再次观察，拾取和丢弃由权威状态结算', async () => {
  const { service, advance } = fixture()
  const game = await service.createGame({ gameId: 'game-actions', playerId: 'P1', loadoutCardIds: ['wp_001'], seed: 'actions' })
  const area = roomArea(game, 'n_1_0')
  const started = await service.startVisit({ gameId: 'game-actions', playerId: 'P1', roomNodeId: 'n_1_0', turn: 1, requestId: 'visit-1' })
  assert.equal(started.version, 2)
  await service.observe({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, areaId: area.areaId, requestId: 'observe-1' })
  advance(REVEAL_INTERVAL_MS * 2)
  let state = await service.getVisit({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId })
  const exposedId = state.room.visibleItems[0].instanceId
  await service.finishObservation({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, requestId: 'finish-1' })
  state = await service.observe({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, areaId: area.areaId, requestId: 'observe-2' })
  assert.ok(state.room.visibleItems.some(item => item.instanceId === exposedId))

  const picked = await service.pickup({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, instanceId: exposedId, requestId: 'pickup-1' })
  assert.equal(picked.inventory.length, 2)
  const replayed = await service.pickup({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, instanceId: exposedId, requestId: 'pickup-1' })
  assert.deepEqual(replayed, picked)

  const loadoutItemId = picked.inventory.find(item => item.cardId === 'wp_001').instanceId
  const dropped = await service.drop({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, instanceId: loadoutItemId, requestId: 'drop-1' })
  assert.equal(dropped.inventory.length, 1)
  assert.equal(dropped.room.unpickedCount, 3)
  assert.equal(dropped.room.activeArea.itemCount, area.itemCount)
  assert.equal(dropped.room.visibleItems.find(item => item.instanceId === loadoutItemId).areaId, area.areaId)
  assert.ok(dropped.version > started.version)
  await service.leave({ gameId: game.gameId, playerId: 'P1', visitId: started.visit.visitId })
  const reenter = requestId => service.startVisit({ gameId: game.gameId, playerId: 'P1', roomNodeId: 'n_1_0', turn: 2, requestId })
  const [retryA, retryB] = await Promise.all([reenter('visit-2a'), reenter('visit-2b')])
  assert.equal(retryA.visit.visitId, retryB.visit.visitId)
  assert.equal(retryA.room.unpickedCount, 3)
  assert.equal(retryB.inventory[0].instanceId, exposedId)
})

test('区域达到30件后拒绝继续丢弃', async () => {
  const { service, store } = fixture()
  await service.createGame({ gameId: 'game-area-capacity', playerId: 'P1', loadoutCardIds: ['wp_001'], seed: 'capacity' })
  const started = await service.startVisit({ gameId: 'game-area-capacity', playerId: 'P1', roomNodeId: 'n_0_0', turn: 1 })
  const game = await store.get('game-area-capacity')
  for (let i = 0; i < ROOM_AREA_CAPACITY; i++) service.addItem(game, 'loot_001', 'n_0_0', 'MAIN_TABLE', 'HIDDEN')
  game.version += 1
  await store.replace(game, game.version - 1)

  await service.observe({ gameId: game.gameId, playerId: 'P1', visitId: started.visit.visitId, areaId: 'MAIN_TABLE' })
  await assert.rejects(
    service.drop({ gameId: game.gameId, playerId: 'P1', visitId: started.visit.visitId, instanceId: started.inventory[0].instanceId }),
    requestError => requestError.code === 'AREA_FULL'
  )
})

test('独立搜索中十件同款占满背包，放下一件后才可拾取同款', async () => {
  const { service, store, advance } = fixture()
  const gameId = 'game-instance-capacity', playerId = 'P1', roomNodeId = 'n_0_0', areaId = 'MAIN_TABLE'
  const created = await service.createGame({ gameId, playerId, loadoutCardIds: Array(10).fill('wp_001') })
  const started = await service.startVisit({ gameId, playerId, roomNodeId, turn: 1 })
  const input = { gameId, playerId, visitId: started.visit.visitId }
  const stored = await store.get(gameId)
  const candidate = service.addItem(stored, 'wp_001', roomNodeId, areaId, 'HIDDEN')
  const version = stored.version++
  await store.replace(stored, version)
  await service.observe({ ...input, areaId })
  advance(REVEAL_INTERVAL_MS)
  await assert.rejects(service.pickup({ ...input, instanceId: candidate }), { code: 'BACKPACK_FULL' })
  const unchanged = await service.getVisit(input)
  assert.equal(unchanged.inventory.length, 10)
  assert.ok(unchanged.room.visibleItems.some(item => item.instanceId === candidate))
  const droppedId = created.player.inventory[0].instanceId
  await service.drop({ ...input, instanceId: droppedId })
  const picked = await service.pickup({ ...input, instanceId: candidate })
  assert.equal(picked.inventory.length, 10)
  assert.ok(picked.inventory.some(item => item.instanceId === candidate))
  assert.ok(picked.room.visibleItems.some(item => item.instanceId === droppedId))
})

test('旧版房间文档在下一次写入时确定性迁移到区域模型', async () => {
  const { service, store } = fixture()
  await service.createGame({ gameId: 'game-schema-migration', playerId: 'P1', loadoutCardIds: [], seed: 'migration' })
  await service.startVisit({ gameId: 'game-schema-migration', playerId: 'P1', roomNodeId: 'n_1_0', turn: 1 })
  const legacy = await store.get('game-schema-migration')
  delete legacy.schemaVersion
  delete legacy.lootSeed
  Object.values(legacy.rooms).forEach(room => { delete room.areas; delete room.lootAreas })
  legacy.items.forEach(item => delete item.areaId)
  legacy.version += 1
  await store.replace(legacy, legacy.version - 1)

  await service.startVisit({ gameId: legacy.gameId, playerId: 'P1', roomNodeId: 'n_1_0', turn: 2 })
  const migrated = await store.get(legacy.gameId)
  assert.equal(migrated.schemaVersion, 2)
  assert.deepEqual(Object.keys(migrated.rooms.n_1_0.areas), ROOM_AREA_IDS)
  const assignments = migrated.items.filter(item => item.nodeId === 'n_1_0').map(item => item.areaId)
  assert.equal(assignments.length, 3)
  assert.ok(assignments.every(areaId => ROOM_AREA_IDS.includes(areaId)))
})

test('未处于观察层时不能绕过交互直接丢弃背包物品', async () => {
  const { service } = fixture()
  await service.createGame({ gameId: 'game-drop-guard', playerId: 'P1', loadoutCardIds: ['wp_001'] })
  const started = await service.startVisit({ gameId: 'game-drop-guard', playerId: 'P1', roomNodeId: 'n_0_0', turn: 1 })
  const inventoryId = started.inventory[0].instanceId
  await assert.rejects(
    service.drop({ gameId: 'game-drop-guard', playerId: 'P1', visitId: started.visit.visitId, instanceId: inventoryId }),
    requestError => requestError.code === 'OBSERVATION_NOT_ACTIVE'
  )
})

test('50秒搜索期限由服务端判定并自动关闭访问', async () => {
  const { service, advance } = fixture()
  await service.createGame({ gameId: 'game-timeout', playerId: 'P1', loadoutCardIds: [] })
  const started = await service.startVisit({ gameId: 'game-timeout', playerId: 'P1', roomNodeId: 'n_0_0', turn: 1, requestId: 'visit-1' })
  assert.equal(started.visit.deadlineAt - started.visit.startedAt, SEARCH_DURATION_MS)
  advance(SEARCH_DURATION_MS)
  const state = await service.getVisit({ gameId: 'game-timeout', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.visit.status, 'TIMED_OUT')
  await assert.rejects(
    service.observe({ gameId: 'game-timeout', playerId: 'P1', visitId: started.visit.visitId, areaId: 'MAIN_TABLE', requestId: 'observe-after-timeout' }),
    requestError => requestError.code === 'SEARCH_TIMEOUT'
  )
})
