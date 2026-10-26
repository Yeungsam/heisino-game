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
  let createCollectionCalls = 0
  const document = id => ({
    async get() {
      if (!records.has(id)) throw new Error('document not exist')
      return { data: [records.get(id)] }
    },
    async set(data) {
      records.set(id, data)
    }
  })
  const db = {
    async createCollection(name) {
      createCollectionCalls += 1
      assert.equal(name, 'heisino_search_games')
    },
    collection: () => ({ doc: document }),
    async runTransaction(callback) {
      return callback({ collection: () => ({ doc: document }) })
    }
  }
  const store = new CloudBaseSearchStore({ app: { database: () => db } })
  const game = { gameId: 'cloud-game', version: 1 }
  assert.equal(await store.create(game), true)
  assert.equal(await store.create(game), false)
  assert.equal(await store.replace({ ...game, version: 2 }, 1), true)
  assert.equal((await store.get(game.gameId)).version, 2)
  assert.equal(createCollectionCalls, 1)
})

test('CloudBase 集合已存在时初始化保持幂等', async () => {
  const db = {
    async createCollection() {
      const error = new Error('collection already exists')
      error.code = 'DATABASE_COLLECTION_ALREADY_EXIST'
      throw error
    },
    collection: () => ({ doc: () => ({ async get() { return { data: [] } } }) })
  }
  const store = new CloudBaseSearchStore({ app: { database: () => db } })
  assert.equal(await store.get('missing-game'), null)
})

test('CloudBase 生产环境 Table exist 错误同样视为幂等成功', async () => {
  const db = {
    async createCollection() {
      const error = new Error('[CreateTable] Table exist. Please check your request')
      error.code = 'ResourceUnavailable.ResourceExist'
      throw error
    },
    collection: () => ({ doc: () => ({ async get() { return { data: [] } } }) })
  }
  const store = new CloudBaseSearchStore({ app: { database: () => db } })
  assert.equal(await store.get('missing-game'), null)
})

test('CloudBase 兼容并解包旧版 data 嵌套对局文档', async () => {
  const db = {
    async createCollection() {},
    collection: () => ({ doc: () => ({ async get() { return { data: [{ _id: 'legacy-game', data: { gameId: 'legacy-game', version: 3 } }] } } }) })
  }
  const store = new CloudBaseSearchStore({ app: { database: () => db } })
  assert.deepEqual(await store.get('legacy-game'), { gameId: 'legacy-game', version: 3 })
})
