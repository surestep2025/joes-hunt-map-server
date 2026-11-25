import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createPartyServer } from './index.mjs'

async function listen(app) {
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  return `http://127.0.0.1:${address.port}`
}

test('two phones share a party and old points expire', async () => {
  const app = createPartyServer(':memory:')
  const base = await listen(app)
  try {
    const created = await fetch(`${base}/v1/parties`, { method: 'POST' }).then((res) => res.json())
    assert.match(created.code, /^[A-Z2-9]{12}$/)
    const joe = await fetch(`${base}/v1/parties/${created.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Joe' }),
    }).then((res) => res.json())
    const jojo = await fetch(`${base}/v1/parties/${created.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jojo' }),
    }).then((res) => res.json())
    assert.notEqual(joe.color, jojo.color)
    assert.equal(joe.token.length > 20, true)

    const ping = await fetch(`${base}/v1/parties/${created.code}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jojo.token}` },
      body: JSON.stringify({ lat: 43.89, lng: -90.17, accuracy: 8, heading: 20, battery: 70, at: Date.now() }),
    })
    assert.equal(ping.status, 200)

    const view = await fetch(`${base}/v1/parties/${created.code}`, {
      headers: { Authorization: `Bearer ${joe.token}` },
    }).then((res) => res.json())
    const son = view.members.find((member) => member.name === 'Jojo')
    assert.equal(son.lat, 43.89)
    assert.equal(son.you, false)
    assert.equal(view.members.find((member) => member.name === 'Joe').you, true)

    const preflight = await fetch(`${base}/v1/parties`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://surestep2025.github.io',
        'Access-Control-Request-Method': 'POST',
      },
    })
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://surestep2025.github.io')
    const blocked = await fetch(`${base}/health`, { headers: { Origin: 'https://example.com' } })
    assert.equal(blocked.headers.get('access-control-allow-origin'), null)

    const revived = 'H7K2M9Q4W3NP'
    const revivedJoin = await fetch(`${base}/v1/parties/${revived}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Joe' }),
    })
    assert.equal(revivedJoin.status, 200)

    const missing = await fetch(`${base}/v1/parties/11111111/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })
    assert.equal(missing.status, 404)

    const trackAt = Date.now() - 2 * 24 * 60 * 60 * 1000
    const uploaded = await fetch(`${base}/v1/parties/${created.code}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jojo.token}` },
      body: JSON.stringify({
        points: [
          { lat: 43.89, lng: -90.17, accuracy: 8, at: trackAt },
          { lat: 43.891, lng: -90.17, accuracy: 80, at: trackAt + 1000 },
          { lat: 43.892, lng: -90.17, accuracy: 8, at: trackAt },
        ],
      }),
    })
    assert.equal(uploaded.status, 200)
    const tracks = await fetch(`${base}/v1/parties/${created.code}/tracks`, {
      headers: { Authorization: `Bearer ${joe.token}` },
    }).then((res) => res.json())
    const jojoTrack = tracks.tracks.find((track) => track.name === 'Jojo')
    assert.equal(jojoTrack.points.length, 1)
    assert.equal(jojoTrack.points[0].at, trackAt)

    app.expire(Date.now() + 25 * 60 * 60 * 1000)
    const gone = await fetch(`${base}/v1/parties/${created.code}`, {
      headers: { Authorization: `Bearer ${joe.token}` },
    })
    assert.equal(gone.status, 401)
    const kept = await fetch(`${base}/v1/parties/${created.code}/tracks`, {
      headers: { Authorization: `Bearer ${jojo.token}` },
    }).then((res) => res.json())
    assert.equal(kept.tracks.find((track) => track.name === 'Jojo').points.length, 1)

    app.expire(Date.now() + 5 * 24 * 60 * 60 * 1000)
    const dropped = await fetch(`${base}/v1/parties/${created.code}/tracks`, {
      headers: { Authorization: `Bearer ${jojo.token}` },
    })
    assert.equal(dropped.status, 401)
  } finally {
    app.close()
  }
})
