const config = require('../config')

function requestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`
}

function request(path, options = {}) {
  const baseUrl = options.baseUrl || config.gameApiBaseUrl
  const method = options.method || 'GET'
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}${path}`,
      method,
      timeout: options.timeout || 10000,
      header: {
        'Content-Type': 'application/json',
        'X-Request-Id': options.requestId || ''
      },
      data: options.data,
      success(response) {
        if (response.statusCode !== 200 || !response.data || response.data.ok !== true) {
          const requestError = new Error((response.data && response.data.error) || `SEARCH_API_${response.statusCode || 'INVALID'}`)
          requestError.code = (response.data && response.data.error) || 'SEARCH_API_ERROR'
          requestError.statusCode = response.statusCode
          reject(requestError)
          return
        }
        resolve(response.data.data)
      },
      fail(error) {
        error.code = error.code || 'SEARCH_API_UNAVAILABLE'
        reject(error)
      }
    })
  })
}

function createSearchGame(input, options = {}) {
  return request('/api/search/games', { ...options, method: 'POST', data: input, requestId: requestId('create-game') })
}

function startSearchVisit(input, options = {}) {
  return request(`/api/search/games/${encodeURIComponent(input.gameId)}/visits`, {
    ...options,
    method: 'POST',
    data: input,
    requestId: input.requestId || requestId('start-visit')
  })
}

function getSearchVisit(input, options = {}) {
  return request(`/api/search/games/${encodeURIComponent(input.gameId)}/visits/${encodeURIComponent(input.visitId)}?playerId=${encodeURIComponent(input.playerId)}`, options)
}

function visitAction(action, input, options = {}) {
  return request(`/api/search/games/${encodeURIComponent(input.gameId)}/visits/${encodeURIComponent(input.visitId)}/${action}`, {
    ...options,
    method: 'POST',
    data: input,
    requestId: input.requestId || requestId(action)
  })
}

module.exports = {
  requestId,
  createSearchGame,
  startSearchVisit,
  getSearchVisit,
  observeSearch: (input, options) => visitAction('observe', input, options),
  pickupSearchItem: (input, options) => visitAction('pickup', input, options),
  dropSearchItem: (input, options) => visitAction('drop', input, options),
  finishSearchObservation: (input, options) => visitAction('finish-observation', input, options),
  leaveSearchRoom: (input, options) => visitAction('leave', input, options)
}
