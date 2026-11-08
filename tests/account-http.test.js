const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { AccountService } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const { createAccountHandler } = require('../functions/heisino-account/http-handler')

test('账号 HTTP 链路包含登录、手动昵称、开局和结算，不能跨账号写资产', async t => {
  const service = new AccountService({ store: new MemoryAccountStore(), identity: {
    exchange: async code => ({ appId: 'wx-http-test', openid: code }), moderate: async () => true
  } })
  const handler = createAccountHandler(service)
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  async function request(path, data, token) {
    const response = await fetch(`${origin}${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
      body: data === undefined ? undefined : JSON.stringify(data) })
    return { status: response.status, serverTiming: response.headers.get('server-timing'), body: await response.json() }
  }
  assert.equal((await request('/api/account/me')).status, 401)
  const login = (await request('/api/account/login', { code: 'alice' })).body.data
  assert.equal(login.profile.profileComplete, false)
  const token = login.token
  const profile = await request('/profile', { nickname: '码头新人', avatarUrl: '' }, token)
  assert.equal(profile.status, 200)
  assert.match(profile.serverTiming, /^app;dur=\d+$/)
  assert.equal(profile.body.data.profile.nickname, '码头新人')
  const started = await request('/api/account/start', { cardIds: ['wp_006'], mode: 'SINGLE_TEST', requestId: 'http-start-001' }, token)
  assert.equal(started.status, 200)
  const game = started.body.data.activeGame
  const ended = await request('/game', { gameId: game.gameId, turn: 1, action: 'abandon', requestId: 'http-abandon-001' }, token)
  assert.equal(ended.body.data.lastSettlement.status, 'ABANDONED')
  assert.deepEqual(ended.body.data.profile.quantities, { wp_006: 0, ar_001: 1, sk_001: 1 })
  assert.equal((await request('/api/account/me', undefined, token)).body.data.activeGame, null)
})

test('账号网关拒绝非法 JSON、非对象和超大请求，并隐藏内部错误', async t => {
  let calls = 0
  const handler = createAccountHandler({
    async execute() {
      calls += 1
      throw new Error('internal database detail')
    }
  })
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}/api/account/game`
  const options = await fetch(endpoint, { method: 'OPTIONS' })
  assert.equal(options.status, 204)
  assert.equal(await options.text(), '')
  assert.equal((await fetch(endpoint)).status, 404)
  for (const [body, status, error] of [
    ['{', 400, 'INVALID_JSON'], ['null', 400, 'INVALID_JSON'], ['[]', 400, 'INVALID_JSON'],
    [JSON.stringify({ value: 'a'.repeat(8192) }), 413, 'PAYLOAD_TOO_LARGE']
  ]) {
    const response = await fetch(endpoint, { method: 'POST', body })
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { ok: false, error })
  }
  assert.equal(calls, 0)
  const failure = await fetch(endpoint, { method: 'POST', body: '{}' })
  assert.equal(failure.status, 500)
  assert.deepEqual(await failure.json(), { ok: false, error: 'INTERNAL_ERROR' })
  assert.equal(calls, 1)
})
