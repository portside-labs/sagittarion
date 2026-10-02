// SSL certificates on PostgreSQL connections: the CA certificate a server's certificate is checked against, and the
// client certificate and key that sign a user in. The certificates are made with openssl for each run. A stand-in
// server takes the TLS handshake as PostgreSQL would and says what it saw; with DOCKER_TESTS=1, a real PostgreSQL with
// SSL on and a certificate-only user is used as well.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { PostgresDriver, type PostgresDriverOptions } from '../src/main/db/postgres'
import { loadCertificates, sslAttempts } from '../src/main/db/pg-tls'
import { ConnectionStore, type SecretCodec } from '../src/main/store/connections'
import { newConnection, normalizeConnection, parsePostgresUrl } from '../src/shared/connections'
import { dockerAvailable } from './pg-server.mjs'
import { makeCertificates, opensslAvailable, PASSPHRASE, STAND_IN_REFUSAL, startStandIn } from './pg-tls-server.mjs'

const openssl = opensslAvailable()

describe('SSL modes', () => {
  it('check the server’s certificate as libpq does: a CA certificate in every mode, the host name only in verify-full', () => {
    expect(sslAttempts('disable', { ca: 'CA' })).toEqual([false])
    expect(sslAttempts('prefer')).toEqual([{ rejectUnauthorized: false }, false])
    expect(sslAttempts('require')).toEqual([{ rejectUnauthorized: false }])
    expect(sslAttempts('verify-full')).toEqual([{ rejectUnauthorized: true }])

    const [verifyCa] = sslAttempts('verify-ca') as [tls.ConnectionOptions]
    expect(verifyCa.rejectUnauthorized).toBe(true)
    expect(verifyCa.checkServerIdentity?.('elsewhere.example', {} as tls.PeerCertificate)).toBeUndefined()

    const [required] = sslAttempts('require', { ca: 'CA' }) as [tls.ConnectionOptions]
    expect(required).toMatchObject({ rejectUnauthorized: true, ca: 'CA' })
    expect(required.checkServerIdentity).toBeTypeOf('function')
    const [full] = sslAttempts('verify-full', { ca: 'CA' }, 'db.internal') as [tls.ConnectionOptions]
    expect(full).toEqual({ rejectUnauthorized: true, ca: 'CA', servername: 'db.internal' })

    // A client certificate goes with its key, or not at all.
    expect(sslAttempts('require', { cert: 'CERT', key: 'KEY' })).toEqual([{ rejectUnauthorized: false, cert: 'CERT', key: 'KEY' }])
    expect(sslAttempts('require', { cert: 'CERT' })).toEqual([{ rejectUnauthorized: false }])
  })
})

