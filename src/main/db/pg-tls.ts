// TLS for PostgreSQL connections: what each SSL mode asks of the server's certificate, the certificate files the user
// chose, read from this computer, and what to tell the user when a certificate is why a connection failed.
import { promises as fs } from 'node:fs'
import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto'
import path from 'node:path'
import type { ConnectionOptions } from 'node:tls'
import type { SslMode } from '@shared/types'
import { expandLocalHome } from '../ssh/local-session'

/** Where a connection's certificate files are on this computer. */
export interface CertificatePaths {
  /** The authority that signed the server's certificate (libpq's sslrootcert). */
  rootCert?: string
  /** The client's own certificate and key, for a server that signs users in with one (libpq's sslcert and sslkey). */
  cert?: string
  key?: string
  /** For an encrypted key. */
  passphrase?: string
}

/** The files' contents as PEM, for the TLS connection. The key is decrypted, in memory only. */
export interface TlsFiles {
  ca?: string
  cert?: string
  key?: string
}

const LABELS = { rootCert: 'CA certificate', cert: 'client certificate', key: 'client key' } as const

async function read(p: string, what: keyof typeof LABELS): Promise<Buffer> {
  try {
    return await fs.readFile(expandLocalHome(p))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') throw new Error(`The ${LABELS[what]} file was not found: ${p}`)
    if (code === 'EISDIR') throw new Error(`The ${LABELS[what]} is a folder, not a file: ${p}`)
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`The ${LABELS[what]} file could not be read (permission denied): ${p}`)
    throw new Error(`The ${LABELS[what]} file could not be read: ${(err as Error)?.message ?? err}`)
  }
}

const isPem = (buf: Buffer) => buf.includes('-----BEGIN ')

/** A certificate file as PEM: PEM as it is, a bundle of several included; DER converted. */
function certificatePem(buf: Buffer, p: string, what: 'rootCert' | 'cert'): string {
  let first: X509Certificate
  try {
    first = new X509Certificate(buf)
  } catch {
    throw new Error(`The ${LABELS[what]} is not a certificate in PEM or DER format: ${p}`)
  }
  return isPem(buf) ? buf.toString('utf8') : first.toString()
}

/** The client key, PEM or DER, decrypted with its passphrase when it is encrypted. */
function privateKey(buf: Buffer, p: string, passphrase: string | undefined): KeyObject {
  const encrypted = isPem(buf) && /ENCRYPTED/.test(buf.toString('latin1'))
  if (encrypted && !passphrase) throw new Error('The client key is encrypted: enter its passphrase.')
  const attempts = isPem(buf)
    ? [{ key: buf, format: 'pem' as const }]
    : (['pkcs8', 'pkcs1', 'sec1'] as const).map((type) => ({ key: buf, format: 'der' as const, type }))
  for (const attempt of attempts) {
    try {
      return createPrivateKey(passphrase ? { ...attempt, passphrase } : attempt)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ERR_MISSING_PASSPHRASE') throw new Error('The client key is encrypted: enter its passphrase.')
      if (encrypted) throw new Error('The passphrase for the client key is wrong.')
    }
  }
  throw new Error(
    passphrase ? `The client key could not be read with that passphrase, or is not a private key: ${p}` : `The client key is not a private key in PEM or DER format: ${p}`
  )
}

/** Reads the certificate files a connection names. Their problems are said plainly, naming the file. */
export async function loadCertificates(paths: CertificatePaths): Promise<TlsFiles> {
  const rootCert = paths.rootCert?.trim()
  const certPath = paths.cert?.trim()
  const keyPath = paths.key?.trim()
  if (certPath && !keyPath) throw new Error('Choose the client key that goes with the client certificate.')
  if (keyPath && !certPath) throw new Error('Choose the client certificate that goes with the client key.')
  const out: TlsFiles = {}
  if (rootCert) out.ca = certificatePem(await read(rootCert, 'rootCert'), rootCert, 'rootCert')
  if (certPath && keyPath) {
    const cert = certificatePem(await read(certPath, 'cert'), certPath, 'cert')
    const key = privateKey(await read(keyPath, 'key'), keyPath, paths.passphrase || undefined)
    if (!new X509Certificate(cert).checkPrivateKey(key)) {
      throw new Error(`The client key does not go with the client certificate: ${path.basename(keyPath)} is not the key ${path.basename(certPath)} was made with.`)
    }
    out.cert = cert
    out.key = key.export({ format: 'pem', type: 'pkcs8' }).toString()
  }
  return out
}

