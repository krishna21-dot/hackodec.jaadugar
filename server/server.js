// SyncSpace Backend Server
// Real-time WebSocket room coordination + static HTTP demo server
// Reference: PROTOCOL.md

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const OT = require('../web/ot.js'); // shared notepad editing logic (same file the browser uses)

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const LIMITS = {
  name: 24,
  key: 64,
  valueChars: 10000,
  keysPerRoom: 100,
  peersPerRoom: 25,
  cursorPerSec: 60,
  setPerSec: 30,
  docOpsPerSec: 100,
  counterPerSec: 30,
  docChars: 50000 // longest notepad text allowed
};

// History + saving settings
const DOC_LOG_MAX = 2000;        // recent notepad edits kept so late edits can be merged correctly
const DOC_HISTORY_MAX = 200;     // notepad history entries kept per room
const COUNTER_HISTORY_MAX = 100; // counter history entries kept per room
const HISTORY_MERGE_MS = 8000;   // typing by the same person within 8s becomes ONE history line
const SAVE_DELAY_MS = 2000;      // wait a little, then save to disk
const SAVED_ROOMS_MAX = 500;     // oldest rooms are forgotten after this many
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'rooms.json');

const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000; // 10 minutes
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// Room storage: roomId -> { state: Map, version: number, peers: Map(id -> peer), emptySince: timestamp|null }
const rooms = new Map();

// ---------------------------------------------------------------------------
// Room data that must be remembered: notepad text + history, counter + history.
// Kept in memory, and (when the server is started with `npm start`) also saved
// to a file so it survives a restart. See saveToDisk() below.
// ---------------------------------------------------------------------------
const saved = new Map();   // roomId -> plain data loaded from / written to disk
let persistenceOn = false; // switched on only when running as the real server
let saveTimer = null;

function newRoom(data) {
  data = data || {};
  const docRev = (data.doc && Number.isInteger(data.doc.rev)) ? data.doc.rev : 0;
  return {
    state: new Map(Object.entries(data.state || {})),
    version: data.version || 0,
    peers: new Map(),
    emptySince: null,
    // Notepad: text, revision number, and recent edits (log) used to merge simultaneous typing
    doc: { text: (data.doc && typeof data.doc.text === 'string') ? data.doc.text : '', rev: docRev, log: [] },
    docHistory: Array.isArray(data.docHistory) ? data.docHistory : [],
    histSeq: data.histSeq || 0,
    // Shared counter
    counter: {
      value: (data.counter && Number.isFinite(data.counter.value)) ? data.counter.value : 0,
      history: (data.counter && Array.isArray(data.counter.history)) ? data.counter.history : []
    }
  };
}

function serializeRoom(room) {
  const state = {};
  for (const [k, v] of room.state) {
    if (k.startsWith('typing_') || k === 'reaction') continue; // short-lived, not worth saving
    state[k] = v;
  }
  return {
    state,
    version: room.version,
    doc: { text: room.doc.text, rev: room.doc.rev },
    docHistory: room.docHistory,
    histSeq: room.histSeq,
    counter: room.counter,
    updated: Date.now()
  };
}

const roomHasData = room =>
  room.doc.text.length > 0 || room.docHistory.length > 0 ||
  room.counter.history.length > 0 || room.counter.value !== 0 || room.state.size > 0;

// Copy a live room into the "saved" map (called before saving and before a room leaves memory)
function snapshotRoom(roomId, room) {
  if (roomHasData(room)) saved.set(roomId, serializeRoom(room));
}

function saveToDisk() {
  if (!persistenceOn) return;
  for (const [id, r] of rooms) snapshotRoom(id, r);
  if (saved.size > SAVED_ROOMS_MAX) {
    const oldest = [...saved.entries()].sort((a, b) => (a[1].updated || 0) - (b[1].updated || 0));
    for (const [id] of oldest.slice(0, saved.size - SAVED_ROOMS_MAX)) saved.delete(id);
  }
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ rooms: Object.fromEntries(saved) }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Could not save room data:', e.message);
  }
}

function markDirty() {
  if (!persistenceOn || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveToDisk(); }, SAVE_DELAY_MS);
  saveTimer.unref();
}

function loadFromDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [id, r] of Object.entries(data.rooms || {})) {
      if (/^[A-Za-z0-9_-]{1,32}$/.test(id)) saved.set(id, r);
    }
    console.log(`💾 Loaded ${saved.size} saved room(s) from ${DATA_FILE}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read saved rooms:', e.message);
  }
}

// Add a notepad history line. Typing by the same person in quick succession is merged into one line.
function recordDocHistory(room, peer, change) {
  const now = Date.now();
  const last = room.docHistory[room.docHistory.length - 1];
  const clip = (a, b) => (a + b).slice(0, 80);
  if (last && last.userId === peer.id && now - last.endTs < HISTORY_MERGE_MS) {
    last.added += change.added.length;
    last.removed += change.removed.length;
    last.addedText = clip(last.addedText, change.added);
    last.removedText = clip(last.removedText, change.removed);
    last.name = peer.name;
    last.endTs = now;
    return last;
  }
  const entry = {
    id: ++room.histSeq,
    user: peer.name,
    userId: peer.id,
    color: peer.color,
    ts: now,
    endTs: now,
    added: change.added.length,
    removed: change.removed.length,
    addedText: change.added.slice(0, 80),
    removedText: change.removed.slice(0, 80)
  };
  room.docHistory.push(entry);
  if (room.docHistory.length > DOC_HISTORY_MAX) room.docHistory.shift();
  return entry;
}

// Send the whole notepad to one peer (used when their copy got out of step)
function sendDocResync(ws, room) {
  send(ws, { t: 'doc-resync', text: room.doc.text, rev: room.doc.rev });
}

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');

  // Health check endpoint
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'syncspace',
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      timestamp: Date.now()
    }));
  }

  // Serve static demo files
  const reqPath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  const fullPath = path.normalize(path.join(WEB_DIR, reqPath));

  // Security: prevent path traversal attacks
  if (!fullPath.startsWith(WEB_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Fallback for SPA routing if requested
      const indexPath = path.join(WEB_DIR, 'index.html');
      fs.readFile(indexPath, (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallbackData);
      });
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024, // 64 KB max message payload (big paste into the notepad)
  verifyClient: ({ origin }) => {
    if (ALLOWED_ORIGINS.length === 0 || !origin) return true;
    return ALLOWED_ORIGINS.includes(origin);
  }
});

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) { // 1 = OPEN
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      // socket closed during send
    }
  }
};

const broadcast = (room, msg, exceptId = null) => {
  for (const peer of room.peers.values()) {
    if (peer.id !== exceptId) {
      send(peer.ws, msg);
    }
  }
};

const publicPeer = p => ({ id: p.id, name: p.name, color: p.color });

const COLORS = [
  '#6366f1', // Indigo
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#8b5cf6', // Purple
  '#ef4444', // Red
  '#84cc16'  // Lime
];

const validId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);

function allowRateLimit(peer, kind, maxPerSec) {
  const now = Date.now();
  const bucket = peer.buckets[kind] || (peer.buckets[kind] = { t: now, count: 0 });
  if (now - bucket.t >= 1000) {
    bucket.t = now;
    bucket.count = 0;
  }
  return ++bucket.count <= maxPerSec;
}

wss.on('connection', (ws) => {
  let peer = null;
  let room = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: 'error', code: 'bad_json', message: 'Message must be valid JSON' });
    }

    if (!msg || typeof msg.t !== 'string') {
      return send(ws, { t: 'error', code: 'bad_message', message: 'Missing message type "t"' });
    }

    // Handle Join
    if (msg.t === 'join') {
      if (peer) {
        return send(ws, { t: 'error', code: 'already_joined', message: 'Already joined a room on this connection' });
      }
      if (!validId(msg.room)) {
        return send(ws, { t: 'error', code: 'bad_room', message: 'Room must be 1-32 chars: letters, numbers, - or _' });
      }

      const id = validId(msg.clientId) ? msg.clientId : Math.random().toString(36).slice(2, 10);
      room = rooms.get(msg.room);
      if (!room) {
        room = newRoom(saved.get(msg.room)); // restores notepad + history if this room was saved earlier
        rooms.set(msg.room, room);
      }

      // Reconnecting client with same ID terminates former socket
      const existing = room.peers.get(id);
      if (!existing && room.peers.size >= LIMITS.peersPerRoom) {
        room = null;
        return send(ws, { t: 'error', code: 'room_full', message: `Room is full (max ${LIMITS.peersPerRoom})` });
      }

      if (existing) {
        try {
          existing.ws.removeAllListeners('close');
          existing.ws.terminate();
        } catch {}
        room.peers.delete(id);
      }

      const name = String(msg.name || 'Guest').slice(0, LIMITS.name);
      const colorHash = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
      const color = COLORS[colorHash % COLORS.length];

      peer = { id, name, color, ws, buckets: {} };
      room.peers.set(id, peer);
      room.emptySince = null;

      // Welcome handshake with complete room state and active peer presence
      send(ws, {
        t: 'welcome',
        id,
        room: msg.room,
        version: room.version,
        state: Object.fromEntries(room.state),
        peers: [...room.peers.values()].map(publicPeer),
        doc: { text: room.doc.text, rev: room.doc.rev },
        // If the client says which notepad revision it had, send only the edits it missed
        docOps: (() => {
          const base = room.doc.rev - room.doc.log.length;
          if (Number.isInteger(msg.docRev) && msg.docRev >= base && msg.docRev <= room.doc.rev) {
            return room.doc.log.filter(e => e.rev > msg.docRev)
              .map(e => ({ rev: e.rev, op: e.op, by: e.by, opId: e.opId }));
          }
          return undefined;
        })(),
        docHistory: room.docHistory,
        counter: room.counter
      });

      // Announce arrival to all other peers in the room
      broadcast(room, { t: 'peer-join', peer: publicPeer(peer) }, id);
      return;
    }

    // Require join before any other message
    if (!peer || !room) {
      return send(ws, { t: 'error', code: 'not_joined', message: 'Must send "join" message first' });
    }

    // Handle State Update
    if (msg.t === 'set') {
      if (typeof msg.key !== 'string' || !msg.key || msg.key.length > LIMITS.key) {
        return send(ws, { t: 'error', code: 'bad_key', message: `Key must be 1-${LIMITS.key} characters` });
      }
      if (!allowRateLimit(peer, 'set', LIMITS.setPerSec)) {
        return send(ws, { t: 'error', code: 'rate_limited', message: 'Too many updates (rate limit exceeded)' });
      }

      if (msg.value === undefined) {
        room.state.delete(msg.key);
      } else {
        const serialized = JSON.stringify(msg.value);
        if (serialized.length > LIMITS.valueChars) {
          return send(ws, { t: 'error', code: 'too_big', message: `Value size exceeds ${LIMITS.valueChars} characters` });
        }
        if (!room.state.has(msg.key) && room.state.size >= LIMITS.keysPerRoom) {
          return send(ws, { t: 'error', code: 'too_many_keys', message: `Room key limit reached (${LIMITS.keysPerRoom})` });
        }
        room.state.set(msg.key, msg.value);
      }

      room.version++;
      // Broadcast state update to everyone else in the room
      broadcast(room, {
        t: 'state',
        key: msg.key,
        value: msg.value,
        by: peer.id,
        v: room.version
      }, peer.id);
    }
    // Handle notepad edit (merged safely even if several people type at once)
    else if (msg.t === 'doc-op') {
      if (!allowRateLimit(peer, 'doc', LIMITS.docOpsPerSec)) {
        sendDocResync(ws, room);
        return send(ws, { t: 'error', code: 'rate_limited', message: 'Typing too fast (rate limit exceeded)' });
      }
      const doc = room.doc;
      const baseRev = msg.rev;
      const logStart = doc.rev - doc.log.length;
      let op = msg.op;

      // A re-sent edit that the server already applied (confirmation was lost) -> just confirm again
      if (msg.resend && typeof msg.opId === 'string') {
        const done = doc.log.find(e => e.opId === msg.opId && e.by === peer.id);
        if (done) {
          return send(ws, { t: 'doc-ack', rev: done.rev, opId: msg.opId, entry: room.docHistory[room.docHistory.length - 1] });
        }
      }

      if (!Number.isInteger(baseRev) || baseRev < logStart || baseRev > doc.rev ||
          typeof msg.opId !== 'string' || msg.opId.length > 40 || !OT.isValid(op)) {
        return sendDocResync(ws, room);
      }

      try {
        // Move the edit forward past everything that happened since the client last saw the notepad
        for (const entry of doc.log) {
          if (entry.rev > baseRev) op = OT.transform(op, entry.op)[0];
        }
        if (OT.baseLength(op) !== doc.text.length ||
            OT.targetLength(op) > LIMITS.docChars) {
          return sendDocResync(ws, room);
        }
        const change = OT.describe(doc.text, op);
        doc.text = OT.apply(doc.text, op);
        doc.rev++;
        doc.log.push({ rev: doc.rev, op, by: peer.id, name: peer.name, opId: msg.opId });
        if (doc.log.length > DOC_LOG_MAX) doc.log.shift();

        const entry = recordDocHistory(room, peer, change);
        send(ws, { t: 'doc-ack', rev: doc.rev, opId: msg.opId, entry });
        broadcast(room, { t: 'doc-op', rev: doc.rev, op, by: peer.id, name: peer.name, opId: msg.opId, entry }, peer.id);
        markDirty();
      } catch (e) {
        sendDocResync(ws, room);
      }
    }
    // Client asks for a fresh copy of the notepad (it noticed it is out of step)
    else if (msg.t === 'doc-sync') {
      sendDocResync(ws, room);
    }
    // Handle shared counter button (the SERVER does the math so two clicks at once both count)
    else if (msg.t === 'counter') {
      if (!allowRateLimit(peer, 'counter', LIMITS.counterPerSec)) {
        return send(ws, { t: 'error', code: 'rate_limited', message: 'Too many counter clicks (rate limit exceeded)' });
      }
      const c = room.counter;
      const before = c.value;
      if (msg.action === 'inc') c.value += 1;
      else if (msg.action === 'dec') c.value -= 1;
      else if (msg.action === 'reset') c.value = 0;
      else return send(ws, { t: 'error', code: 'bad_action', message: 'Counter action must be inc, dec or reset' });

      const entry = {
        id: ++room.histSeq,
        user: peer.name,
        userId: peer.id,
        color: peer.color,
        ts: Date.now(),
        action: msg.action,
        delta: c.value - before,
        before,
        value: c.value
      };
      c.history.push(entry);
      if (c.history.length > COUNTER_HISTORY_MAX) c.history.shift();
      room.version++;
      // Everyone (including the person who clicked) gets the same result
      broadcast(room, { t: 'counter', value: c.value, entry });
      markDirty();
    }
    // Handle Live Cursor
    else if (msg.t === 'cursor') {
      if (!allowRateLimit(peer, 'cursor', LIMITS.cursorPerSec)) return;
      if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
      broadcast(room, {
        t: 'cursor',
        id: peer.id,
        x: msg.x,
        y: msg.y
      }, peer.id);
    }
    // Handle Keep-alive Ping
    else if (msg.t === 'ping') {
      send(ws, { t: 'pong' });
    }
    else {
      send(ws, { t: 'error', code: 'unknown_type', message: `Unknown message type "${msg.t}"` });
    }
  });

  ws.on('close', () => {
    if (!peer || !room) return;
    if (room.peers.get(peer.id) === peer) {
      room.peers.delete(peer.id);
      broadcast(room, { t: 'peer-leave', id: peer.id });
      if (room.peers.size === 0) {
        room.emptySince = Date.now();
      }
    }
  });

  ws.on('error', () => {});
});

// Periodic heartbeat: drop dead sockets and garbage collect abandoned rooms
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }

  const now = Date.now();
  for (const [roomId, r] of rooms) {
    if (r.emptySince && now - r.emptySince > EMPTY_ROOM_TTL_MS) {
      snapshotRoom(roomId, r); // keep notepad/counter + history so the room can be reopened later
      rooms.delete(roomId);
    }
  }
}, 30000);
heartbeatInterval.unref();

if (require.main === module) {
  // Running as the real server: remember room data in a file (data/rooms.json)
  persistenceOn = true;
  loadFromDisk();
  const flushAndExit = () => { saveToDisk(); process.exit(0); };
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);

  server.listen(PORT, () => {
    console.log(`🚀 SyncSpace server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
  });
}

module.exports = {
  server, wss, rooms, saved, newRoom, snapshotRoom, saveToDisk, loadFromDisk,
  enablePersistence: () => { persistenceOn = true; } // used by tests
};
