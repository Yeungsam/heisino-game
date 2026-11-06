const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { AccountService } = require('../functions/heisino-account/service')
const { MemoryAccountStore } = require('../functions/heisino-account/store')
const { createAccountHandler } = require('../functions/heisino-account/http-handler')

test('HTTP处理器内存链路验证业务计时头和资产事务，不依赖监听端口', async () => {
  const handler = createAccountHandler(new AccountService({ store: new MemoryAccountStore(), identity: {
    exchange: async () => ({ appId: 'timing-test', openid: 'timing-test' }), moderate: async () => true
  } }))
  async function call(action, body, token = '') {
    const request = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(request, { url: `/api/account/${action}`, method: 'POST', headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: 'test-only' } })
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(value) { this.body = JSON.parse(value) } }
    await handler(request, response)
    return response
  }
  const login = await call('login', { code: 'test-only' })
  const token = login.body.data.token
  assert.match(login.headers['Server-Timing'], /^app;dur=\d+$/)
  assert.equal(login.headers['Access-Control-Expose-Headers'], 'Server-Timing')
  assert.equal((await call('profile', { nickname: '性能回归', avatarUrl: '' }, token)).status, 200)
  const started = await call('start', { requestId: 'timing-start-001', cardIds: ['wp_006'], mode: 'SINGLE_TEST' }, token)
  assert.equal(started.status, 200)
  const game = started.body.data.activeGame
  const data = { requestId: 'timing-abandon-001', gameId: game.gameId, turn: game.state.turn, action: 'abandon' }
  const ended = await call('game', data, token)
  assert.equal(ended.status, 200)
  assert.equal(ended.body.data.lastSettlement.status, 'ABANDONED')
  assert.deepEqual(ended.body.data.profile.quantities, { wp_006: 0, ar_001: 1, sk_001: 1 })
  assert.doesNotMatch(ended.headers['Server-Timing'], /token|openid|timing-test/)
})
