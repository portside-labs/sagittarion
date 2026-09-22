// A small SSH server used for tests and local development. It authenticates a
// single user, runs `exec` requests through /bin/sh (like a real sshd does with
// the login shell) and serves a minimal read-only SFTP subsystem so the remote
// file browser can be exercised without a real server.
import ssh2 from 'ssh2'
const { Server, utils } = ssh2
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { STATUS_CODE } = utils.sftp
const here = path.dirname(fileURLToPath(import.meta.url))

export function loadOrCreateHostKey(file) {
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  if (file) fs.writeFileSync(file, privateKey, { mode: 0o600 })
  return privateKey
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host]
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {string[]} [options.authorizedKeys] OpenSSH public key lines accepted for publickey auth
 * @param {boolean} [options.noise] Prefix every exec with chatty output, like a noisy ~/.bashrc
 * @param {string} [options.hostKeyPath] Persist the host key here so fingerprints stay stable
 * @param {boolean} [options.quiet]
 */
export async function startMockServer(options = {}) {
  const {
    port = 0,
    host = '127.0.0.1',
    username = 'test',
    password = 'test',
    authorizedKeys = [],
    noise = false,
    hostKeyPath,
    quiet = true
  } = options
  const hostKey = loadOrCreateHostKey(hostKeyPath)
  const parsedAuthorized = authorizedKeys.map((k) => utils.parseKey(k)).filter((k) => !(k instanceof Error))
  const log = quiet ? () => {} : (...a) => console.log('[mock-ssh]', ...a)

  const clients = new Set()
  const server = new Server({ hostKeys: [hostKey], banner: 'sagittarion mock server' }, (client) => {
    log('client connected')
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', (err) => log('client error', err.message))

    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        if (safeEqual(ctx.username, username) && safeEqual(ctx.password, password)) return ctx.accept()
        return ctx.reject(['password', 'publickey'])
      }
      if (ctx.method === 'publickey') {
        if (!safeEqual(ctx.username, username)) return ctx.reject()
        const match = parsedAuthorized.find(
          (k) => k.type === ctx.key.algo && timingSafeEqual(k.getPublicSSH(), ctx.key.data)
        )
        if (!match) return ctx.reject(['password', 'publickey'])
        if (ctx.signature) {
          if (!match.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject()
        }
        return ctx.accept()
      }
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          if (safeEqual(ctx.username, username) && answers[0] !== undefined && safeEqual(answers[0], password)) ctx.accept()
          else ctx.reject()
        })
      }
      ctx.reject(['password', 'publickey', 'keyboard-interactive'])
    })

    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const socket = net.connect(info.destPort, info.destIP)
        let stream = null
        socket.once('connect', () => {
          stream = accept()
          socket.pipe(stream).pipe(socket)
          stream.on('close', () => socket.destroy())
          socket.on('close', () => stream.close())
          stream.on('error', () => socket.destroy())
        })
        socket.on('error', (err) => {
          log('forward error', err.message)
          if (!stream) {
            try {
              reject()
            } catch {
              /* already handled */
            }
          }
        })
      })
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('pty', (accept, reject) => reject && reject())
        session.on('shell', (accept, reject) => reject && reject())
        session.on('env', (accept) => accept && accept())
        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          const command = noise
            ? `echo "Welcome to mock-host"; echo "Last login: never"; ${info.command}`
            : info.command
          log('exec', command.slice(0, 120))
          const proc = spawn('/bin/sh', ['-c', command], { cwd: os.homedir(), env: { ...process.env } })
          proc.stdout.on('data', (d) => stream.write(d))
          proc.stderr.on('data', (d) => stream.stderr.write(d))
          proc.stdin.on('error', () => {})
          stream.on('data', (d) => proc.stdin.write(d))
          stream.on('end', () => proc.stdin.end())
          stream.on('close', () => {
            if (proc.exitCode === null && !proc.killed) proc.kill('SIGTERM')
          })
          proc.on('close', (code) => {
            try {
              stream.exit(code ?? 0)
              stream.end()
            } catch {
              /* channel already gone */
            }
          })
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          serveSftp(sftp, log)
        })
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const actualPort = server.address().port
  log(`listening on ${host}:${actualPort}`)
  return {
    host,
    port: actualPort,
    username,
    password,
    hostKey,
    server,
    close: () =>
      new Promise((resolve) => {
        for (const c of clients) {
          try {
            c.end()
          } catch {
            /* already gone */
          }
        }
        const timer = setTimeout(resolve, 3000)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
  }
}

function serveSftp(sftp, log) {
  const handles = new Map()
  let nextHandle = 1
  const home = os.homedir()
  const resolvePath = (p) => (p === '' || p === '.' ? home : path.resolve(home, p))
  const attrsOf = (st) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  })
  const errStatus = (e) =>
    e?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : e?.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE

  sftp.on('REALPATH', (reqid, p) => {
    try {
      let abs = resolvePath(p)
      try {
        abs = fs.realpathSync(abs)
      } catch {
        /* keep the resolved path for non-existent targets */
      }
      sftp.name(reqid, [{ filename: abs, longname: abs, attrs: {} }])
    } catch (e) {
      sftp.status(reqid, errStatus(e))
    }
  })
  sftp.on('OPENDIR', (reqid, p) => {
    try {
      const abs = resolvePath(p)
      const st = fs.statSync(abs)
      if (!st.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE)
      const entries = fs.readdirSync(abs)
      const id = nextHandle++
      handles.set(id, { dir: abs, entries, sent: false })
      const buf = Buffer.alloc(4)
      buf.writeUInt32BE(id, 0)
      sftp.handle(reqid, buf)
    } catch (e) {
      sftp.status(reqid, errStatus(e))
    }
  })
  sftp.on('READDIR', (reqid, handle) => {
    const d = handles.get(handle.readUInt32BE(0))
    if (!d) return sftp.status(reqid, STATUS_CODE.FAILURE)
    if (d.sent) return sftp.status(reqid, STATUS_CODE.EOF)
    d.sent = true
    const names = d.entries.map((name) => {
      let st = null
      try {
        st = fs.lstatSync(path.join(d.dir, name))
      } catch {
        /* unreadable entry */
      }
      return { filename: name, longname: name, attrs: st ? attrsOf(st) : {} }
    })
    sftp.name(reqid, names)
  })
  const statHandler = (fn) => (reqid, p) => {
    try {
      sftp.attrs(reqid, attrsOf(fn(resolvePath(p))))
    } catch (e) {
      sftp.status(reqid, errStatus(e))
    }
  }
  sftp.on('STAT', statHandler(fs.statSync))
  sftp.on('LSTAT', statHandler(fs.lstatSync))
  sftp.on('CLOSE', (reqid, handle) => {
    handles.delete(handle.readUInt32BE(0))
    sftp.status(reqid, STATUS_CODE.OK)
  })
  for (const unsupported of ['OPEN', 'READ', 'WRITE', 'REMOVE', 'RMDIR', 'MKDIR', 'RENAME', 'SETSTAT', 'FSETSTAT', 'SYMLINK', 'READLINK']) {
    sftp.on(unsupported, (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED))
  }
  log('sftp session opened')
}

export function ensureSampleDb() {
  const db = path.join(here, '..', 'fixtures', 'sample.db')
  if (!fs.existsSync(db)) {
    const r = spawnSync('python3', [path.join(here, '..', 'fixtures', 'make-sample-db.py'), db], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('could not create sample database')
  }
  return db
}

// CLI: node test/mock-ssh/server.mjs [--port N] [--noise]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 2222
  const noise = args.includes('--noise')
  const db = ensureSampleDb()
  startMockServer({ port, noise, quiet: false, hostKeyPath: path.join(here, '.hostkey') }).then((s) => {
    console.log(`\nMock SSH server ready.\n  host:     ${s.host}\n  port:     ${s.port}\n  user:     ${s.username}\n  password: ${s.password}\n  database: ${db}\n`)
  })
}
