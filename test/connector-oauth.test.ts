// Connectors that sign in with OAuth, against a server that does it as MCP specifies (test/fixtures/oauth-mcp-server.mjs):
// asking for a sign-in instead of opening a browser mid-ask, signing in through the browser and the page served here,
// renewing tokens as they run out, signing out, cancelling, and a client the user registered for a server that cannot
// register one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyConnector, type ConnectorInput } from '../src/shared/connectors'
import { ConnectorStore, connectorInfo, type Connector } from '../src/main/connectors/store'
import { ConnectorManager } from '../src/main/connectors/manager'
import { callbackPage, listenForCallback, NeedsSignIn, type OAuthState } from '../src/main/connectors/oauth'
import type { SecretCodec } from '../src/main/store/connections'
// @ts-expect-error: a plain JavaScript fixture
import { startOAuthMcpServer } from './fixtures/oauth-mcp-server.mjs'

const codec: SecretCodec = { available: true, encrypt: (p) => `enc:${Buffer.from(p).toString('base64')}`, decrypt: (c) => (c.startsWith('enc:') ? Buffer.from(c.slice(4), 'base64').toString() : null) }

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sagittarion-oauth-'))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A browser the user is already signed in to: it follows the sign-in page straight back to the app. */
const signedInBrowser = async (url: URL) => {
  await fetch(url)
}

function setup(file: string, browser: (url: URL) => void | Promise<void> = signedInBrowser) {
  const store = new ConnectorStore(path.join(tmp, file), codec)
  const opened: URL[] = []
  const manager = new ConnectorManager({
    clientInfo: { name: 'sagittarion-test', version: '0.0.0' },
    path: async () => process.env.PATH ?? '',
    connectTimeoutMs: 10_000,
    oauth: (c) => ({ load: () => store.oauth(c.id), save: (state: OAuthState) => store.saveOAuth(c.id, state) }),
    openBrowser: async (url) => {
      opened.push(url)
      await browser(url)
    }
  })
  return { store, manager, opened }
}

const remote = (url: string, extra: Partial<ConnectorInput> = {}): ConnectorInput => ({ ...emptyConnector(), name: 'CRM', transport: 'http', url, ...extra })

