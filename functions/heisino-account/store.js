const clone = value => value ? JSON.parse(JSON.stringify(value)) : null

class MemoryAccountStore {
  constructor() { this.documents = new Map(); this.ledger = new Map() }
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
    if (!this.ready) this.ready = Promise.all([this.collection, 'heisino_asset_ledger'].map(name => this.db.createCollection(name).catch(error => {
      if (!/DATABASE_COLLECTION_ALREADY_EXIST|ResourceUnavailable\.ResourceExist|(?:collection|table).*\bexist/i.test(`${error.code} ${error.message}`)) {
        this.ready = null
        throw error
      }
    })))
    await this.ready
  }
  async get(id) {
    await this.ensure()
    try {
      const result = await this.db.collection(this.collection).doc(id).get()
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
  async write(document, expectedVersion) {
    await this.ensure()
    return this.db.runTransaction(async tx => {
      const ref = tx.collection(this.collection).doc(document.accountId)
      let current = null
      try {
        const result = await ref.get()
        current = Array.isArray(result.data) ? result.data[0] : result.data
      } catch (error) {
        if (!/DOCUMENT_NOT_FOUND|not exist|not found/i.test(`${error.code} ${error.message}`)) throw error
      }
      if (expectedVersion === null ? !!current : !current || current.version !== expectedVersion) return false
      const existingEntries = new Set((current && current.ledger || []).map(entry => entry.entryId))
      for (const entry of document.ledger) {
        if (!existingEntries.has(entry.entryId)) await tx.collection('heisino_asset_ledger').doc(entry.entryId).set(entry)
      }
      await ref.set(document)
      return true
    })
  }
  async create(document) { return this.write(document, null) }
  async replace(document, version) { return this.write(document, version) }
}

module.exports = { MemoryAccountStore, CloudAccountStore }
