function formatAmount(value) {
  if (!Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  const unit = [[1e9, 'b'], [1e6, 'm'], [1e3, 'k']].find(([base]) => magnitude >= base)
  if (!unit) return String(value)
  const [base, suffix] = unit
  return `${Number((value / base).toFixed(2))}${suffix}`
}

function formatChange(value) {
  return `${value > 0 ? '+' : ''}${formatAmount(value)}`
}

module.exports = { formatAmount, formatChange }
