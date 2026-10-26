const test = require('node:test')
const assert = require('node:assert/strict')
const cards = require('../functions/heisino-game/catalog')
const {
  SEARCH_DURATION_MS,
  REVEAL_INTERVAL_MS,
  MemorySearchStore,
  SearchGameService
} = require('../functions/heisino-game/search-domain')

function fixture() {
  let time = 1000
  const service = new SearchGameService({
    cards,
    store: new MemorySearchStore(),
    now: () => time
  })
  return { service, advance(ms) { time += ms }, now() { return time } }
}

test('对局初始化为普通房间4件、中央金库10件、撤离点0件', async () => {
  const { service } = fixture()
  const game = await service.createGame({ gameId: 'game-room-counts', playerId: 'P1', loadoutCardIds: ['wp_001'], seed: 'counts' })
  const countByNode = Object.fromEntries(game.rooms.map(room => [room.nodeId, room.itemCount]))
  assert.equal(countByNode.n_0_0, 4)
  assert.equal(countByNode.n_2_2, 10)
  assert.equal(countByNode.n_4_4, 0)
  assert.equal(game.player.inventory.length, 1)
})

test('搜索观察每2秒曝光1件且一次最多展示2件', async () => {
  const { service, advance } = fixture()
  await service.createGame({ gameId: 'game-reveal', playerId: 'P1', loadoutCardIds: [], seed: 'reveal' })
  const started = await service.startVisit({ gameId: 'game-reveal', playerId: 'P1', roomNodeId: 'n_0_0', turn: 1, requestId: 'visit-1' })
  await service.observe({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId, requestId: 'observe-1' })

  advance(REVEAL_INTERVAL_MS - 1)
  let state = await service.getVisit({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.room.visibleItems.length, 0)
  advance(1)
  state = await service.getVisit({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.room.visibleItems.length, 1)
  advance(REVEAL_INTERVAL_MS)
  state = await service.getVisit({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.room.visibleItems.length, 2)
  advance(REVEAL_INTERVAL_MS * 5)
  state = await service.getVisit({ gameId: 'game-reveal', playerId: 'P1', visitId: started.visit.visitId })
  assert.equal(state.room.visibleItems.length, 2)
  assert.equal(state.room.unsearchedCount, 2)
})

test('已曝光未拾取物可再次观察，拾取和丢弃由权威状态结算', async () => {
  const { service, advance } = fixture()
  await service.createGame({ gameId: 'game-actions', playerId: 'P1', loadoutCardIds: ['wp_001'], seed: 'actions' })
  const started = await service.startVisit({ gameId: 'game-actions', playerId: 'P1', roomNodeId: 'n_1_0', turn: 1, requestId: 'visit-1' })
  assert.equal(started.version, 2)
  await service.observe({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, requestId: 'observe-1' })
  advance(REVEAL_INTERVAL_MS * 2)
  let state = await service.getVisit({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId })
  const exposedId = state.room.visibleItems[0].instanceId
  await service.finishObservation({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, requestId: 'finish-1' })
  state = await service.observe({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, requestId: 'observe-2' })
  assert.ok(state.room.visibleItems.some(item => item.instanceId === exposedId))

  const picked = await service.pickup({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, instanceId: exposedId, requestId: 'pickup-1' })
  assert.equal(picked.inventory.length, 2)
  const replayed = await service.pickup({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, instanceId: exposedId, requestId: 'pickup-1' })
  assert.deepEqual(replayed, picked)

  const loadoutItemId = picked.inventory.find(item => item.cardId === 'wp_001').instanceId
  const dropped = await service.drop({ gameId: 'game-actions', playerId: 'P1', visitId: started.visit.visitId, instanceId: loadoutItemId, requestId: 'drop-1' })
  assert.equal(dropped.inventory.length, 1)
  assert.equal(dropped.room.unpickedCount, 4)
  assert.ok(dropped.version > started.version)
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
    service.observe({ gameId: 'game-timeout', playerId: 'P1', visitId: started.visit.visitId, requestId: 'observe-after-timeout' }),
    requestError => requestError.code === 'SEARCH_TIMEOUT'
  )
})
