const config = require('../config')
const { isRetiredCard } = require('../core/retired-cards')
const { projectCard } = require('../core/card-projection')

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
          cards: response.data.cards.filter(card => !isRetiredCard(card.card_id)).map(projectCard)
        })
      },
      fail(error) {
        reject(error)
      }
    })
  })
}

module.exports = { fetchCardCatalog, projectCard }
