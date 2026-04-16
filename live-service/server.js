import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({
  origin: allowedOrigin
}));

const PORT = Number(process.env.PORT || 3000);
const SERVER_NAME = process.env.RUST_SERVER_NAME || 'Rust Server';

let events = [];

function pushEvent(type, message, icon = '⚡', data = {}) {
  const evt = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    type,
    message,
    icon,
    ts: Date.now(),
    data
  };

  events.unshift(evt);
  if (events.length > 200) events = events.slice(0, 200);
  console.log(`[event] ${message}`);
  return evt;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'rustwho-live',
    server: SERVER_NAME,
    now: Date.now()
  });
});

app.get('/events', (req, res) => {
  const since = Number(req.query.since || 0);
  const fresh = since ? events.filter(e => e.ts > since) : events.slice(0, 25);

  res.json({
    ok: true,
    serverTime: Date.now(),
    events: fresh
  });
});

/*
  Temporary manual ingest route.
  Replace or supplement this later with real Rust+/server hooks.
*/
app.post('/ingest', (req, res) => {
  const { type, player, state, message } = req.body || {};

  if (message) {
    const evt = pushEvent(type || 'custom', message, '📡');
    return res.json({ ok: true, event: evt });
  }

  if (type === 'player_join' && player) {
    const evt = pushEvent('player_join', `${player} joined ${SERVER_NAME}`, '🟢', { player });
    return res.json({ ok: true, event: evt });
  }

  if (type === 'player_leave' && player) {
    const evt = pushEvent('player_leave', `${player} left ${SERVER_NAME}`, '🔴', { player });
    return res.json({ ok: true, event: evt });
  }

  if (type === 'day_state' && state) {
    const pretty = state === 'night' ? 'Night started' : 'Day started';
    const evt = pushEvent('day_state', `${pretty} on ${SERVER_NAME}`, state === 'night' ? '🌙' : '☀️', { state });
    return res.json({ ok: true, event: evt });
  }

  return res.status(400).json({
    ok: false,
    error: 'Invalid ingest payload.'
  });
});

/*
  Demo event generator so the feed is not dead on day one.
  Remove this once real ingest is wired up.
*/
setInterval(() => {
  const demo = [
    () => pushEvent('day_state', `Night started on ${SERVER_NAME}`, '🌙', { state: 'night' }),
    () => pushEvent('day_state', `Day started on ${SERVER_NAME}`, '☀️', { state: 'day' }),
    () => pushEvent('player_join', `Player_${Math.floor(Math.random() * 999)} joined ${SERVER_NAME}`, '🟢'),
    () => pushEvent('player_leave', `Player_${Math.floor(Math.random() * 999)} left ${SERVER_NAME}`, '🔴')
  ];

  const fn = demo[Math.floor(Math.random() * demo.length)];
  fn();
}, 30000);

app.listen(PORT, () => {
  console.log(`Live service listening on port ${PORT}`);
});
