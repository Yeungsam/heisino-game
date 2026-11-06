const http = require('node:http')
const { AccountService } = require('./service')
const { CloudAccountStore } = require('./store')
const { WechatIdentity } = require('./wechat')
const { createAccountHandler } = require('./http-handler')

function createServer() {
  const service = new AccountService({ store: new CloudAccountStore(), identity: new WechatIdentity() })
  const handle = createAccountHandler(service)
  return http.createServer(async (request, response) => {
    if (!await handle(request, response)) { response.writeHead(404); response.end() }
  })
}
if (require.main === module) createServer().listen(Number(process.env.PORT || process.env.SCF_PORT || 9000), '0.0.0.0')
module.exports = { createServer }
