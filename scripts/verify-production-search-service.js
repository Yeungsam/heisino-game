const assert = require('node:assert/strict')

const origin = process.env.SEARCH_API_ORIGIN || 'https://cloud1-d5ghcmrajdca722b5-1510428576.ap-shanghai.app.tcloudbase.com/api/search'
const gameId = process.env.SEARCH_SMOKE_GAME_ID || `prod-smoke-${Date.now()}`
const playerId = 'production-smoke-player'

async function request(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method || 'GET',
    headers: options.body ? {
      'Content-Type': 'application/json',
      'X-Request-Id': options.requestId || `${gameId}-${Date.now()}`
    } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const payload = await response.json()
  assert.equal(response.ok, true, `${response.status} ${JSON.stringify(payload)}`)
  return payload.data || payload
}

async function main() {
  const health = await request('/health')
  assert.equal(health.service, 'heisino-search-service')
  assert.equal(health.schemaVersion, '2.0.0')

  const game = await request('/games', {
    method: 'POST',
    body: { gameId, playerId, loadoutCardIds: ['wp_001'], seed: 'production-smoke' }
  })
  const roomCounts = Object.fromEntries(game.rooms.map(room => [room.nodeId, room.itemCount]))
  assert.equal(game.rooms.length, 25)
  assert.equal(game.schemaVersion, 2)
  assert.equal(roomCounts.n_1_0, 3)
  for (const node of ['n_0_0', 'n_0_4', 'n_4_0', 'n_4_4']) assert.equal(roomCounts[node], 0)
  assert.equal(roomCounts.n_2_2, 7)
  assert.equal(roomCounts.n_1_1, 0)
  assert.equal(game.player.inventory.length, 1)
  game.rooms.forEach(room => assert.equal(room.areas.reduce((sum, area) => sum + area.itemCount, 0), room.itemCount))

  const entered = await request(`/games/${gameId}/visits`, {
    method: 'POST',
    requestId: `${gameId}-visit`,
    body: { playerId, roomNodeId: 'n_1_0', turn: 1 }
  })
  assert.equal(entered.room.unpickedCount, 3)
  assert.deepEqual(entered.room.visibleItems, [])
  const visitId = entered.visit.visitId
  await request(`/games/${gameId}/visits/${visitId}/observe`, {
    method: 'POST',
    requestId: `${gameId}-observe`,
    body: { playerId, areaId: entered.room.areas.find(area => area.itemCount > 0).areaId }
  })

  await new Promise(resolve => setTimeout(resolve, 2200))
  const observed = await request(`/games/${gameId}/visits/${visitId}?playerId=${encodeURIComponent(playerId)}`)
  assert.equal(observed.visit.status, 'ACTIVE')
  assert.equal(observed.room.visibleItems.length, 1)

  const picked = await request(`/games/${gameId}/visits/${visitId}/pickup`, {
    method: 'POST',
    requestId: `${gameId}-pickup`,
    body: { playerId, instanceId: observed.room.visibleItems[0].instanceId }
  })
  assert.equal(picked.inventory.length, 2)
  assert.equal(picked.room.unpickedCount, 2)

  const left = await request(`/games/${gameId}/visits/${visitId}/leave`, {
    method: 'POST',
    requestId: `${gameId}-leave`,
    body: { playerId }
  })
  assert.equal(left.visit.status, 'LEFT')

  const returned = await request(`/games/${gameId}/visits`, {
    method: 'POST', requestId: `${gameId}-return`, body: { playerId, roomNodeId: 'n_1_0', turn: 2 }
  })
  assert.equal(returned.room.unpickedCount, 2)
  const vault = await request(`/games/${gameId}/visits`, {
    method: 'POST', requestId: `${gameId}-vault`, body: { playerId, roomNodeId: 'n_2_2', turn: 3 }
  })
  assert.equal(vault.room.unpickedCount, 7)
  const empty = await request(`/games/${gameId}/visits`, {
    method: 'POST', requestId: `${gameId}-empty`, body: { playerId, roomNodeId: 'n_1_1', turn: 4 }
  })
  assert.equal(empty.room.unpickedCount, 0)

  console.log(JSON.stringify({
    ok: true,
    gameId,
    rooms: game.rooms.length,
    normalRoomItems: entered.room.unpickedCount,
    spawnItems: roomCounts.n_0_0,
    emptyOrdinaryRoomItems: empty.room.unpickedCount,
    revisitedRoomItems: returned.room.unpickedCount,
    vaultItems: roomCounts.n_2_2,
    extractionItems: roomCounts.n_4_4,
    areaSchemaVersion: game.schemaVersion,
    revealedAfterMs: 2200,
    inventoryAfterPickup: picked.inventory.length,
    finalVisitStatus: left.visit.status
  }, null, 2))
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
