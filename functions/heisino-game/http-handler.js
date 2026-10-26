function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(statusCode === 204 ? '' : JSON.stringify(payload))
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE', statusCode: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (parseError) {
        reject(Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON', statusCode: 400 }))
      }
    })
    request.on('error', reject)
  })
}

function requestId(request, body) {
  return request.headers['x-request-id'] || body.requestId || null
}

function matchRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  const apiIndex = parts.findIndex(part => part === 'search')
  if (apiIndex < 0) return null
  return parts.slice(apiIndex + 1)
}

function createSearchHttpHandler(service) {
  return async function handleSearchRequest(request, response, suppliedUrl) {
    const url = suppliedUrl || new URL(request.url, 'http://localhost')
    const route = matchRoute(url.pathname)
    if (!route) return false

    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {})
      return true
    }

    try {
      if (request.method === 'GET' && route.length === 1 && route[0] === 'health') {
        sendJson(response, 200, { ok: true, service: 'heisino-search-service', schemaVersion: '1.0.0' })
        return true
      }

      const body = request.method === 'POST' ? await readJson(request) : {}
      let result = null
      if (request.method === 'POST' && route.length === 1 && route[0] === 'games') {
        result = await service.createGame(body)
      } else if (route[0] === 'games' && route[1]) {
        const gameId = decodeURIComponent(route[1])
        if (request.method === 'POST' && route[2] === 'visits' && route.length === 3) {
          result = await service.startVisit({ ...body, gameId, requestId: requestId(request, body) })
        } else if (route[2] === 'visits' && route[3]) {
          const visitId = decodeURIComponent(route[3])
          const action = route[4]
          const base = { ...body, gameId, visitId, requestId: requestId(request, body) }
          if (request.method === 'GET' && route.length === 4) {
            result = await service.getVisit({ gameId, visitId, playerId: url.searchParams.get('playerId') })
          } else if (request.method === 'POST' && action === 'observe') result = await service.observe(base)
          else if (request.method === 'POST' && action === 'pickup') result = await service.pickup(base)
          else if (request.method === 'POST' && action === 'drop') result = await service.drop(base)
          else if (request.method === 'POST' && action === 'finish-observation') result = await service.finishObservation(base)
          else if (request.method === 'POST' && action === 'leave') result = await service.leave(base)
        }
      }

      if (!result) {
        sendJson(response, 404, { ok: false, error: 'NOT_FOUND' })
        return true
      }
      sendJson(response, 200, { ok: true, data: result })
      return true
    } catch (requestError) {
      sendJson(response, requestError.statusCode || 500, {
        ok: false,
        error: requestError.code || 'INTERNAL_ERROR'
      })
      return true
    }
  }
}

module.exports = { createSearchHttpHandler, sendJson, readJson, matchRoute }
