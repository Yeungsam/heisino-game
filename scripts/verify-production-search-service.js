const assert = require('node:assert/strict')

const origin = process.env.SEARCH_API_ORIGIN || 'https://cloud1-d5ghcmrajdca722b5-1510428576.ap-shanghai.app.tcloudbase.com/api/search'
const gameId = `prod-smoke-${Date.now()}`
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

  const game = await request('/games', {
    method: 'POST',
    body: { gameId, playerId, loadoutCardIds: ['wp_001'], seed: 'production-smoke' }
  })
  const roomCounts = Object.fromEntries(game.rooms.map(room => [room.nodeId, room.itemCount]))
  assert.equal(game.rooms.length, 25)
  assert.equal(roomCounts.n_0_0, 4)
  assert.equal(roomCounts.n_2_2, 10)
  assert.equal(roomCounts.n_4_4, 0)
  assert.equal(game.player.inventory.length, 1)

  const entered = await request(`/games/${gameId}/visits`, {
    method: 'POST',
    requestId: `${gameId}-visit`,
    body: { playerId, roomNodeId: 'n_0_0', turn: 1 }
  })
  const visitId = entered.visit.visitId
  await request(`/games/${gameId}/visits/${visitId}/observe`, {
    method: 'POST',
    requestId: `${gameId}-observe`,
    body: { playerId }
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
  assert.equal(picked.room.unpickedCount, 3)

  const left = await request(`/games/${gameId}/visits/${visitId}/leave`, {
    method: 'POST',
    requestId: `${gameId}-leave`,
    body: { playerId }
  })
  assert.equal(left.visit.status, 'LEFT')

  console.log(JSON.stringify({
    ok: true,
    gameId,
    rooms: game.rooms.length,
    normalRoomItems: roomCounts.n_0_0,
    vaultItems: roomCounts.n_2_2,
    extractionItems: roomCounts.n_4_4,
    revealedAfterMs: 2200,
    inventoryAfterPickup: picked.inventory.length,
    finalVisitStatus: left.visit.status
  }, null, 2))
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
