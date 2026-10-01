// A remote MCP server that wants a sign-in, as MCP specifies it: its endpoint answers 401 with where to find its
// authorization server, which publishes its metadata, registers clients, signs the user in at /authorize (here at once,
// as if they were already signed in and agreed) with PKCE, and issues tokens that expire and renew.
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Starts the server on a free port. `registration: false` makes it a server that cannot register clients, which only a
 * client registered beforehand (`presetClient`) may use.
 */
export async function startOAuthMcpServer({ registration = true, presetClient = 'preset-client', presetSecret = 'preset-secret', user = 'ann@corp.io' } = {}) {
  const clients = new Map()
  if (!registration) clients.set(presetClient, { client_id: presetClient, client_secret: presetSecret, redirect_uris: null })
  const codes = new Map()
  const access = new Map()
  const refresh = new Map()
  const stats = { registrations: 0, authorizations: 0, tokens: 0, refreshes: 0, mcp: 0, unauthorized: 0 }
  let n = 0
  let base = ''

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => resolve(body))
    })
  const issue = (clientId) => {
    n++
    const tokens = { access_token: `at-${n}-${randomBytes(4).toString('hex')}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${n}-${randomBytes(4).toString('hex')}`, scope: 'crm.read' }
    access.set(tokens.access_token, { clientId, expires: Date.now() + 3600_000 })
    refresh.set(tokens.refresh_token, clientId)
    return tokens
  }
  const authenticated = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    const t = m && access.get(m[1])
    return Boolean(t && t.expires > Date.now())
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base)
    const body = req.method === 'POST' ? await readBody(req) : ''
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['crm.read'], bearer_methods_supported: ['header'] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(registration ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post']
      })
    }
    if (url.pathname === '/register' && registration) {
      const meta = JSON.parse(body || '{}')
      stats.registrations++
      const client = { ...meta, client_id: `client-${stats.registrations}`, client_id_issued_at: Math.floor(Date.now() / 1000) }
      clients.set(client.client_id, client)
      return json(res, 201, client)
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams
      const client = clients.get(p.get('client_id'))
      const redirect = p.get('redirect_uri')
      if (!client) return json(res, 400, { error: 'invalid_client' })
      if (client.redirect_uris && !client.redirect_uris.includes(redirect)) return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is not registered' })
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return json(res, 400, { error: 'invalid_request', error_description: 'PKCE is required' })
      stats.authorizations++
      const back = new URL(redirect)
      if (p.get('prompt_denied') === '1') {
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = randomBytes(8).toString('hex')
        codes.set(code, { clientId: client.client_id, redirect, challenge: p.get('code_challenge'), resource: p.get('resource') })
        back.searchParams.set('code', code)
      }
      if (p.get('state')) back.searchParams.set('state', p.get('state'))
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }
    if (url.pathname === '/token') {
      const p = new URLSearchParams(body)
      const clientId = p.get('client_id')
      const client = clients.get(clientId)
      if (!client || (client.client_secret && p.get('client_secret') !== client.client_secret)) return json(res, 401, { error: 'invalid_client' })
      if (p.get('grant_type') === 'authorization_code') {
        const grant = codes.get(p.get('code'))
        codes.delete(p.get('code'))
        if (!grant || grant.clientId !== clientId || grant.redirect !== p.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' })
        if (b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest()) !== grant.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE check failed' })
        stats.tokens++
        return json(res, 200, issue(clientId))
      }
      if (p.get('grant_type') === 'refresh_token') {
        const owner = refresh.get(p.get('refresh_token'))
        if (owner !== clientId) return json(res, 400, { error: 'invalid_grant' })
        refresh.delete(p.get('refresh_token'))
        stats.refreshes++
        return json(res, 200, issue(clientId))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname === '/mcp') {
      if (!authenticated(req)) {
        stats.unauthorized++
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="crm.read"`, 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'invalid_token' }))
      }
      if (req.method === 'GET') {
        res.writeHead(405)
        return res.end()
      }
      if (req.method === 'DELETE') {
        res.writeHead(200)
        return res.end()
      }
      stats.mcp++
      const msg = JSON.parse(body || '{}')
      if (msg.id === undefined) {
        res.writeHead(202)
        return res.end()
      }
      const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'oauth-session' })
      if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauth-crm', version: '2.0.0' } })
      if (msg.method === 'tools/list') {
        return reply({ tools: [{ name: 'whoami', description: 'Who the connector is signed in as.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] })
      }
      if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: `Signed in as ${user}` }] })
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return {
    url: `${base}/mcp`,
    base,
    stats,
    clients,
    /** Every access token runs out now; refresh tokens still work. */
    expireTokens() {
      for (const t of access.values()) t.expires = 0
    },
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

// CLI: node test/fixtures/oauth-mcp-server.mjs — prints its URL and runs until stopped.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startOAuthMcpServer().then((s) => console.log(`OAuth MCP server: ${s.url}`))
}
