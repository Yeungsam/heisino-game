// The movement map and server loot rules use the same coordinates, indexed [y][x].
const ROOM_TYPES = Object.freeze([
  Object.freeze(['SPAWN', 'LOUNGE', 'SECURITY', 'STORAGE', 'SPAWN']),
  Object.freeze(['LOUNGE', 'MEDICAL', 'LOUNGE', 'SECURITY', 'MEDICAL']),
  Object.freeze(['SECURITY', 'LOUNGE', 'VAULT', 'STORAGE', 'LOUNGE']),
  Object.freeze(['MEDICAL', 'SECURITY', 'STORAGE', 'MEDICAL', 'SECURITY']),
  Object.freeze(['SPAWN', 'STORAGE', 'MEDICAL', 'LOUNGE', 'EXIT'])
])

function roomKeyAt(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null
  return ROOM_TYPES[y]?.[x] || null
}

function roomKeyForNode(nodeId) {
  const coordinates = /^n_(\d+)_(\d+)$/.exec(nodeId)
  return coordinates ? roomKeyAt(Number(coordinates[1]), Number(coordinates[2])) : null
}

module.exports = { ROOM_TYPES, roomKeyAt, roomKeyForNode }
