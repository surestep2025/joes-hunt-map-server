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

After the service is up, set the map's `config.json` next to `index.html`:

```json
{ "partyApi": "https://your-service.onrender.com" }
```

Free web services sleep when nobody has called them for a while. The map retries joining for about 60 seconds and shows "Waking server…" while Render starts. A restart clears the SQLite file, because the free disk does not keep it. Positions already expire after 24 hours.

## Local

```bash
npm install
npm test
npm start
```

`npm start` is `node server/index.mjs`. Without `PORT`, it listens on 47231.