describe('connection URLs and saved connections', () => {
  it('take the certificate files from a libpq URL', () => {
    expect(
      parsePostgresUrl('postgres://app@db.example.com/sales?sslmode=verify-ca&sslrootcert=~/.postgresql/root.crt&sslcert=/certs/app.crt&sslkey=/certs/app.key&sslpassword=open%20sesame')
    ).toEqual({
      host: 'db.example.com',
      user: 'app',
      database: 'sales',
      sslMode: 'verify-ca',
      sslRootCert: '~/.postgresql/root.crt',
      sslCert: '/certs/app.crt',
      sslKey: '/certs/app.key',
      sslPassphrase: 'open sesame'
    })
    // "system" means the authorities this computer trusts, which check the host name unless told otherwise.
    expect(parsePostgresUrl('postgresql://h/db?sslrootcert=system')).toMatchObject({ sslMode: 'verify-full' })
    expect(parsePostgresUrl('postgresql://h/db?sslrootcert=system')).not.toHaveProperty('sslRootCert')
    expect(parsePostgresUrl('postgresql://h/db?sslmode=verify-ca&sslrootcert=system')).toMatchObject({ sslMode: 'verify-ca' })
    expect(parsePostgresUrl('postgresql://h/db?sslmode=allow')).toMatchObject({ sslMode: 'prefer' })
  })

  it('tidies certificate paths, and keeps a passphrase only for a client key', () => {
    const base = newConnection('postgres')
    const pg = normalizeConnection({
      ...base,
      pg: { ...base.pg!, sslMode: 'nonsense' as never, sslRootCert: '  ~/ca.crt ', sslCert: ' ', sslPassphrase: 'pw' }
    }).pg!
    expect(pg.sslMode).toBe('prefer')
    expect(pg.sslRootCert).toBe('~/ca.crt')
    expect(pg).not.toHaveProperty('sslCert')
    expect(pg).not.toHaveProperty('sslPassphrase')
  })

  it('store the key’s passphrase encrypted, and only when asked to', async () => {
    const codec: SecretCodec = { available: true, encrypt: (plain) => `enc:${plain}`, decrypt: (c) => (c.startsWith('enc:') ? c.slice(4) : null) }
    const dir = mkdtempSync(path.join(tmpdir(), 'conn-store-'))
    try {
      const file = path.join(dir, 'connections.json')
      const store = new ConnectionStore(file, codec)
      const base = newConnection('postgres')
      const saved = await store.save({
        ...base,
        pg: { ...base.pg!, host: 'db', database: 'app', user: 'certuser', sslMode: 'verify-full', sslRootCert: '/c/ca.crt', sslCert: '/c/client.crt', sslKey: '/c/client.key', sslPassphrase: 'pw' }
      })
      const raw = JSON.parse(readFileSync(file, 'utf8')).connections[0].pg
      expect(raw).toMatchObject({ sslRootCert: '/c/ca.crt', sslCert: '/c/client.crt', sslKey: '/c/client.key', encryptedSslPassphrase: 'enc:pw' })
      expect(raw).not.toHaveProperty('sslPassphrase')
      expect((await new ConnectionStore(file, codec).get(saved.id))?.pg?.sslPassphrase).toBe('pw')

      // Saved again without typing it: it is kept. Told not to save it: it goes.
      await store.save({ ...saved, pg: { ...saved.pg!, sslPassphrase: undefined } })
      expect((await store.get(saved.id))?.pg?.sslPassphrase).toBe('pw')
      await store.save({ ...saved, pg: { ...saved.pg!, saveSslPassphrase: false } })
      expect(JSON.parse(readFileSync(file, 'utf8')).connections[0].pg).not.toHaveProperty('encryptedSslPassphrase')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!openssl)('certificate files', () => {
  let certs: ReturnType<typeof makeCertificates>
  beforeAll(() => {
    certs = makeCertificates()
  })
  afterAll(() => certs?.cleanup())

  it('are read as PEM, bundles and DER too, with the client key decrypted', async () => {
    const pem = await loadCertificates({ rootCert: certs.file('ca.crt'), cert: certs.file('client.crt'), key: certs.file('client-encrypted.key'), passphrase: PASSPHRASE })
    expect(pem.ca).toBe(certs.read('ca.crt'))
    expect(pem.cert).toBe(certs.read('client.crt'))
    expect(pem.key).toMatch(/^-----BEGIN PRIVATE KEY-----/)

    const bundle = path.join(certs.dir, 'bundle.pem')
    spawnSync('sh', ['-c', `cat other-ca.crt ca.crt > ${bundle}`], { cwd: certs.dir })
    expect((await loadCertificates({ rootCert: bundle })).ca?.match(/BEGIN CERTIFICATE/g)).toHaveLength(2)

    const der = await loadCertificates({ rootCert: certs.file('ca.der'), cert: certs.file('client.crt'), key: certs.file('client.pk8') })
    expect(der.ca?.trim()).toBe(certs.read('ca.crt').trim())
    expect(der.key).toMatch(/^-----BEGIN PRIVATE KEY-----/)
  })

  it('are found under ~ in the home folder', async () => {
    const home = process.env.HOME
    process.env.HOME = certs.dir
    try {
      expect((await loadCertificates({ rootCert: '~/ca.crt' })).ca).toBe(certs.read('ca.crt'))
    } finally {
      process.env.HOME = home
    }
  })

  it('say what is wrong with them, naming the file', async () => {
    const key = { cert: certs.file('client.crt'), key: certs.file('client-encrypted.key') }
    await expect(loadCertificates(key)).rejects.toThrow('The client key is encrypted: enter its passphrase.')
    await expect(loadCertificates({ ...key, passphrase: 'wrong' })).rejects.toThrow('The passphrase for the client key is wrong.')
    await expect(loadCertificates({ cert: certs.file('client.crt'), key: certs.file('server.key') })).rejects.toThrow(
      'The client key does not go with the client certificate: server.key is not the key client.crt was made with.'
    )
    await expect(loadCertificates({ rootCert: '/nowhere/root.crt' })).rejects.toThrow('The CA certificate file was not found: /nowhere/root.crt')
    await expect(loadCertificates({ rootCert: certs.file('ca.key') })).rejects.toThrow(`The CA certificate is not a certificate in PEM or DER format: ${certs.file('ca.key')}`)
    await expect(loadCertificates({ rootCert: certs.dir })).rejects.toThrow('The CA certificate is a folder, not a file')
    await expect(loadCertificates({ cert: certs.file('client.crt'), key: certs.file('client.crt') })).rejects.toThrow('The client key is not a private key')
    await expect(loadCertificates({ cert: certs.file('client.crt') })).rejects.toThrow('Choose the client key that goes with the client certificate.')
    await expect(loadCertificates({ key: certs.file('client.key') })).rejects.toThrow('Choose the client certificate that goes with the client key.')
  })
})

describe.skipIf(!openssl)('connecting with certificates', () => {
  let certs: ReturnType<typeof makeCertificates>
  let server: Awaited<ReturnType<typeof startStandIn>>
  let strict: Awaited<ReturnType<typeof startStandIn>>
  beforeAll(async () => {
    certs = makeCertificates()
    server = await startStandIn(certs)
    strict = await startStandIn(certs, { strict: true })
  })
  afterAll(async () => {
    await server?.close()
    await strict?.close()
    certs?.cleanup()
  })

  const connect = (o: Partial<PostgresDriverOptions>) =>
    new PostgresDriver({
      host: '127.0.0.1',
      port: server.port,
      database: 'app',
      user: 'certuser',
      password: 'secret',
      sslMode: 'verify-full',
      readOnly: false,
      displayHost: '127.0.0.1',
      displayPort: server.port,
      ...o
    }).connect()
  // The stand-in's own refusal comes after the handshake: the certificates were good.
  const GOT_THROUGH = STAND_IN_REFUSAL

  it('trusts the server’s certificate when the CA certificate signed it', async () => {
    const before = server.handshakes.length
    await expect(connect({ certificates: { rootCert: certs.file('ca.crt') } })).rejects.toThrow(GOT_THROUGH)
    await expect(connect({ certificates: { rootCert: certs.file('ca.der') } })).rejects.toThrow(GOT_THROUGH)
    expect(server.handshakes.length).toBe(before + 2)
  })

  it('says how to fix a certificate it cannot trust, and gets no further', async () => {
    const before = server.handshakes.length
    await expect(connect({})).rejects.toThrow(/^The server's certificate could not be verified: .+\. Choose the CA certificate that signed it under "Use SSL certificates", or use SSL mode "Require"/)
    await expect(connect({ certificates: { rootCert: certs.file('other-ca.crt') } })).rejects.toThrow(/^The server's certificate was not signed by the CA certificate other-ca\.crt: /)
    // As libpq does, a CA certificate is checked in require too; without one, require takes any certificate.
    await expect(connect({ sslMode: 'require', certificates: { rootCert: certs.file('other-ca.crt') } })).rejects.toThrow(/not signed by the CA certificate other-ca\.crt/)
    expect(server.handshakes.length).toBe(before)
    await expect(connect({ sslMode: 'require' })).rejects.toThrow(GOT_THROUGH)
  })

  it('checks the host name in verify-full only', async () => {
    // As through an SSH tunnel to a server known by another name.
    const tunnelled = { servername: 'db.internal', displayHost: 'db.internal', certificates: { rootCert: certs.file('ca.crt') } }
    await expect(connect(tunnelled)).rejects.toThrow(
      'The server\'s certificate is not for db.internal: it is for DNS:localhost, IP Address:127.0.0.1. Use SSL mode "Verify CA" to check only who signed it.'
    )
    await expect(connect({ ...tunnelled, sslMode: 'verify-ca' })).rejects.toThrow(GOT_THROUGH)
  })

  it('signs in with the client certificate, its key decrypted with the passphrase', async () => {
    const before = server.handshakes.length
    await expect(
      connect({ certificates: { rootCert: certs.file('ca.crt'), cert: certs.file('client.crt'), key: certs.file('client-encrypted.key'), passphrase: PASSPHRASE } })
    ).rejects.toThrow(GOT_THROUGH)
    expect(server.handshakes[before]).toEqual({ clientName: 'certuser', clientTrusted: true })
    // A wrong passphrase stops it before anything is sent.
    await expect(connect({ certificates: { cert: certs.file('client.crt'), key: certs.file('client-encrypted.key'), passphrase: 'nope' } })).rejects.toThrow(
      'The passphrase for the client key is wrong.'
    )
    expect(server.handshakes.length).toBe(before + 1)
    // With SSL off, the files are not read at all.
    await expect(connect({ sslMode: 'disable', certificates: { rootCert: '/nowhere/root.crt' } })).rejects.toThrow(/stand-in server: SSL only/)
  })

  it('says so when a server asks for a client certificate in the handshake itself, as some proxies do', async () => {
    const at = (o: Partial<PostgresDriverOptions>) => connect({ port: strict.port, displayPort: strict.port, sslMode: 'require', ...o })
    // TLS 1.3's "certificate required" alert. (PostgreSQL itself says so after the handshake: see below.)
    await expect(at({})).rejects.toThrow('The server requires a client certificate: choose yours and its key under "Use SSL certificates".')
    await expect(at({ certificates: { cert: certs.file('client.crt'), key: certs.file('client.key') } })).rejects.toThrow(GOT_THROUGH)
  })
})

/** A PostgreSQL 16 container with SSL on: its certificate signed by the test CA, and a user that signs in with one. */
function startTlsPostgres(certs: ReturnType<typeof makeCertificates>) {
  const script = [
    'set -e',
    'mkdir -p /certs',
    'printf "%s\\n" "$SERVER_CRT" > /certs/server.crt',
    'printf "%s\\n" "$SERVER_KEY" > /certs/server.key',
    'printf "%s\\n" "$CA_CRT" > /certs/ca.crt',
    "printf '%s\\n' 'local all all trust' 'hostssl all certuser all cert' 'host all all all scram-sha-256' > /certs/pg_hba.conf",
    'chown -R postgres:postgres /certs',
    'chmod 600 /certs/server.key',
    'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key -c ssl_ca_file=/certs/ca.crt -c hba_file=/certs/pg_hba.conf'
  ].join('\n')
  const env = { ...process.env, SERVER_CRT: certs.read('server.crt'), SERVER_KEY: certs.read('server.key'), CA_CRT: certs.read('ca.crt') }
  const run = spawnSync(
    'docker',
    [
      ...['run', '-d', '--rm', '-e', 'POSTGRES_USER=test', '-e', 'POSTGRES_PASSWORD=secret', '-e', 'POSTGRES_DB=app'],
      ...['-e', 'SERVER_CRT', '-e', 'SERVER_KEY', '-e', 'CA_CRT', '-p', '127.0.0.1::5432', '--entrypoint', 'sh', process.env.PG_IMAGE || 'postgres:16-alpine', '-c', script]
    ],
    { encoding: 'utf8', env }
  )
  if (run.status !== 0) throw new Error(`docker run: ${run.stderr}`)
  const id = run.stdout.trim()
  const port = Number(spawnSync('docker', ['port', id, '5432/tcp'], { encoding: 'utf8' }).stdout.split('\n')[0].split(':').pop())
  return { id, port, stop: () => spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' }) }
}

describe.skipIf(process.env.DOCKER_TESTS !== '1' || !openssl || !dockerAvailable())('PostgreSQL with SSL certificates', () => {
  let certs: ReturnType<typeof makeCertificates>
  let pg: ReturnType<typeof startTlsPostgres>
  beforeAll(async () => {
    certs = makeCertificates()
    pg = startTlsPostgres(certs)
    const deadline = Date.now() + 60_000
    // The image restarts once while it initialises: wait for the server that stays.
    while (spawnSync('docker', ['exec', pg.id, 'pg_isready', '-h', '127.0.0.1', '-U', 'test', '-d', 'app'], { stdio: 'ignore' }).status !== 0) {
      if (Date.now() > deadline) throw new Error('PostgreSQL with SSL never came up')
      await new Promise((r) => setTimeout(r, 400))
    }
    await new Promise((r) => setTimeout(r, 500))
    const made = spawnSync('docker', ['exec', pg.id, 'psql', '-U', 'test', '-d', 'app', '-c', 'CREATE ROLE certuser LOGIN; GRANT CONNECT ON DATABASE app TO certuser'], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(made.stderr)
  }, 90_000)
  afterAll(() => {
    pg?.stop()
    certs?.cleanup()
  })

  const driver = (o: Partial<PostgresDriverOptions>) =>
    new PostgresDriver({
      host: '127.0.0.1',
      port: pg.port,
      database: 'app',
      user: 'test',
      password: 'secret',
      sslMode: 'verify-full',
      readOnly: false,
      displayHost: '127.0.0.1',
      displayPort: pg.port,
      ...o
    })

  it('verifies the server’s certificate against the CA certificate', async () => {
    const d = driver({ certificates: { rootCert: certs.file('ca.crt') } })
    const info = await d.connect()
    expect(info.details).toContainEqual({ label: 'ssl', value: 'verified' })
    await d.close()
    const unverified = driver({ sslMode: 'require' })
    expect((await unverified.connect()).details).toContainEqual({ label: 'ssl', value: 'on' })
    await unverified.close()
    await expect(driver({}).connect()).rejects.toThrow(/could not be verified/)
  })

  it('signs a user in with a client certificate and no password', async () => {
    const d = driver({
      user: 'certuser',
      password: undefined,
      certificates: { rootCert: certs.file('ca.crt'), cert: certs.file('client.crt'), key: certs.file('client-encrypted.key'), passphrase: PASSPHRASE }
    })
    const info = await d.connect()
    expect(info.details).toContainEqual({ label: 'user', value: 'certuser' })
    const res = await d.query('SELECT current_user, ssl, client_dn FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE pid = pg_backend_pid()', [], 10)
    expect(res.results[0]).toMatchObject({ kind: 'rows', rows: [['certuser', true, '/CN=certuser']] })
    await d.close()
  })

  it('says what the server wants when the client certificate is missing or not one it trusts', async () => {
    await expect(driver({ user: 'certuser', sslMode: 'require' }).connect()).rejects.toThrow(
      'The server requires a client certificate: choose yours and its key under "Use SSL certificates".'
    )
    await expect(driver({ user: 'certuser', sslMode: 'require', certificates: { cert: certs.file('stranger.crt'), key: certs.file('stranger.key') } }).connect()).rejects.toThrow(
      'The server does not trust the client certificate: it was not signed by an authority the server accepts.'
    )
  })
})
