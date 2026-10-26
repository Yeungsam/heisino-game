const test = require('node:test')
const assert = require('node:assert/strict')
const { CloudBaseSearchStore } = require('../functions/heisino-game/cloudbase-store')

test('CloudBase Web 云函数优先使用 API Key 初始化数据库客户端', () => {
  let receivedOptions = null
  const cloudbase = {
    SYMBOL_DEFAULT_ENV: Symbol('default-env'),
    init(options) {
      receivedOptions = options
      return { database: () => ({}) }
    }
  }
  new CloudBaseSearchStore({ cloudbase, envId: 'env-test', accessKey: 'masked-api-key' })
  assert.deepEqual(receivedOptions, { env: 'env-test', accessKey: 'masked-api-key' })
})

test('CloudBase 持久化写入返回事务回调结果', async () => {
  const records = new Map()
  const document = id => ({
    async get() {
      if (!records.has(id)) throw new Error('document not exist')
      return { data: records.get(id) }
    },
    async set({ data }) {
      records.set(id, data)
    }
  })
  const db = {
    collection: () => ({ doc: document }),
    async runTransaction(callback) {
      const result = await callback({ collection: () => ({ doc: document }) })
      return { result, errMsg: 'runTransaction:ok' }
    }
  }
  const store = new CloudBaseSearchStore({ app: { database: () => db } })
  const game = { gameId: 'cloud-game', version: 1 }
  assert.equal(await store.create(game), true)
  assert.equal(await store.create(game), false)
  assert.equal(await store.replace({ ...game, version: 2 }, 1), true)
  assert.equal((await store.get(game.gameId)).version, 2)
})
