const config = require('../config')

function projectCard(card) {
  return {
    cardId: card.card_id,
    name: card.name,
    description: card.description,
    kind: card.kind,
    category: card.category,
    rarity: card.rarity,
    attackMultiplier: card.attack_multiplier,
    defenseMultiplier: card.defense_multiplier,
    value: card.economy.fixed_value ?? card.economy.purchase_price,
    maxDurability: card.durability.max,
    assetPath: card.assets.card_art_path,
    assetUrl: card.assets.card_art_url,
    dataStatus: card.data_status
  }
}

function fetchCardCatalog(options = {}) {
  const baseUrl = options.baseUrl || config.cardApiBaseUrl
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}/api/cards`,
      method: 'GET',
      timeout: 10000,
      success(response) {
        if (response.statusCode !== 200 || !response.data || !Array.isArray(response.data.cards)) {
          reject(new Error(`CARD_API_${response.statusCode || 'INVALID'}`))
          return
        }
        resolve({
          schemaVersion: response.data.schema_version,
          generatedAt: response.data.generated_at,
          cards: response.data.cards.map(projectCard)
        })
      },
      fail(error) {
        reject(error)
      }
    })
  })
}

module.exports = { fetchCardCatalog, projectCard }
