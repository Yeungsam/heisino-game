const clone = value => value ? JSON.parse(JSON.stringify(value)) : null
const ROOMS = 'heisino_match_rooms'

function roomTransaction(readAccount, readRoom) {
  const accounts = new Map()
  const rooms = new Map()
  const accountWrites = new Map()
  const roomWrites = new Map()
  return {
    accounts, rooms, accountWrites, roomWrites,
    async account(id) {
      if (!accounts.has(id)) accounts.set(id, await readAccount(id))
      return clone(accountWrites.get(id) || accounts.get(id))
    },
    async room(id) {
      if (!rooms.has(id)) rooms.set(id, await readRoom(id))
      return clone(roomWrites.get(id) || rooms.get(id))
    },
    saveAccount(document) { accountWrites.set(document.accountId, document) },
    saveRoom(room) { roomWrites.set(room.roomId, room) }
  }
}

async function readDocument(collection, id) {
  try {
    const result = await collection.doc(id).get()
    const document = Array.isArray(result.data) ? result.data[0] : result.data
    if (!document) return null
    const clean = { ...document }
    delete clean._id
    return clean
  } catch (error) {
    if (/DOCUMENT_NOT_FOUND|not exist|not found/i.test(`${error.code} ${error.message}`)) return null
    throw error
  }
}

async function writeAccount(tx, collection, document, current) {
  const existingEntries = new Set((current && current.ledger || []).map(entry => entry.entryId))
  for (const entry of document.ledger) {
    if (!existingEntries.has(entry.entryId)) await tx.collection('heisino_asset_ledger').doc(entry.entryId).set(entry)
  }
  await tx.collection(collection).doc(document.accountId).set(document)
}

class MemoryAccountStore {
  constructor() { this.documents = new Map(); this.ledger = new Map(); this.rooms = new Map() }
  async get(id) { return clone(this.documents.get(id)) }
  async create(document) {
    if (this.documents.has(document.accountId)) return false
    document.ledger.forEach(entry => this.ledger.set(entry.entryId, clone(entry)))
    this.documents.set(document.accountId, clone(document))
    return true
  }
  async replace(document, version) {
    const current = this.documents.get(document.accountId)
    if (!current || current.version !== version) return false
    document.ledger.forEach(entry => this.ledger.set(entry.entryId, clone(entry)))
    this.documents.set(document.accountId, clone(document))
    return true
  }
  async listRooms(appId, now) {
    return [...this.rooms.values()].filter(room => room.appId === appId && room.listUntil > now).map(clone)
  }
  async transactRoom(callback) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const tx = roomTransaction(id => this.documents.get(id), id => this.rooms.get(id))
      const result = await callback(tx)
      if ([...tx.accounts].some(([id, original]) => this.documents.get(id) !== original) ||
          [...tx.rooms].some(([id, original]) => this.rooms.get(id) !== original)) continue
      for (const [id, document] of tx.accountWrites) {
        document.ledger.forEach(entry => this.ledger.set(entry.entryId, clone(entry)))
        this.documents.set(id, clone(document))
      }
      for (const [id, room] of tx.roomWrites) this.rooms.set(id, clone(room))
      return result
    }
    throw Object.assign(new Error('ACCOUNT_BUSY'), { code: 'ACCOUNT_BUSY', statusCode: 409 })
  }
}

class CloudAccountStore {
  constructor(options = {}) {
    const cloudbase = options.cloudbase || (!options.app && require('@cloudbase/node-sdk'))
    const app = options.app || cloudbase.init({
      env: process.env.CLOUDBASE_ENV_ID || process.env.SCF_NAMESPACE || cloudbase.SYMBOL_DEFAULT_ENV,
      accessKey: process.env.CLOUDBASE_APIKEY
    })
    this.db = app.database()
    this.collection = 'heisino_accounts'
    this.ready = null
  }
  async ensure() {
    if (!this.ready) this.ready = Promise.all([this.collection, 'heisino_asset_ledger', ROOMS].map(name => this.db.createCollection(name).catch(error => {
      if (!/DATABASE_COLLECTION_ALREADY_EXIST|ResourceUnavailable\.ResourceExist|(?:collection|table).*\bexist/i.test(`${error.code} ${error.message}`)) {
        this.ready = null
        throw error
      }
    })))
    await this.ready
  }
  async get(id) {
    await this.ensure()
    return readDocument(this.db.collection(this.collection), id)
  }
  async write(document, expectedVersion) {
    await this.ensure()
    return this.db.runTransaction(async tx => {
      const current = await readDocument(tx.collection(this.collection), document.accountId)
      if (expectedVersion === null ? !!current : !current || current.version !== expectedVersion) return false
      await writeAccount(tx, this.collection, document, current)
      return true
    })
  }
  async listRooms(appId, now) {
    await this.ensure()
    const query = this.db.collection(ROOMS).where({ listUntil: this.db.command.gt(now) })
      .field({ roomId: true, appId: true, name: true, status: true, createdAt: true, expiresAt: true, playerCount: true })
      .orderBy('listUntil', 'asc')
    const rooms = []
    for (let offset = 0; ; offset += 100) {
      const { data } = await query.skip(offset).limit(100).get()
      rooms.push(...data.filter(room => room.appId === appId))
      if (data.length < 100) return rooms
    }
  }
  async transactRoom(callback) {
    await this.ensure()
    return this.db.runTransaction(async transaction => {
      const tx = roomTransaction(
        id => readDocument(transaction.collection(this.collection), id),
        id => readDocument(transaction.collection(ROOMS), id)
      )
      const result = await callback(tx)
      for (const [id, document] of tx.accountWrites) await writeAccount(transaction, this.collection, document, tx.accounts.get(id))
      for (const [id, room] of tx.roomWrites) await transaction.collection(ROOMS).doc(id).set(room)
      return result
    })
  }
  async create(document) { return this.write(document, null) }
  async replace(document, version) { return this.write(document, version) }
}

module.exports = { MemoryAccountStore, CloudAccountStore }