describe('a connector that signs in with OAuth', () => {
  it('asks for a sign-in instead of opening a browser, then signs in, runs, renews and signs out', async () => {
    const server = await startOAuthMcpServer()
    const { store, manager, opened } = setup('signin.json')
    try {
      let c: Connector = await store.save(remote(server.url))
      // Starting it, as an ask would, opens nothing: it waits for the user to sign in.
      await expect(manager.ensure(c)).rejects.toBeInstanceOf(NeedsSignIn)
      expect(manager.status(c)).toMatchObject({ state: 'signin', error: 'Sign in to CRM to use it.' })
      expect(opened).toEqual([])
      expect(server.stats.registrations).toBe(0)

      // Signing in: registers itself, opens the sign-in page with PKCE, and takes the code the browser brings back.
      await manager.signIn(c)
      expect(opened).toHaveLength(1)
      const page = opened[0]
      expect(page.origin).toBe(server.base)
      expect(page.searchParams.get('code_challenge_method')).toBe('S256')
      expect(page.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      expect(page.searchParams.get('resource')).toBe(server.url)
      expect(page.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/)
      expect(server.stats).toMatchObject({ registrations: 1, authorizations: 1, tokens: 1 })
      expect(manager.status(c)).toMatchObject({ state: 'connected', server: { name: 'oauth-crm', version: '2.0.0' } })
      expect(manager.status(c).tools.map((t) => t.name)).toEqual(['whoami'])
      const answer = await manager.call(c, 'whoami', {})
      expect(answer.content).toEqual([{ type: 'text', text: 'Signed in as ann@corp.io' }])

      // Kept encrypted with the connector, never in the clear.
      c = (await store.get(c.id))!
      expect(c.signedIn).toBe(true)
      expect(connectorInfo(c, manager.status(c))).toMatchObject({ signedIn: true })
      const file = readFileSync(path.join(tmp, 'signin.json'), 'utf8')
      expect(file).not.toMatch(/at-\d|rt-\d|client-1/)
      expect(store.oauth(c.id)).toMatchObject({ client: { client_id: 'client-1', issuer: server.base }, tokens: { token_type: 'Bearer', issuer: server.base } })

      // A token that runs out is renewed without the user: after a restart, the next request refreshes it.
      server.expireTokens()
      await manager.refresh(c)
      expect(manager.status(c).state).toBe('connected')
      expect(server.stats.refreshes).toBe(1)
      expect(opened).toHaveLength(1)

      // Signing out forgets the tokens; the registration stays for next time.
      await manager.signOut(c)
      c = (await store.get(c.id))!
      expect(c.signedIn).toBe(false)
      expect(store.oauth(c.id).client?.client_id).toBe('client-1')
      await expect(manager.ensure(c)).rejects.toBeInstanceOf(NeedsSignIn)

      // Signing in again reuses the registration and its port.
      await manager.signIn(c)
      expect(server.stats.registrations).toBe(1)
      expect(manager.status(c).state).toBe('connected')

      // Another server address is another sign-in: the saved one goes.
      c = await store.save({ ...remote(`${server.base}/other`), id: c.id })
      expect(store.oauth(c.id)).toEqual({})
    } finally {
      await manager.dispose()
      await server.close()
    }
  })

  it('stops waiting when the user cancels, and says why when the server refuses', async () => {
    const server = await startOAuthMcpServer()
    // A browser left on the sign-in page.
    const { store, manager } = setup('cancel.json', () => undefined)
    try {
      const c = await store.save(remote(server.url))
      const signing = manager.signIn(c)
      await expect.poll(() => manager.status(c).state).toBe('authorizing')
      manager.cancelSignIn(c.id)
      await signing
      expect(manager.status(c)).toMatchObject({ state: 'signin' })

      // The user said no on the server's page.
      const { manager: refusing, store: refused } = setup('refused.json', async (url) => {
        url.searchParams.set('prompt_denied', '1')
        await fetch(url)
      })
      const d = await refused.save(remote(server.url))
      await expect(refusing.signIn(d)).rejects.toThrow('Could not sign in: Access was not granted.')
      expect(refusing.status(d).state).toBe('error')
      await refusing.dispose()
    } finally {
      await manager.dispose()
      await server.close()
    }
  })

  it('uses a client the user registered, for a server that cannot register one', async () => {
    const server = await startOAuthMcpServer({ registration: false })
    const { store, manager } = setup('preset.json')
    try {
      let c = await store.save(remote(server.url, { oauthClientId: 'preset-client', oauthClientSecret: 'preset-secret' }))
      expect(readFileSync(path.join(tmp, 'preset.json'), 'utf8')).not.toContain('preset-secret')
      expect(connectorInfo(c, manager.status(c))).toMatchObject({ oauthClientId: 'preset-client', oauthClientSecretSet: true })
      await manager.signIn(c)
      expect(manager.status(c).state).toBe('connected')
      expect(server.stats.registrations).toBe(0)
      // Kept when the connector is saved again with the secret left as it was.
      c = await store.save({ ...remote(server.url, { oauthClientId: 'preset-client', oauthClientSecret: null }), id: c.id })
      expect(c.oauthClientSecret).toBe('preset-secret')
      expect(c.signedIn).toBe(true)
    } finally {
      await manager.dispose()
      await server.close()
    }
  })
})

describe('the page the browser comes back to', () => {
  it('takes the code once, on this computer only, and tells the user what happened', async () => {
    const listener = await listenForCallback('CRM <b>')
    expect(listener.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const missing = await fetch(listener.redirectUrl.replace('/callback', '/elsewhere'))
    expect(missing.status).toBe(404)
    const page = await fetch(`${listener.redirectUrl}?code=abc&state=xyz`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Signed in to CRM &lt;b&gt;')
    expect(html).not.toContain('<b>')
    await expect(listener.result).resolves.toEqual({ code: 'abc', state: 'xyz' })
    listener.close()
    expect(callbackPage(false, 'CRM', 'Access was not granted.')).toContain('Could not sign in to CRM')

    const timing = await listenForCallback('CRM', undefined, 50)
    await expect(timing.result).rejects.toThrow('Signing in took too long')
    timing.close()
  })
})
