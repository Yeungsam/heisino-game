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

test('CloudBase 多人事务遇到房间写入失败时保留所有人的库存和流水', async () => {
  const players = ['host', 'guest']
  const committed = new Map(players.map(accountId => [
    `heisino_accounts/${accountId}`, { accountId, version: 1, quantities: { wp_006: 1 }, ledger: [] }
  ]))
  const roomKey = 'heisino_match_rooms/room'
  committed.set(roomKey, { roomId: 'room', status: 'WAITING' })
  let failRoomWrite = true
  const db = {
    async createCollection() {},
    async runTransaction(callback) {
      const pending = new Map()
      const result = await callback({ collection(name) { return { doc(id) {
        const key = `${name}/${id}`
        return {
          async get() { return { data: [committed.get(key)].filter(Boolean) } },
          async set(document) {
            if (key === roomKey && failRoomWrite) throw new Error('room write failed')
            pending.set(key, structuredClone(document))
          }
        }
      } } } })
      for (const [key, value] of pending) committed.set(key, value)
      return result
    }
  }
  const store = new CloudAccountStore({ app: { database: () => db } })
  const launch = () => store.transactRoom(async tx => {
    const room = await tx.room('room')
    for (const id of players) {
      const account = await tx.account(id)
      account.quantities.wp_006 -= 1
      account.ledger.push({ entryId: `deploy-${id}`, type: 'DEPLOY' })
      account.version += 1
      tx.saveAccount(account)
    }
    tx.saveRoom({ ...room, status: 'PLAYING' })
  })
  await assert.rejects(launch(), /room write failed/)
  assert.equal(committed.get(roomKey).status, 'WAITING')
  assert.equal(committed.size, 3)
  assert.ok(players.every(id => committed.get(`heisino_accounts/${id}`).quantities.wp_006 === 1))
  failRoomWrite = false
  await launch()
  assert.equal(committed.get(roomKey).status, 'PLAYING')
  assert.ok(players.every(id => committed.get(`heisino_accounts/${id}`).quantities.wp_006 === 0 &&
    committed.has(`heisino_asset_ledger/deploy-${id}`)))
})

test('CloudBase 房间查询跨页过滤过期房间与其他小游戏的房间', async () => {
  const rooms = Array.from({ length: 205 }, (_, index) => ({
    roomId: `room-${index}`, appId: index % 2 ? 'one' : 'two', listUntil: index + 10
  }))
  const offsets = []
  const db = {
    async createCollection() {},
    command: { gt: value => value },
    collection(name) {
      assert.equal(name, 'heisino_match_rooms')
      let after, offset, limit
      const query = {
        where({ listUntil }) { after = listUntil; return this },
        field(fields) { assert.equal(fields.roomId, true); assert.equal(fields.members, undefined); return this },
        orderBy(field, direction) { assert.deepEqual([field, direction], ['listUntil', 'asc']); return this },
        skip(value) { offset = value; return this },
        limit(value) { limit = value; return this },
        async get() { offsets.push(offset); return { data: rooms.filter(room => room.listUntil > after).slice(offset, offset + limit) } }
      }
      return query
    }
  }
  const store = new CloudAccountStore({ app: { database: () => db } })
  assert.deepEqual(await store.listRooms('one', 12), rooms.filter(room => room.appId === 'one' && room.listUntil > 12))
  assert.deepEqual(offsets, [0, 100, 200])
})
