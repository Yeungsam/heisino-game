class CloudBaseSearchStore {
  constructor(options = {}) {
    if (options.app) this.app = options.app
    else {
      const cloudbase = options.cloudbase || require('@cloudbase/node-sdk')
      const initOptions = {
        env: options.envId || process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || process.env.SCF_NAMESPACE || cloudbase.SYMBOL_DEFAULT_ENV
      }
      const accessKey = options.accessKey || process.env.CLOUDBASE_APIKEY
      const secretId = options.secretId || process.env.TENCENTCLOUD_SECRETID
      const secretKey = options.secretKey || process.env.TENCENTCLOUD_SECRETKEY
      if (accessKey) initOptions.accessKey = accessKey
      else if (secretId && secretKey) {
        initOptions.secretId = secretId
        initOptions.secretKey = secretKey
      }
      this.app = cloudbase.init(initOptions)
    }
    this.db = this.app.database()
    this.collectionName = options.collectionName || process.env.SEARCH_GAME_COLLECTION || 'heisino_search_games'
    this.collectionReady = null
  }

  isCollectionAlreadyExists(storeError) {
    const detail = `${storeError && storeError.code || ''} ${storeError && storeError.message || ''}`
    return /DATABASE_COLLECTION_ALREADY_EXIST|ResourceUnavailable\.ResourceExist|(?:collection|table).*\bexist/i.test(detail)
  }

  async ensureCollection() {
    if (!this.collectionReady) {
      this.collectionReady = this.db.createCollection(this.collectionName).catch(storeError => {
        if (this.isCollectionAlreadyExists(storeError)) return null
        this.collectionReady = null
        throw storeError
      })
    }
    await this.collectionReady
  }

  document(transaction, gameId) {
    return transaction.collection(this.collectionName).doc(gameId)
  }

  clean(data) {
    const document = Array.isArray(data) ? data[0] : data
    if (!document) return null
    const payload = !document.gameId && document.data && typeof document.data === 'object' ? document.data : document
    const game = { ...payload }
    delete game._id
    return game
  }

  async get(gameId) {
    await this.ensureCollection()
    try {
      const result = await this.db.collection(this.collectionName).doc(gameId).get()
      return this.clean(result.data)
    } catch (storeError) {
      if (/not exist|not found|DATABASE_REQUEST_FAILED/i.test(storeError.message || '')) return null
      throw storeError
    }
  }

  async create(game) {
    await this.ensureCollection()
    return this.db.runTransaction(async transaction => {
      const reference = this.document(transaction, game.gameId)
      try {
        const existing = await reference.get()
        if (this.clean(existing && existing.data)) return false
      } catch (storeError) {
        if (!/not exist|not found|DATABASE_REQUEST_FAILED/i.test(storeError.message || '')) throw storeError
      }
      await reference.set(this.clean(game))
      return true
    })
  }

  async replace(game, expectedVersion) {
    await this.ensureCollection()
    return this.db.runTransaction(async transaction => {
      const reference = this.document(transaction, game.gameId)
      const existing = await reference.get()
      const current = this.clean(existing && existing.data)
      if (!current || current.version !== expectedVersion) return false
      await reference.set(this.clean(game))
      return true
    })
  }
}

module.exports = { CloudBaseSearchStore }
