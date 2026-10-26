const http = require('node:http')
const cards = require('./catalog')
const { SearchGameService, MemorySearchStore } = require('./search-domain')
const { CloudBaseSearchStore } = require('./cloudbase-store')
const { createSearchHttpHandler, sendJson } = require('./http-handler')

const port = Number(process.env.PORT || process.env.SCF_PORT || 9000)

function createStore() {
  if (process.env.NODE_ENV === 'test' || process.env.SEARCH_STORE === 'memory') return new MemorySearchStore()
  return new CloudBaseSearchStore()
}

const service = new SearchGameService({ cards, store: createStore() })
const handleSearchRequest = createSearchHttpHandler(service)
const server = http.createServer(async (request, response) => {
  const handled = await handleSearchRequest(request, response)
  if (!handled) sendJson(response, 404, { ok: false, error: 'NOT_FOUND' })
})

if (require.main === module) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`Heisino search function listening on ${port}`)
  })
}

module.exports = { server, service }
