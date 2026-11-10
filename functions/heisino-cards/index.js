const http = require('node:http')
const catalog = require('./cards.json')

const assetOrigin = process.env.CARD_ASSET_ORIGIN || 'https://cloud1-d5ghcmrajdca722b5-1510428576.tcloudbaseapp.com'
const port = Number(process.env.PORT || process.env.SCF_PORT || 9000)

function apiCard(card) {
  return {
    ...card,
    assets: {
      ...card.assets,
      card_art_url: `${assetOrigin}${card.assets.card_art_path}`
    }
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': statusCode === 200 ? 'public, max-age=60' : 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(statusCode === 204 ? '' : JSON.stringify(payload))
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    return
  }

  const url = new URL(request.url, 'http://localhost')
  if (url.pathname.endsWith('/health')) {
    sendJson(response, 200, { ok: true, service: 'heisino-card-service' })
    return
  }

  const detail = url.pathname.match(/\/api\/cards\/(.+)$/)
  if (detail) {
    let cardId
    try {
      cardId = decodeURIComponent(detail[1])
    } catch {
      sendJson(response, 400, { error: 'INVALID_CARD_ID' })
      return
    }
    const card = catalog.cards.find(candidate => candidate.card_id === cardId)
    sendJson(response, card ? 200 : 404, card ? apiCard(card) : { error: 'CARD_NOT_FOUND' })
    return
  }

  const category = url.searchParams.get('category')?.toUpperCase()
  const cards = category
    ? catalog.cards.filter(card => card.category === category)
    : catalog.cards

  sendJson(response, 200, {
    schema_version: catalog.schema_version,
    generated_at: catalog.generated_at,
    total: cards.length,
    cards: cards.map(apiCard)
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Heisino card function listening on ${port}`)
})

module.exports = { server, apiCard }
