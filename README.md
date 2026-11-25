# Joe's Hunt Map party server

Small Node service that shares live GPS between phones in one hunt party. No accounts. A party code is the only secret.

## Render

- Runtime: Node
- Build command: `npm install`
- Start command: `node server/index.mjs`
- Node: 22 (`engines` in package.json). The server uses the built-in `node:sqlite` module.

Render sets `PORT`. The process listens on `0.0.0.0` and that port.

`GET /health` returns `{ "ok": true }`.

CORS allows the map at `https://surestep2025.github.io` (including `https://surestep2025.github.io/joes-hunt-map/`). Localhost is allowed for development.

Joining a 12-character crew code creates that party if a restart wiped the database, so the same crew link keeps working. Live dots still drop off after 24 hours. Walked tracks are kept for 4 days.

`POST /v1/parties/:code/track` stores points. `GET /v1/parties/:code/tracks` returns every member's line. Older map builds never call those routes, so they keep sharing dots.

After the service is up, set the map's `config.json` next to `index.html`:

```json
{ "partyApi": "https://your-service.onrender.com" }
```

The live map already uses `https://joes-hunt-map-server.onrender.com`.

Free web services sleep when nobody has called them for a while. The map retries joining for about 60 seconds and shows "Waking server…" while Render starts. A restart clears the SQLite file, because the free disk does not keep it. Each phone keeps its own track and uploads it again when the server is missing those points, so the lines come back when the phones are open. A free Render Postgres database expires after 30 days and is not required.

Put this server up before the new map if you can. If the map lands first, phones hold the walk and upload it once this server is deployed. Live dots keep working either way.

## Local

```bash
npm install
npm test
npm start
```

`npm start` is `node server/index.mjs`. Without `PORT`, it listens on 47231.
