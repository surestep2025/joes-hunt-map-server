import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const DAY = 24 * 60 * 60 * 1000
const TRAIL_MS = 6 * 60 * 60 * 1000
const COLORS = ['#e2a84a', '#3d8bfd', '#3f9a68', '#d4654a', '#c084fc', '#8eb4c9']
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function partyCode() {
  const bytes = randomBytes(12)
  let code = ''
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return code
}

function token() {
  return randomBytes(24).toString('base64url')
}

function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 24)
  if (!name) {
    const error = new Error('Enter a name.')
    error.status = 400
    throw error
  }
  return name
}

function haversine(aLat, aLng, bLat, bLng) {
  const r = 6378137
  const p1 = (aLat * Math.PI) / 180
  const p2 = (bLat * Math.PI) / 180
  const dp = ((bLat - aLat) * Math.PI) / 180
  const dl = ((bLng - aLng) * Math.PI) / 180
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)))
}

export function createPartyServer(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS parties (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      party TEXT NOT NULL,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS members_party ON members(party);
    CREATE TABLE IF NOT EXISTS pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL,
      heading REAL,
      battery REAL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pings_member_at ON pings(member, at);
  `)

  /** @type {Map<string, Set<import('node:net').Socket>>} */
  const sockets = new Map()
  /** @type {Map<string, number[]>} */
  const joinsByIp = new Map()

  function expire(now = Date.now()) {
    const cutoff = now - DAY
    db.prepare('DELETE FROM pings WHERE at < ?').run(cutoff)
    db.prepare(
      `DELETE FROM members WHERE created_at < ? AND id NOT IN (
        SELECT member FROM pings WHERE at >= ?
      )`,
    ).run(cutoff, cutoff)
    db.prepare(
      `DELETE FROM parties WHERE created_at < ? AND code NOT IN (SELECT party FROM members)`,
    ).run(cutoff)
  }

  function memberByToken(value) {
    if (!value || typeof value !== 'string' || value.length < 20) return undefined
    return db.prepare('SELECT id, party, name, token, color, created_at FROM members WHERE token = ?').get(value)
  }

  function snapshot(code, selfId, now = Date.now()) {
    const members = db.prepare('SELECT id, name, color FROM members WHERE party = ? ORDER BY created_at ASC').all(code)
    return {
      serverTime: now,
      members: members.map((member) => {
        const latest = db.prepare(
          'SELECT lat, lng, accuracy, heading, battery, at FROM pings WHERE member = ? ORDER BY at DESC LIMIT 1',
        ).get(member.id)
        const trail = db.prepare(
          'SELECT lat, lng, at FROM pings WHERE member = ? AND at >= ? ORDER BY at ASC',
        ).all(member.id, now - TRAIL_MS)
        return {
          id: member.id,
          name: member.name,
          color: member.color,
          you: member.id === selfId,
          lat: latest?.lat ?? null,
          lng: latest?.lng ?? null,
          accuracy: latest?.accuracy ?? null,
          heading: latest?.heading ?? null,
          battery: latest?.battery ?? null,
          updatedAt: latest?.at ?? null,
          trail: trail.map((point) => ({ lat: point.lat, lng: point.lng, at: point.at })),
        }
      }),
    }
  }

  function broadcast(code) {
    const group = sockets.get(code)
    if (!group || group.size === 0) return
    const body = JSON.stringify(snapshot(code, null))
    for (const socket of group) sendText(socket, body)
  }

  function createParty(now = Date.now()) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = partyCode()
      try {
        db.prepare('INSERT INTO parties (code, created_at) VALUES (?, ?)').run(code, now)
        return { code, createdAt: now }
      } catch {
        // rare collision
      }
    }
    const error = new Error('Could not start a party. Try again.')
    error.status = 500
    throw error
  }

  function join(code, rawName, ip, now = Date.now()) {
    expire(now)
    const recent = (joinsByIp.get(ip) ?? []).filter((time) => now - time < 60_000)
    if (recent.length >= 20) {
      const error = new Error('Too many joins. Wait a minute.')
      error.status = 429
      throw error
    }
    recent.push(now)
    joinsByIp.set(ip, recent)
    const party = db.prepare('SELECT code FROM parties WHERE code = ?').get(code)
    if (!party) {
      const error = new Error('No party with that code.')
      error.status = 404
      throw error
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM members WHERE party = ?').get(code).n
    if (count >= 8) {
      const error = new Error('That party is full.')
      error.status = 409
      throw error
    }
    const name = cleanName(rawName)
    const id = randomBytes(9).toString('base64url')
    const memberToken = token()
    const color = COLORS[count % COLORS.length]
    db.prepare(
      'INSERT INTO members (id, party, name, token, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, code, name, memberToken, color, now)
    broadcast(code)
    return { memberId: id, token: memberToken, name, color, code }
  }

  function recordPing(member, body, now = Date.now()) {
    const lat = Number(body?.lat)
    const lng = Number(body?.lng)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      const error = new Error('That location is not usable.')
      error.status = 400
      throw error
    }
    let at = Number(body?.at)
    if (!Number.isFinite(at) || at > now + 2 * 60_000 || at < now - DAY) at = now
    const accuracy = finiteOrNull(body?.accuracy, 0, 100_000)
    const heading = finiteOrNull(body?.heading, 0, 360)
    const battery = finiteOrNull(body?.battery, 0, 100)
    const last = db.prepare(
      'SELECT id, lat, lng, at FROM pings WHERE member = ? ORDER BY at DESC LIMIT 1',
    ).get(member.id)
    if (last && at >= last.at && haversine(last.lat, last.lng, lat, lng) < 12 && at - last.at < 20_000) {
      db.prepare('UPDATE pings SET at = ?, accuracy = ?, heading = ?, battery = ?, lat = ?, lng = ? WHERE id = ?').run(
        at,
        accuracy,
        heading,
        battery,
        lat,
        lng,
        last.id,
      )
    } else {
      db.prepare(
        'INSERT INTO pings (member, lat, lng, accuracy, heading, battery, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(member.id, lat, lng, accuracy, heading, battery, at)
    }
    broadcast(member.party)
    return { ok: true }
  }

  function leave(member) {
    db.prepare('DELETE FROM pings WHERE member = ?').run(member.id)
    db.prepare('DELETE FROM members WHERE id = ?').run(member.id)
    const left = db.prepare('SELECT COUNT(*) AS n FROM members WHERE party = ?').get(member.party).n
    if (left === 0) db.prepare('DELETE FROM parties WHERE code = ?').run(member.party)
    broadcast(member.party)
    return { ok: true }
  }

  const timer = setInterval(() => expire(), 60_000)
  if (typeof timer.unref === 'function') timer.unref()

  function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    if (req.method === 'OPTIONS') return send(req, res, 204, null)
    if (req.method === 'GET' && url.pathname === '/health') return send(req, res, 200, { ok: true })

    const partyMatch = url.pathname.match(/^\/v1\/parties\/([A-Z0-9]{8,16})(?:\/(join|ping|leave))?$/)
    if (req.method === 'POST' && url.pathname === '/v1/parties') {
      return readJson(req)
        .then(() => send(req, res, 200, createParty()))
        .catch((error) => send(req, res, error.status || 500, { error: error.message || 'Server error' }))
    }
    if (!partyMatch) return send(req, res, 404, { error: 'Not found' })
    const code = partyMatch[1]
    const action = partyMatch[2] || ''
    const auth = memberByToken(bearer(req) || url.searchParams.get('token') || '')

    if (req.method === 'POST' && action === 'join') {
      return readJson(req)
        .then((body) => send(req, res, 200, join(code, body?.name, req.socket.remoteAddress || 'unknown')))
        .catch((error) => send(req, res, error.status || 500, { error: error.message || 'Server error' }))
    }
    if (!auth || auth.party !== code) return send(req, res, 401, { error: 'Join the party again.' })
    if (req.method === 'GET' && !action) return send(req, res, 200, snapshot(code, auth.id))
    if (req.method === 'POST' && action === 'ping') {
      return readJson(req)
        .then((body) => send(req, res, 200, recordPing(auth, body)))
        .catch((error) => send(req, res, error.status || 500, { error: error.message || 'Server error' }))
    }
    if (req.method === 'POST' && action === 'leave') return send(req, res, 200, leave(auth))
    return send(req, res, 404, { error: 'Not found' })
  }

  const server = createServer((req, res) => {
    try {
      const pending = handle(req, res)
      if (pending && typeof pending.then === 'function') {
        pending.catch((error) => send(req, res, 500, { error: error.message || 'Server error' }))
      }
    } catch (error) {
      send(req, res, error.status || 500, { error: error.message || 'Server error' })
    }
  })

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/v1/ws') {
      socket.destroy()
      return
    }
    const code = (url.searchParams.get('party') || '').toUpperCase()
    const auth = memberByToken(url.searchParams.get('token') || '')
    const key = req.headers['sec-websocket-key']
    if (req.headers.origin && !allowOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!auth || auth.party !== code || !key) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n',
    )
    let group = sockets.get(code)
    if (!group) {
      group = new Set()
      sockets.set(code, group)
    }
    group.add(socket)
    sendText(socket, JSON.stringify(snapshot(code, auth.id)))
    socket.on('data', (buf) => {
      if (buf[0] === 0x89 || (buf[0] & 0x0f) === 0x9) {
        const pong = Buffer.from([0x8a, 0x00])
        socket.write(pong)
      }
    })
    socket.on('close', () => group.delete(socket))
    socket.on('error', () => group.delete(socket))
  })

  return {
    server,
    expire,
    close() {
      clearInterval(timer)
      server.close()
      db.close()
    },
  }
}

function finiteOrNull(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) return null
  return number
}

function bearer(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 16_384) {
        reject(Object.assign(new Error('Too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('Bad JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

const PAGES_ORIGIN = 'https://surestep2025.github.io'

function allowOrigin(origin) {
  if (!origin || typeof origin !== 'string') return '*'
  if (origin === PAGES_ORIGIN) return origin
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
  return null
}

function send(req, res, status, body) {
  const payload = body == null ? '' : JSON.stringify(body)
  const headers = {
    'Content-Type': body == null ? 'text/plain' : 'application/json; charset=utf-8',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
  }
  const allowed = allowOrigin(req.headers.origin)
  if (allowed) headers['Access-Control-Allow-Origin'] = allowed
  res.writeHead(status, headers)
  res.end(payload)
}

function sendText(socket, text) {
  const payload = Buffer.from(text)
  const length = payload.length
  let header
  if (length < 126) header = Buffer.from([0x81, length])
  else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 47231)
  const dbPath = process.env.PARTY_DB || '/tmp/joes-hunt-party.sqlite'
  const { server } = createPartyServer(dbPath)
  server.listen(port, '0.0.0.0', () => {
    console.log(`party server on :${port}`)
  })
}
