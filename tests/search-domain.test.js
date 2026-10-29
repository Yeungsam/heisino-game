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

test('对局初始化为普通房间4件、中央金库10件、撤离点0件', async () => {
  const { service } = fixture()
  const game = await service.createGame({ gameId: 'game-room-counts', playerId: 'P1', loadoutCardIds: ['wp_001'], seed: 'counts' })
  const countByNode = Object.fromEntries(game.rooms.map(room => [room.nodeId, room.itemCount]))
  assert.equal(countByNode.n_0_0, 4)
  assert.equal(countByNode.n_2_2, 10)
  assert.equal(countByNode.n_4_4, 0)
  assert.equal(game.schemaVersion, 2)
  assert.deepEqual(game.rooms[0].areas.map(area => area.areaId), ROOM_AREA_IDS)
  game.rooms.forEach(room => assert.equal(room.areas.reduce((sum, area) => sum + area.itemCount, 0), room.itemCount))
  assert.equal(game.player.inventory.length, 1)
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
  const area = roomArea(game, 'n_0_0')
  const started = await service.startVisit({ gameId: 'game-reveal', playerId: 'P1', roomNodeId: 'n_0_0', turn: 1, requestId: 'visit-1' })
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
  assert.equal(dropped.room.unpickedCount, 4)
  assert.equal(dropped.room.activeArea.itemCount, area.itemCount)
  assert.equal(dropped.room.visibleItems.find(item => item.instanceId === loadoutItemId).areaId, area.areaId)
  assert.ok(dropped.version > started.version)
})

test('区域达到30件后拒绝继续丢弃', async () => {
  const { service, store } = fixture()
  await service.createGame({ gameId: 'game-area-capacity', playerId: 'P1', loadoutCardIds: ['wp_001'], seed: 'capacity' })
  const game = await store.get('game-area-capacity')
  const targetItems = game.items.filter(item => item.nodeId).slice(0, ROOM_AREA_CAPACITY)
  targetItems.forEach(item => {
    item.nodeId = 'n_0_0'
    item.areaId = 'MAIN_TABLE'
  })
  game.rooms.n_0_0.itemIds = targetItems.map(item => item.instanceId)
  game.version += 1
  await store.replace(game, game.version - 1)

  const started = await service.startVisit({ gameId: game.gameId, playerId: 'P1', roomNodeId: 'n_0_0', turn: 1 })
  await service.observe({ gameId: game.gameId, playerId: 'P1', visitId: started.visit.visitId, areaId: 'MAIN_TABLE' })
  await assert.rejects(
    service.drop({ gameId: game.gameId, playerId: 'P1', visitId: started.visit.visitId, instanceId: started.inventory[0].instanceId }),
    requestError => requestError.code === 'AREA_FULL'
  )
})

test('旧版房间文档在下一次写入时确定性迁移到区域模型', async () => {
  const { service, store } = fixture()
  await service.createGame({ gameId: 'game-schema-migration', playerId: 'P1', loadoutCardIds: [], seed: 'migration' })
  const legacy = await store.get('game-schema-migration')
  delete legacy.schemaVersion
  Object.values(legacy.rooms).forEach(room => delete room.areas)
  legacy.items.forEach(item => delete item.areaId)
  legacy.version += 1
  await store.replace(legacy, legacy.version - 1)

  await service.startVisit({ gameId: legacy.gameId, playerId: 'P1', roomNodeId: 'n_0_0', turn: 1 })
  const migrated = await store.get(legacy.gameId)
  assert.equal(migrated.schemaVersion, 2)
  assert.deepEqual(Object.keys(migrated.rooms.n_0_0.areas), ROOM_AREA_IDS)
  const assignments = migrated.items.filter(item => item.nodeId === 'n_0_0').map(item => item.areaId)
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
