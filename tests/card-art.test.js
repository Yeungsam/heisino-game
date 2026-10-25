const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const cards = require('../client/data/cards')
const config = require('../client/js/config')
const { createCardCatalogIndex, resolveCardAssetUrl } = require('../client/js/ui/card-art')

const root = path.join(__dirname, '..')
const sourceCards = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cards.json'), 'utf8')).cards

test('卡牌 API 与静态资源使用独立且明确的 HTTPS 域名', () => {
  assert.match(config.cardApiBaseUrl, /^https:\/\//)
  assert.match(config.cardAssetBaseUrl, /^https:\/\//)
  assert.notEqual(new URL(config.cardApiBaseUrl).host, new URL(config.cardAssetBaseUrl).host)
})

test('服务端绝对卡面地址优先，本地目录降级到静态资源域名', () => {
  const card = cards[0]
  const serverUrl = 'https://cdn.example.com/cards/example.jpg'
  assert.equal(resolveCardAssetUrl({ ...card, assetUrl: serverUrl }, config.cardAssetBaseUrl), serverUrl)
  assert.equal(
    resolveCardAssetUrl(card, config.cardAssetBaseUrl),
    `${config.cardAssetBaseUrl}${card.assetPath}`
  )
})

test('运行时卡牌索引按 cardId 解析全部卡牌', () => {
  const index = createCardCatalogIndex(cards)
  assert.equal(Object.keys(index).length, 52)
  cards.forEach(card => assert.equal(index[card.cardId], card))
})

test('52 张卡牌均有有效且互不重复的发布美术资源', () => {
  const publishedDigests = new Set()
  sourceCards.forEach(card => {
    const relativePath = card.assets.card_art_path.replace(/^\/assets\//, '')
    const filePath = path.join(root, 'server', 'public', 'assets', relativePath)
    assert.ok(fs.existsSync(filePath), `缺少卡面文件 ${card.card_id}`)
    const bytes = fs.readFileSync(filePath)
    assert.ok(bytes.length > 1000, `卡面文件内容异常 ${card.card_id}`)
    assert.equal(bytes[0], 0xff, `卡面不是 JPEG ${card.card_id}`)
    assert.equal(bytes[1], 0xd8, `卡面不是 JPEG ${card.card_id}`)
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    assert.ok(!publishedDigests.has(digest), `发布卡面内容重复 ${card.card_id}`)
    publishedDigests.add(digest)
    assert.match(card.assets.sha256, /^[a-f0-9]{64}$/, `原始卡面哈希无效 ${card.card_id}`)
  })
  assert.equal(publishedDigests.size, 52)
})
