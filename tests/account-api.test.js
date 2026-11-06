const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { networkFailure, formatDiagnostics } = require('../client/js/api/connection-diagnostics')

function client(perform) {
  const calls = []
  let wxLogins = 0
  const context = vm.createContext({ module: { exports: {} }, require: name => name === './connection-diagnostics'
    ? require('../client/js/api/connection-diagnostics') : ({ gameApiBaseUrl: 'https://example.test' }),
    wx: {
      getStorageSync: () => ({ token: 'old-wechat-user-token', expiresAt: Date.now() + 86400000 }), setStorageSync() {},
      login(options) { wxLogins += 1; options.success({ code: `new-code-${wxLogins}` }) },
      request(options) { calls.push(options); perform(options, calls.length) }
    }
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/js/api/account.js'), 'utf8'), context)
  return { api: context.module.exports, calls, loginCount: () => wxLogins }
}
function ok(options, data) { options.success({ statusCode: 200, data: { ok: true, data } }) }

test('真机验收配置启用合法域名校验，客户端不包含服务端密钥配置', () => {
  const project = JSON.parse(fs.readFileSync(path.join(__dirname, '../client/project.config.json'), 'utf8'))
  const config = require('../client/js/config')
  assert.equal(project.compileType, 'game')
  assert.equal(project.setting.urlCheck, true)
  assert.equal(new URL(config.gameApiBaseUrl).protocol, 'https:')
  assert.equal(new URL(config.cardAssetBaseUrl).protocol, 'https:')
  assert.equal(config.WX_APPSECRET, undefined)
  assert.equal(config.CLOUDBASE_APIKEY, undefined)
})

test('冷启动即使有缓存会话也验证当前微信身份，不能沿用上一用户仓库', async () => {
  const f = client(options => ok(options, { token: 'current-token', expiresAt: Date.now() + 100000, profile: { accountId: 'current-user' } }))
  const result = await f.api.login()
  assert.equal(f.loginCount(), 1)
  assert.equal(f.calls[0].url, 'https://example.test/api/account/login')
  assert.equal(f.calls[0].data.code, 'new-code-1')
  assert.equal(result.profile.accountId, 'current-user')
})

test('微信合法域名拦截返回明确错误，不伪装为普通断网重试', async () => {
  const f = client(options => options.fail({ errMsg: 'request:fail url not in domain list' }))
  await assert.rejects(f.api.login(), { code: 'DOMAIN_NOT_ALLOWED' })
  await assert.rejects(f.api.command('heartbeat'), { code: 'DOMAIN_NOT_ALLOWED' })
  assert.equal(f.calls.length, 2)
})

test('连接诊断区分白名单、TLS及一般域名错误，不保留任意SDK文本', () => {
  const domain = networkFailure({ errMsg: 'request:fail url not in domain list', errCode: 600001 }, 'https://example.test')
  assert.equal(domain.code, 'DOMAIN_NOT_ALLOWED')
  assert.equal(domain.diagnostic.errCode, 600001)
  assert.equal(networkFailure({ errMsg: 'request:fail url domain certificate error' }).code, 'NETWORK_ERROR')
  assert.match(networkFailure({ errMsg: 'request:fail ssl hand shake error' }).diagnostic.sdkMessage, /TLS\/SSL/)
  const error = networkFailure({ errMsg: 'request:fail unknown code=SECRET_CODE token=SECRET_TOKEN', headers: { Authorization: 'Bearer SECRET_TOKEN' } })
  assert.doesNotMatch(JSON.stringify(error), /SECRET|Authorization/)
})

test('诊断仅展示实际AppID、版本、固定构建标识和公共请求地址', () => {
  const error = networkFailure({ errMsg: 'request:fail url not in domain list' }, 'https://example.test')
  const text = formatDiagnostics(error, { getAccountInfoSync: () => ({ miniProgram: { appId: 'wxac0dd152fc261ffd', envVersion: 'develop' } }) }, 'https://example.test')
  assert.match(text, /wxac0dd152fc261ffd/)
  assert.match(text, /account-diag-20261103-1/)
  assert.match(text, /https:\/\/example.test\/api\/account\/login/)
  assert.match(text, /request:fail url not in domain list/)
  assert.match(formatDiagnostics(error, {}, 'https://example.test'), /AppID：不可读取/)
})

test('客户端网络重试复用同一请求ID与输入，不能重复开局扣仓', async () => {
  const f = client((options, count) => { if (count === 1) options.fail(); else ok(options, { saved: true }) })
  await f.api.command('start', { cardIds: ['wp_006'] })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[0].data, f.calls[1].data)
  assert.match(f.calls[0].data.requestId, /^req-/)
})

test('后台心跳超时4秒且不立即重试，避免占住操作队列36秒', async () => {
  const f = client(options => options.fail({ errMsg: 'request:fail timeout' }))
  await assert.rejects(f.api.command('heartbeat'), { code: 'NETWORK_ERROR' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].timeout, 4000)
})

test('过期会话重新微信登录后重发原操作，操作顺序保持串行', async () => {
  const f = client((options, count) => {
    if (count === 1) options.success({ statusCode: 401, data: { ok: false, error: 'UNAUTHENTICATED' } })
    else if (options.url.endsWith('/login')) ok(options, { token: 'refreshed-token', expiresAt: Date.now() + 100000 })
    else ok(options, { saved: true })
  })
  await Promise.all([f.api.command('game', { action: 'move' }), f.api.command('heartbeat')])
  assert.deepEqual(f.calls.map(call => call.url.split('/').pop()), ['game', 'login', 'game', 'heartbeat'])
  assert.deepEqual(f.calls[0].data, f.calls[2].data)
  assert.equal(f.calls[2].header.Authorization, 'Bearer refreshed-token')
})

test('接口性能采样只保留耗时和状态，区分客户端排队与服务端处理，不保留凭证', async () => {
  const f = client(options => options.success({ statusCode: 200, header: { 'Server-Timing': 'app;dur=42.5' }, data: { ok: true, data: {} } }))
  await f.api.command('game', { action: 'move', token: 'DO_NOT_LOG' })
  const samples = f.api.getPerformanceSamples()
  assert.equal(samples.length, 1)
  assert.equal(samples[0].serverMs, 42.5)
  assert.ok(samples[0].queueMs >= 0 && samples[0].requestMs >= 0)
  assert.doesNotMatch(JSON.stringify(samples), /DO_NOT_LOG|Authorization|Bearer|requestId/)
  samples[0].serverMs = 999
  assert.equal(f.api.getPerformanceSamples()[0].serverMs, 42.5)
})
