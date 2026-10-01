// Signing in to a remote connector with OAuth, as MCP specifies it: the server says it wants a token, the app finds its
// authorization server, registers itself there (or uses a client the user registered), and opens the sign-in page in
// the user's browser with PKCE. The browser comes back to a page served on this computer for the moment it takes; the
// code it brings is exchanged for tokens, which are saved encrypted with the connector and renewed as they run out.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

/** What is kept for a signed-in connector, as the SDK hands it over (each part stamped with its issuer). */
export interface OAuthState {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discovery?: OAuthDiscoveryState
  /** The address the client was registered to come back to: its port is tried first next time. */
  redirectUrl?: string
}

export interface OAuthStorage {
  load(): OAuthState
  save(state: OAuthState): Promise<void>
}

/** The server wants the user to sign in, and this is not a moment to open their browser. */
export class NeedsSignIn extends Error {
  constructor(name: string) {
    super(`Sign in to ${name} to use it: Settings → Connectors.`)
    this.name = 'NeedsSignIn'
  }
}

export interface ConnectorAuthOptions {
  name: string
  storage: OAuthStorage
  /** Present while the user signs in: where the browser comes back to, and how to open it. */
  interactive?: { redirectUrl: string; open: (url: URL) => void | Promise<void> }
  /** A client the user registered with a server that cannot register apps itself. */
  client?: { client_id: string; client_secret?: string }
}

/**
 * The SDK's view of one connector's sign-in. Outside a sign-in it only ever presents and renews saved tokens: where it
 * would need the user, it stops with NeedsSignIn rather than open a browser in the middle of an ask.
 */
export class ConnectorAuth implements OAuthClientProvider {
  private verifier = ''
  private sentState = ''

  constructor(private readonly opts: ConnectorAuthOptions) {}

  get redirectUrl(): string {
    return this.opts.interactive?.redirectUrl ?? this.opts.storage.load().redirectUrl ?? 'http://127.0.0.1/callback'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Sagittarion',
      client_uri: 'https://portsidelabs.io/sagittarion',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.opts.client?.client_secret ? 'client_secret_post' : 'none'
    }
  }

  /** The state sent with the sign-in request, to check the browser brings back. */
  get expectedState(): string {
    return this.sentState
  }

  state(): string {
    this.sentState = randomBytes(16).toString('hex')
    return this.sentState
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const saved = this.opts.storage.load().client
    if (saved) return saved
    if (this.opts.client) return { ...this.opts.client }
    // Registering is part of signing in, done when the user asks to.
    if (!this.opts.interactive) throw new NeedsSignIn(this.opts.name)
    return undefined
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    await this.update({ client, redirectUrl: this.redirectUrl })
  }

  tokens(): OAuthTokens | undefined {
    return this.opts.storage.load().tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens })
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.interactive) throw new NeedsSignIn(this.opts.name)
    await this.opts.interactive.open(url)
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No sign-in is under way.')
    return this.verifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') this.verifier = ''
    else if (scope === 'all') await this.opts.storage.save({})
    else if (scope === 'client') await this.update({ client: undefined })
    else if (scope === 'tokens') await this.update({ tokens: undefined })
    else await this.update({ discovery: undefined })
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.update({ discovery })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.opts.storage.load().discovery
  }

  private update(patch: Partial<OAuthState>): Promise<void> {
    return this.opts.storage.save({ ...this.opts.storage.load(), ...patch })
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** The page the browser lands on after signing in: done, or what went wrong, and back to the app either way. */
export function callbackPage(ok: boolean, name: string, detail = ''): string {
  const title = ok ? `Signed in to ${name}` : `Could not sign in to ${name}`
  const body = ok ? 'You can close this tab and go back to Sagittarion.' : `${detail ? `${detail} ` : ''}Close this tab and try again from Sagittarion.`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f0f;color:#f2f3f7}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:19px;font-weight:600;margin:0 0 8px}p{margin:0;color:#a3a5ae}
.mark{width:40px;height:40px;margin:0 auto 18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;background:${ok ? '#1d3b28;color:#66c887' : '#3b1d1d;color:#ff7a72'}}
</style></head><body><main><div class="mark">${ok ? '✓' : '!'}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`
}

/** The user stopped waiting for the sign-in. */
export class SignInCancelled extends Error {
  constructor() {
    super('Signing in was cancelled.')
    this.name = 'SignInCancelled'
  }
}

export interface CallbackListener {
  redirectUrl: string
  /** The code the browser brings back, with the state it carried; rejects on an error, a timeout or a cancel. */
  result: Promise<{ code: string; state: string }>
  /** Stops listening; a sign-in still waiting ends with SignInCancelled. */
  close(): void
}

/**
 * Listens on this computer for the browser coming back from the sign-in page: on the loopback address only, on the
 * port the client was registered with when it is free, for as long as a sign-in may take.
 */
export async function listenForCallback(name: string, preferredPort?: number, timeoutMs = 5 * 60_000): Promise<CallbackListener> {
  const server = http.createServer()
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  try {
    await listen(preferredPort ?? 0)
  } catch {
    await listen(0)
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const redirectUrl = `http://127.0.0.1:${port}/callback`
  let settle: { resolve: (v: { code: string; state: string }) => void; reject: (e: Error) => void } | null = null
  const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // The browser may come back, or the user cancel, before anyone waits for it: that is not an unhandled failure.
  result.catch(() => undefined)
  // Settled once; a second visit to the page changes nothing.
  const finish = (outcome: { code: string; state: string } | Error) => {
    const s = settle
    settle = null
    if (!s) return
    if (outcome instanceof Error) s.reject(outcome)
    else s.resolve(outcome)
  }
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirectUrl)
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const ok = !error && Boolean(code)
    const detail = error ? (url.searchParams.get('error_description') ?? (error === 'access_denied' ? 'Access was not granted.' : `The server said: ${error}.`)) : code ? '' : 'No sign-in code came back.'
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(callbackPage(ok, name, detail))
    finish(ok ? { code: code!, state: url.searchParams.get('state') ?? '' } : new Error(detail))
  })
  const timer = setTimeout(() => finish(new Error('Signing in took too long. Try again.')), timeoutMs)
  timer.unref?.()
  return {
    redirectUrl,
    result,
    close() {
      clearTimeout(timer)
      finish(new SignInCancelled())
      server.close()
      server.closeAllConnections?.()
    }
  }
}
