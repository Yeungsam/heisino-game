// Append only: retired card IDs remain reserved forever, including in history.
const RETIRED_CARD_IDS = Object.freeze(['sk_002', 'sk_003'])
const retiredIds = new Set(RETIRED_CARD_IDS)
const isRetiredCard = cardId => retiredIds.has(cardId)

function assertActiveCardIds(cardIds) {
  const seen = new Set()
  for (const id of cardIds) {
    if (isRetiredCard(id)) throw new Error(`Retired card ID cannot be reused: ${id}`)
    if (seen.has(id)) throw new Error(`Duplicate card ID: ${id}`)
    seen.add(id)
  }
}

function removeRetiredItems(state) {
  const removed = new Set(state.items.filter(item => isRetiredCard(item.cardId)).map(item => item.instanceId))
  if (!removed.size) return removed
  const keep = id => !removed.has(id)
  state.items = state.items.filter(item => keep(item.instanceId))
  for (const player of Object.values(state.players)) {
    player.inventory = player.inventory.filter(keep)
    if (removed.has(player.equippedWeaponId)) player.equippedWeaponId = null
  }
  for (const [playerId, access] of Object.entries(state.searchAccess || {})) {
    state.searchAccess[playerId] = access.filter(keep)
  }
  return removed
}

function removeRetiredObservationItems(visit, removed) {
  if (!visit?.observation || !removed.size) return
  for (const key of ['hiddenIds', 'visibleItemIds', 'newlyExposedItemIds']) {
    if (visit.observation[key]) visit.observation[key] = visit.observation[key].filter(id => !removed.has(id))
  }
}

module.exports = { RETIRED_CARD_IDS, isRetiredCard, assertActiveCardIds, removeRetiredItems, removeRetiredObservationItems }