/**
 * The TLS settings to try, in order, for an SSL mode; `false` is a plain connection. A CA certificate is checked in
 * every mode but disable, as libpq does when it has one: the server's certificate has to be signed by it. Only
 * verify-full checks the host name in it as well. Without one, verify-ca and verify-full trust the publicly trusted
 * authorities, and prefer and require check nothing.
 */
export function sslAttempts(mode: SslMode, files: TlsFiles = {}, servername?: string): (false | ConnectionOptions)[] {
  if (mode === 'disable') return [false]
  const verify = mode === 'verify-ca' || mode === 'verify-full' || Boolean(files.ca)
  const tls: ConnectionOptions = { rejectUnauthorized: verify }
  if (servername) tls.servername = servername
  if (files.ca) tls.ca = files.ca
  if (files.cert && files.key) {
    tls.cert = files.cert
    tls.key = files.key
  }
  if (verify && mode !== 'verify-full') tls.checkServerIdentity = () => undefined
  return mode === 'prefer' ? [tls, false] : [tls]
}

const UNVERIFIED = /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_SIGNATURE_FAILURE|CERT_UNTRUSTED|CERT_REJECTED|INVALID_CA)$/

/**
 * Why a connection failed, when a certificate is the reason, said so the user knows which file or setting to change;
 * null when it was something else.
 */
export function certificateError(err: unknown, ctx: { rootCert?: string; host: string }): Error | null {
  const e = err as { message?: unknown; code?: unknown } | null
  const msg = String(e?.message ?? err).replace(/\.$/, '')
  const code = String(e?.code ?? '')
  // A TLS alert from the server, as OpenSSL words it ("tlsv1 alert unknown ca") or BoringSSL, in Electron
  // ("TLSV1_ALERT_UNKNOWN_CA").
  const alert = /alert ((?:bad |unsupported )?certificate(?: required| expired| revoked| unknown)?|unknown ca)\b/.exec(`${msg} ${code}`.replace(/_/g, ' ').toLowerCase())?.[1]
  // The server's refusals: of a missing client certificate, or of one it does not accept.
  if (/requires a valid client certificate/i.test(msg) || alert === 'certificate required') {
    return new Error('The server requires a client certificate: choose yours and its key under "Use SSL certificates".')
  }
  if (/certificate authentication failed/i.test(msg)) {
    return new Error(`${msg}. The client certificate's common name (CN) has to be the user name, unless the server maps one to the other.`)
  }
  if (alert === 'unknown ca') return new Error('The server does not trust the client certificate: it was not signed by an authority the server accepts.')
  if (alert) return new Error(`The server rejected the client certificate (${alert}).`)
  // The server's certificate, as checked here.
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /altnames/i.test(msg)) {
    // Node says it twice: "…does not match certificate's altnames: Host: x. is not in the cert's altnames: DNS:y".
    const names = /.*(?:altnames|list|CN): (.+)$/.exec(msg)?.[1]
    return new Error(`The server's certificate is not for ${ctx.host}: ${names ? `it is for ${names}` : msg}. Use SSL mode "Verify CA" to check only who signed it.`)
  }
  if (code === 'CERT_HAS_EXPIRED') return new Error("The server's certificate has expired.")
  if (code === 'CERT_NOT_YET_VALID') return new Error("The server's certificate is not valid yet: check this computer's clock.")
  if (UNVERIFIED.test(code) || /self[- ]signed|unable to (get|verify)|certificate/i.test(msg)) {
    return new Error(
      ctx.rootCert
        ? `The server's certificate was not signed by the CA certificate ${path.basename(ctx.rootCert)}: ${msg}.`
        : `The server's certificate could not be verified: ${msg}. Choose the CA certificate that signed it under "Use SSL certificates", or use SSL mode "Require" to connect without checking it.`
    )
  }
  return null
}
