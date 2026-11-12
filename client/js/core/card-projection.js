function projectCard(card) {
  return {
    cardId: card.card_id,
    name: card.name,
    description: card.description,
    kind: card.kind,
    category: card.category,
    rarity: card.rarity,
    attackMultiplier: card.attack_multiplier,
    defenseMultiplier: card.defense_multiplier,
    value: card.economy.fixed_value ?? card.economy.purchase_price,
    assetPath: card.assets.card_art_path,
    ...(card.assets.card_art_url ? { assetUrl: card.assets.card_art_url } : {}),
    dataStatus: card.data_status
  }
}

module.exports = { projectCard }
