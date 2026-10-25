function trimTrailingSlash(value = '') {
  return value.replace(/\/+$/, '')
}

function ensureLeadingSlash(value = '') {
  return value.startsWith('/') ? value : `/${value}`
}

function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value)
}

function resolveCardAssetUrl(card, assetBaseUrl) {
  if (!card) return null
  if (isHttpsUrl(card.assetUrl)) return card.assetUrl
  if (!card.assetPath || !assetBaseUrl) return null
  return `${trimTrailingSlash(assetBaseUrl)}${ensureLeadingSlash(card.assetPath)}`
}

function createCardCatalogIndex(cards = []) {
  return cards.reduce((index, card) => {
    if (card && card.cardId) index[card.cardId] = card
    return index
  }, Object.create(null))
}

module.exports = {
  createCardCatalogIndex,
  isHttpsUrl,
  resolveCardAssetUrl
}
