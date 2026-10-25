const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const publicRoot = path.join(__dirname, 'public')
const catalogPath = path.join(root, 'data', 'cards.json')
const port = Number(process.env.PORT || 3000)

function readCatalog() {
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
}

function originFor(request) {
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const protocol = forwardedProtocol || (request.socket.encrypted ? 'https' : 'http')
  return `${protocol}://${request.headers.host}`
}

function apiCard(card, origin) {
  return {
    ...card,
    assets: {
      ...card.assets,
      card_art_url: `${origin}${card.assets.card_art_path}`
    }
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': statusCode === 200 ? 'public, max-age=60' : 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify(payload))
}

function serveAsset(response, pathname) {
  const relativePath = pathname.replace(/^\/assets\//, '')
  const filePath = path.resolve(publicRoot, 'assets', relativePath)
  const allowedRoot = path.resolve(publicRoot, 'assets') + path.sep
  if (!filePath.startsWith(allowedRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(response, 404, { error: 'ASSET_NOT_FOUND' })
    return
  }
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': filePath.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream'
  })
  fs.createReadStream(filePath).pipe(response)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, originFor(request))
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    response.end()
    return
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'heisino-card-service' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/cards') {
    const catalog = readCatalog()
    const category = url.searchParams.get('category')
    const cards = category
      ? catalog.cards.filter(card => card.category === category.toUpperCase())
      : catalog.cards
    sendJson(response, 200, {
      schema_version: catalog.schema_version,
      generated_at: catalog.generated_at,
      total: cards.length,
      cards: cards.map(card => apiCard(card, originFor(request)))
    })
    return
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/cards/')) {
    const cardId = decodeURIComponent(url.pathname.slice('/api/cards/'.length))
    const card = readCatalog().cards.find(candidate => candidate.card_id === cardId)
    if (!card) {
      sendJson(response, 404, { error: 'CARD_NOT_FOUND' })
      return
    }
    sendJson(response, 200, apiCard(card, originFor(request)))
    return
  }

  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
    serveAsset(response, url.pathname)
    return
  }

  sendJson(response, 404, { error: 'NOT_FOUND' })
})

if (require.main === module) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`Heisino card service listening on http://0.0.0.0:${port}`)
  })
}

module.exports = { server, apiCard }
