const test = require('node:test')
const assert = require('node:assert/strict')
const { CloudAccountStore } = require('../functions/heisino-account/store')

test('CloudBase 账号与新增资产流水在同一事务写入，旧版本不能覆盖', async () => {
  const committed = new Map()
  const db = {
    async createCollection() {},
    collection(name) { return { doc(id) { return { async get() { return { data: committed.get(`${name}/${id}`) || null } } } } } },
    async runTransaction(callback) {
      const writes = new Map()
      const result = await callback({ collection(name) { return { doc(id) {
        const key = `${name}/${id}`
        return { async get() { return { data: committed.get(key) || null } }, async set(data) { writes.set(key, structuredClone(data)) } }
      } } } })
      writes.forEach((data, key) => committed.set(key, data))
      return result
    }
  }
  const store = new CloudAccountStore({ app: { database: () => db } })
  const first = { accountId: 'account', version: 1, quantities: { wp_006: 1 }, ledger: [{ entryId: 'starter', type: 'STARTER' }] }
  assert.equal(await store.create(first), true)
  assert.equal(await store.create(first), false)
  assert.ok(committed.has('heisino_asset_ledger/starter'))
  const second = { ...first, version: 2, quantities: { wp_006: 0 }, ledger: first.ledger.concat({ entryId: 'deploy', type: 'DEPLOY' }) }
  assert.equal(await store.replace(second, 1), true)
  assert.ok(committed.has('heisino_asset_ledger/deploy'))
  assert.equal(await store.replace({ ...first, ledger: [{ entryId: 'bad' }] }, 1), false)
  assert.equal(committed.has('heisino_asset_ledger/bad'), false)
  assert.equal((await store.get('account')).quantities.wp_006, 0)
})

test('数据库不可用不能当作账号不存在而发放新手礼包', async () => {
  const store = new CloudAccountStore({ app: { database: () => ({
    async createCollection() {}, collection() { return { doc() { return { async get() { throw new Error('DATABASE_REQUEST_FAILED: service unavailable') } } } } }
  }) } })
  await assert.rejects(store.get('account'), /DATABASE_REQUEST_FAILED/)
})
