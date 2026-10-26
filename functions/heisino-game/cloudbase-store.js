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
  }

  document(transaction, gameId) {
    return transaction.collection(this.collectionName).doc(gameId)
  }

  clean(data) {
    if (!data) return null
    const game = { ...data }
    delete game._id
    return game
  }

  async get(gameId) {
    try {
      const result = await this.db.collection(this.collectionName).doc(gameId).get()
      return this.clean(result.data)
    } catch (storeError) {
      if (/not exist|not found|DATABASE_REQUEST_FAILED/i.test(storeError.message || '')) return null
      throw storeError
    }
  }

  async create(game) {
    const result = await this.db.runTransaction(async transaction => {
      const reference = this.document(transaction, game.gameId)
      try {
        const existing = await reference.get()
        if (existing && existing.data) return false
      } catch (storeError) {
        if (!/not exist|not found|DATABASE_REQUEST_FAILED/i.test(storeError.message || '')) throw storeError
      }
      await reference.set({ data: this.clean(game) })
      return true
    })
    return result.result
  }

  async replace(game, expectedVersion) {
    const result = await this.db.runTransaction(async transaction => {
      const reference = this.document(transaction, game.gameId)
      const existing = await reference.get()
      if (!existing || !existing.data || existing.data.version !== expectedVersion) return false
      await reference.set({ data: this.clean(game) })
      return true
    })
    return result.result
  }
}

module.exports = { CloudBaseSearchStore }
