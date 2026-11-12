const assert = require('node:assert/strict')
const { createHash, randomBytes, randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { gameApiBaseUrl } = require('../client/js/config')
const { envId } = require('../cloudbaserc.json')

const appId = `shop-smoke-${randomUUID()}`
const hash = value => createHash('sha256').update(value).digest('hex')
const accountId = hash(appId)
const token = `${accountId}.${randomBytes(32).toString('base64url')}`
const accounts = 'heisino_accounts'
const ledger = 'heisino_asset_ledger'
const scope = [[ledger, { accountId }], [accounts, { _id: accountId, appId }]]
const path = `${gameApiBaseUrl}/api/account`

function cli(args) {
  const raw = execFileSync('tcb', [...args, '-e', envId, '--json'], {
    encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  assert.ok(output.data && !output.error, 'CloudBase 验收请求失败')
  return output.data
}

function command(collection, type, body) {
  return { TableName: collection, CommandType: type, Command: JSON.stringify(body) }
}

function db(operations) {
  return cli(['db', 'nosql', 'execute', '--command', JSON.stringify(operations)]).results.map(
    result => typeof result === 'string' ? JSON.parse(result) : result)
}

async function call(action, input, status = 200, expectedError, bearer = token) {
  const response = await fetch(`${path}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(input), signal: AbortSignal.timeout(12000)
  })
  const payload = await response.json()
  assert.equal(response.status, status, `${action} ${input.op || input.action || ''}: ${payload.error || 'OK'}`)
  if (expectedError) assert.equal(payload.error, expectedError)
  return payload.data
}

async function verify() {
  const list = await call('shop', { op: 'list' })
  assert.equal(list.catalog.length, 51)
  assert.equal(list.catalog.filter(card => card.buyPrice !== null).length, 16)
  assert.deepEqual(list.catalog.find(card => card.cardId === 'ar_013'), { cardId: 'ar_013', grade: 'A', sellPrice: 1, buyPrice: null })
  assert.equal(list.profile.assetValue, 31601)
  const order = { op: 'sell', requestId: randomUUID(), cardId: 'loot_002', quantity: 1, unitPrice: 30000 }
  const sale = await call('shop', order)
  assert.equal(sale.profile.gold, 30000)
  assert.equal(sale.profile.assetValue, list.profile.assetValue)
  assert.equal(sale.profile.quantities.loot_002, 0)
  assert.deepEqual((await call('shop', order)).trade, sale.trade)
  await call('shop', { ...order, quantity: 2 }, 409, 'REQUEST_ID_REUSED')
  await call('shop', { ...order, op: 'buy', cardId: 'ar_013', unitPrice: 1, requestId: randomUUID() }, 409, 'CARD_NOT_FOR_SALE')
  const buy = { op: 'buy', cardId: 'sk_008', quantity: 2, unitPrice: 960, requestId: randomUUID() }
  await call('shop', { ...buy, unitPrice: 800 }, 409, 'SHOP_PRICE_CHANGED')
  const receipt = await call('shop', buy)
  assert.equal(receipt.profile.gold, 28080)
  assert.equal(receipt.profile.quantities.sk_008, 2)
  assert.equal(receipt.profile.assetValue, 31281)
  const soldShield = await call('shop', { ...order, cardId: 'ar_013', unitPrice: 1, requestId: randomUUID() })
  assert.equal(soldShield.profile.gold, 28081)
  const started = await call('start', { requestId: randomUUID(), cardIds: ['wp_006', 'ar_006', 'sk_008'], mode: 'SINGLE', combatVersion: 1 })
  assert.equal(started.profile.assetValue, 28881)
  assert.deepEqual(started.activeGame.backpackAssets, { initial: 2400, current: 2400, change: 0 })
  const resumed = await call('resume', {})
  assert.deepEqual(resumed.activeGame.backpackAssets, started.activeGame.backpackAssets)
  await call('shop', { ...buy, requestId: randomUUID() }, 409, 'ACTIVE_GAME_EXISTS')
  const [entries] = db([command(ledger, 'QUERY', { find: ledger, filter: { accountId }, projection: { _id: 1, type: 1, goldDelta: 1 }, limit: 20 })])
  assert.deepEqual(entries.filter(entry => entry.type.startsWith('SHOP_')).map(entry => entry.goldDelta).sort((a, b) => a - b), [-1920, 1, 30000])
  console.log('公网商店：货架与价格、售出、批量购买、重复请求、旧报价和守卫盾禁购均通过；开局与恢复估值正确，交易流水只落一次。')
}

async function main() {
  const options = await fetch(`${path}/shop`, { method: 'OPTIONS', signal: AbortSignal.timeout(12000) })
  assert.equal(options.status, 204)
  await call('shop', { op: 'list' }, 401, 'UNAUTHENTICATED', '')
  for (const collection of [accounts, ledger]) {
    const response = cli(['api', 'tcb', 'DescribeDatabaseACL', '--api-version', '2018-06-08',
      '--body', JSON.stringify({ EnvId: envId, CollectionName: collection })])
    assert.equal((response.Response || response).AclTag, 'ADMINONLY', collection)
  }
  console.log('商店预检 204、匿名 401；账号与资产流水集合为 ADMINONLY。')
  const now = Date.now()
  const fixture = { _id: accountId, accountId, appId, openid: appId, version: 1, nickname: '商店验收',
    avatarUrl: '', profileComplete: true, gold: 0, quantities: { loot_002: 1, ar_013: 1, wp_006: 1, ar_006: 1 },
    starterVersion: 1, createdAt: now, sessions: [{ hash: hash(token), expiresAt: now + 300000 }],
    activeGame: null, lastSettlement: null, ledger: [], startRequests: [] }
  try {
    db([command(accounts, 'INSERT', { insert: accounts, documents: [fixture] })])
    await verify()
  } finally {
    db(scope.map(([collection, filter]) => command(collection, 'DELETE', {
      delete: collection, deletes: [{ q: filter, limit: 0 }]
    })))
    const remaining = db(scope.map(([collection, filter]) => command(collection, 'QUERY', {
      find: collection, filter, projection: { _id: 1 }, limit: 1
    })))
    assert.ok(remaining.every(rows => Array.isArray(rows) && rows.length === 0))
    console.log('隔离验收账号与流水已清理并复查。')
  }
}

main().catch(error => {
  console.error(`线上商店验收失败：${error.status !== undefined ? 'CloudBase CLI 调用失败' : error.message}`)
  process.exitCode = 1
})
