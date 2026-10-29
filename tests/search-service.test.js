const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { server } = require('../server')
const { matchRoute } = require('../functions/heisino-game/http-handler')

async function request(origin, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json', 'X-Request-Id': options.requestId || '' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  return { status: response.status, body: await response.json() }
}

test('搜索服务提供建局、进入房间、观察和权威背包接口', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const gameId = `api-search-${Date.now()}`

  const health = await request(origin, '/api/search/health')
  assert.equal(health.status, 200)
  assert.equal(health.body.service, 'heisino-search-service')
  assert.equal(health.body.schemaVersion, '2.0.0')

  const created = await request(origin, '/api/search/games', {
    method: 'POST',
    body: { gameId, playerId: 'P1', loadoutCardIds: ['wp_001'] }
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.data.player.inventory.length, 1)

  const visit = await request(origin, `/api/search/games/${gameId}/visits`, {
    method: 'POST',
    requestId: 'api-visit-1',
    body: { playerId: 'P1', roomNodeId: 'n_0_0', turn: 1 }
  })
  assert.equal(visit.status, 200)
  assert.equal(visit.body.data.room.unpickedCount, 4)

  const visitId = visit.body.data.visit.visitId
  const observed = await request(origin, `/api/search/games/${gameId}/visits/${visitId}/observe`, {
    method: 'POST',
    requestId: 'api-observe-1',
    body: { playerId: 'P1', areaId: visit.body.data.room.areas.find(area => area.itemCount > 0).areaId }
  })
  assert.equal(observed.status, 200)
  assert.equal(observed.body.data.visit.observation.active, true)
  assert.ok(observed.body.data.room.activeArea)
})

test('搜索路由同时兼容本地完整路径和 CloudBase 网关剥离路径', () => {
  assert.deepEqual(matchRoute('/api/search/health'), ['health'])
  assert.deepEqual(matchRoute('/health'), ['health'])
  assert.deepEqual(matchRoute('/api/search/games/game-1/visits'), ['games', 'game-1', 'visits'])
  assert.deepEqual(matchRoute('/games/game-1/visits'), ['games', 'game-1', 'visits'])
  assert.equal(matchRoute('/api/cards'), null)
})

test('CloudBase 部署配置不覆盖搜索函数密钥变量', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cloudbaserc.json'), 'utf8'))
  const searchFunction = config.functions.find(item => item.name === 'heisino-game')
  assert.ok(searchFunction)
  assert.equal(Object.hasOwn(searchFunction, 'envVariables'), false)
})
