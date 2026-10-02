// For the SSL tests: certificates made with the openssl command line (OpenSSL or LibreSSL), and a stand-in for
// PostgreSQL that takes its SSL request and TLS handshake. Used by the vitest suite and the end-to-end script.
//
// The certificates: a CA; a server certificate it signed for localhost and 127.0.0.1; a client certificate it signed
// for a user, with its key also encrypted and in DER; a second CA; and a client certificate that second CA signed,
// which a server trusting the first refuses.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

export const PASSPHRASE = 'open-sesame'
/** What the stand-in answers once a connection is through the handshake: the certificates were good. */
export const STAND_IN_REFUSAL = 'stand-in server: no sign-ins here'

export function opensslAvailable() {
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0
}

function openssl(args, cwd) {
  const r = spawnSync('openssl', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`openssl ${args.join(' ')}: ${r.stderr}`)
}

/**
 * @param {{ user?: string }} [options] The client certificates' common name: the user they sign in as.
 */
export function makeCertificates({ user = 'certuser' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagittarion-tls-'))
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text)
  const subject = (cn) => `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${cn}\n`
  const authority = (name, cn) => {
    write(`${name}.cnf`, `${subject(cn)}[v3_ca]\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n`)
    openssl(['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-config', `${name}.cnf`, '-extensions', 'v3_ca', '-keyout', `${name}.key`, '-out', `${name}.crt`], dir)
  }
  let serial = 1
  const signed = (name, cn, extensions, by = 'ca') => {
    write(`${name}.cnf`, subject(cn))
    write(`${name}.ext`, `basicConstraints = CA:FALSE\nkeyUsage = critical, digitalSignature, keyEncipherment\n${extensions}`)
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', `${name}.cnf`, '-keyout', `${name}.key`, '-out', `${name}.csr`], dir)
    openssl(['x509', '-req', '-sha256', '-days', '3650', '-in', `${name}.csr`, '-CA', `${by}.crt`, '-CAkey', `${by}.key`, '-set_serial', String(serial++), '-extfile', `${name}.ext`, '-out', `${name}.crt`], dir)
  }
  authority('ca', 'Sagittarion Test CA')
  authority('other-ca', 'Another Test CA')
  signed('server', 'localhost', 'extendedKeyUsage = serverAuth\nsubjectAltName = DNS:localhost, IP:127.0.0.1\n')
  signed('client', user, 'extendedKeyUsage = clientAuth\n')
  signed('stranger', user, 'extendedKeyUsage = clientAuth\n', 'other-ca')
  openssl(['pkcs8', '-topk8', '-v2', 'aes-256-cbc', '-in', 'client.key', '-out', 'client-encrypted.key', '-passout', `pass:${PASSPHRASE}`], dir)
  openssl(['pkcs8', '-topk8', '-nocrypt', '-in', 'client.key', '-outform', 'DER', '-out', 'client.pk8'], dir)
  openssl(['x509', '-in', 'ca.crt', '-outform', 'DER', '-out', 'ca.der'], dir)
  const file = (name) => path.join(dir, name)
  return {
    dir,
    file,
    read: (name) => fs.readFileSync(file(name), 'utf8'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

function errorResponse(code, message) {
  const fields = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`)
  const head = Buffer.alloc(5)
  head.write('E')
  head.writeInt32BE(fields.length + 4, 1)
  return Buffer.concat([head, fields])
}

/**
 * Takes PostgreSQL's SSL request and does the TLS handshake with the server certificate, asking for a client
 * certificate signed by the CA; then refuses the sign-in with STAND_IN_REFUSAL, so a test can tell how far a connection
 * got. Strict, it fails the handshake itself without a client certificate it trusts, as some proxies do; PostgreSQL
 * says so after it instead.
 *
 * @param {ReturnType<typeof makeCertificates>} certs
 * @param {{ strict?: boolean }} [options]
 * @returns {Promise<{ port: number, handshakes: { clientName: string | null, clientTrusted: boolean }[], close: () => Promise<void> }>}
 */
export async function startStandIn(certs, { strict = false } = {}) {
  const handshakes = []
  const secure = tls.createServer({ key: certs.read('server.key'), cert: certs.read('server.crt'), ca: certs.read('ca.crt'), requestCert: true, rejectUnauthorized: strict })
  secure.on('secureConnection', (socket) => {
    const peer = socket.getPeerCertificate()
    handshakes.push({ clientName: peer?.subject?.CN ?? null, clientTrusted: socket.authorized })
    socket.once('data', () => socket.end(errorResponse('28000', STAND_IN_REFUSAL)))
  })
  secure.on('tlsClientError', () => undefined)
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.once('data', (buf) => {
      if (buf.length === 8 && buf.readInt32BE(4) === 80877103) {
        socket.write('S')
        secure.emit('connection', socket)
      } else socket.end(errorResponse('28000', 'stand-in server: SSL only'))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    handshakes,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
