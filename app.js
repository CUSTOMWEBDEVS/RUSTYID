const CONFIG = {
  gasUrl: 'https://script.google.com/macros/s/AKfycbynsZOzOqlE8W3GN_eIzXDRrOWwa2ffgWL0_4ajV1VeQtJFa-8pG_JKQklyXkximmJ8/exec',
  liveUrl: '',
  livePollMs: 5000,
  serverPollMs: 10000
};

const state = {
  watched: [],
  history: [],
  summary: { watched: 0, searches: 0, bans: 0 },
  liveSince: 0,
  liveEvents: [],
  servers: [],
  featuredServer: null
};

document.addEventListener('DOMContentLoaded', async () => {
  bindConfigInputs();
  renderDashboard();
  renderLiveFeed();
  renderServerTiming();
  await bootstrap();
  startLivePolling();
});

function bindConfigInputs() {
  const gasInput = document.getElementById('scriptUrlInput');
  const liveInput = document.getElementById('liveServiceUrlInput');
  if (gasInput) gasInput.value = CONFIG.gasUrl;
  if (liveInput) liveInput.value = CONFIG.liveUrl;
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const page = document.getElementById('page-' + id);
  if (page) page.classList.add('active');
  const nav = document.getElementById('nav-' + id);
  if (nav) nav.classList.add('active');
  window.scrollTo(0, 0);
}

async function bootstrap() {
  if (!CONFIG.gasUrl) return;
  try {
    const res = await api('bootstrap');
    state.watched = res.watched || [];
    state.history = res.history || [];
    state.summary = res.summary || state.summary;
    renderDashboard();
    const status = document.getElementById('sheetsStatus');
    if (status) status.innerHTML = '<div class="connected-badge">✓ Connected to Google Sheets backend</div>';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function saveBackendUrls() {
  const gasInput = document.getElementById('scriptUrlInput');
  const liveInput = document.getElementById('liveServiceUrlInput');
  CONFIG.gasUrl = gasInput ? gasInput.value.trim() : '';
  CONFIG.liveUrl = liveInput ? liveInput.value.trim() : '';
  localStorage.setItem('rw_gas_url', CONFIG.gasUrl);
  localStorage.setItem('rw_live_url', CONFIG.liveUrl);
  showToast('Backend URLs saved.', 'success');
  pollServers();
  pollLiveEvents();
}

async function testConnections() {
  try {
    if (CONFIG.gasUrl) {
      const health = await jsonp(CONFIG.gasUrl, { action: 'health' });
      if (!health || health.ok === false) throw new Error('Apps Script failed health check.');
    }
    if (CONFIG.liveUrl) {
      const res = await fetch(CONFIG.liveUrl.replace(/\/$/, '') + '/health');
      if (!res.ok) throw new Error('Live service failed health check.');
    }
    showToast('Connections look good.', 'success');
    await bootstrap();
    await pollServers();
    await pollLiveEvents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function prefill(value) {
  const input = document.getElementById('searchInput');
  if (!input) return;
  input.value = value;
  input.focus();
}

function jsonp(url, params = {}) {
  return new Promise((resolve, reject) => {
    const callbackName = '__rwcb_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
    const script = document.createElement('script');
    const u = new URL(url);

    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) u.searchParams.set(k, v);
    });
    u.searchParams.set('callback', callbackName);

    let finished = false;

    function cleanup() {
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (data) => {
      finished = true;
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      if (finished) return;
      cleanup();
      reject(new Error('Failed to reach Apps Script backend.'));
    };

    script.src = u.toString();
    document.body.appendChild(script);

    setTimeout(() => {
      if (!finished) {
        cleanup();
        reject(new Error('Apps Script request timed out.'));
      }
    }, 15000);
  });
}

async function api(action, params = {}) {
  if (!CONFIG.gasUrl) throw new Error('Apps Script URL is not set.');
  const data = await jsonp(CONFIG.gasUrl, { action, ...params });
  if (!data || data.ok === false) {
    throw new Error((data && data.error) || 'Unknown Apps Script error.');
  }
  return data;
}

async function runSearch() {
  const input = document.getElementById('searchInput');
  const query = input ? input.value.trim() : '';
  if (!query) {
    showToast('Enter a SteamID64, Steam URL, or vanity.', 'error');
    return;
  }

  const resultArea = document.getElementById('resultArea');
  if (!resultArea) return;

  resultArea.style.display = 'block';
  resultArea.innerHTML = `
    <div class="result-wrapper">
      <div class="result-card">
        <div class="loading-overlay">
          <div class="spinner"></div>
          <div class="loading-text">Searching public Steam data…</div>
        </div>
      </div>
    </div>
  `;

  try {
    const res = await api('search', { q: query });
    renderResult(res.player);
    await bootstrap();
  } catch (err) {
    resultArea.innerHTML = `
      <div class="result-wrapper">
        <div class="result-card" style="padding:2rem;text-align:center;color:var(--text2);">
          ${escapeHtml(err.message)}
        </div>
      </div>
    `;
  }
}

function renderResult(p) {
  const resultArea = document.getElementById('resultArea');
  if (!resultArea) return;

  const badges = [];
  if ((p.vacBans || 0) === 0 && (p.gameBans || 0) === 0) badges.push('<span class="badge badge-clean">Clean</span>');
  if ((p.vacBans || 0) > 0) badges.push(`<span class="badge badge-vac">VAC x${p.vacBans}</span>`);
  if ((p.gameBans || 0) > 0) badges.push(`<span class="badge badge-ban">Game Bans x${p.gameBans}</span>`);
  if (p.profilePrivate) badges.push('<span class="badge badge-private">Private / Limited</span>');

  const namesHtml = (p.names || []).length
    ? p.names.map((name, i) => `<div class="name-row"><span>${escapeHtml(name)}</span>${i === 0 ? '<span class="current">Current</span>' : ''}</div>`).join('')
    : '<div class="empty-state">No tracked names yet.</div>';

  const bansHtml = (p.banHistory || []).length
    ? p.banHistory.map(b => `<div class="ban-row"><div class="ban-server">${escapeHtml(b.server)}</div><div class="ban-date">${escapeHtml(b.date || '')}</div></div>`).join('')
    : '<div class="empty-state">No public ban entries returned.</div>';

  resultArea.innerHTML = `
    <div class="result-wrapper">
      <div class="result-card">
        <div class="result-header">
          <div class="avatar">${p.avatar ? `<img src="${escapeHtml(p.avatar)}" alt="">` : '👤'}</div>
          <div class="result-name-block">
            <div class="result-name">${escapeHtml(p.name)}</div>
            <div class="result-steamid">${escapeHtml(p.steamId)}</div>
            <div class="badge-row">${badges.join('')}</div>
          </div>
          <button class="btn btn-primary" onclick="addToWatchlist('${escapeHtml(p.steamId)}','${escapeHtml(p.name)}')">+ Watch</button>
        </div>

        <div class="stats-grid">
          <div class="stat-cell">
            <div class="stat-label">Rust Hours</div>
            <div class="stat-value">${p.rustHours == null ? 'Unavailable' : escapeHtml(String(p.rustHours))}</div>
            <div class="stat-sub">${p.rustHours == null ? 'Hidden/private or unavailable' : 'Public Steam data'}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">Steam Level</div>
            <div class="stat-value">${escapeHtml(String(p.level || 0))}</div>
            <div class="stat-sub">Public Steam level</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">Account Age</div>
            <div class="stat-value">${escapeHtml(p.accountAge || 'Unknown')}</div>
            <div class="stat-sub">Member since ${escapeHtml(p.memberSince || 'Unknown')}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">Status</div>
            <div class="stat-value">${escapeHtml(p.onlineStatus || 'offline')}</div>
            <div class="stat-sub">Steam presence only</div>
          </div>
        </div>

        <div class="result-sections">
          <div>
            <div class="section-title">Name History</div>
            <div class="name-history">${namesHtml}</div>
          </div>
          <div>
            <div class="section-title">Ban History</div>
            <div class="ban-history">${bansHtml}</div>
          </div>
          <div class="ai-analysis">
            <div class="ai-label">Public Data Analysis</div>
            ${escapeHtml(p.notes || 'No notes available.')}
          </div>
        </div>
      </div>
    </div>
  `;
}

async function addToWatchlist(steamId, name) {
  try {
    await api('addWatched', { steamid: steamId, name, status: 'watching' });
    showToast('Added to watchlist.', 'success');
    await bootstrap();
    showPage('dashboard');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderDashboard() {
  const watchedEl = document.getElementById('watchedList');
  const recentEl = document.getElementById('recentSearches');

  const watchedCount = state.summary.watched || state.watched.length || 0;
  const searchCount = state.summary.searches || state.history.length || 0;
  const banCount = state.summary.bans || state.watched.filter(w => String(w.status).toLowerCase() === 'banned').length || 0;

  const sw = document.getElementById('stat-watched');
  const ss = document.getElementById('stat-searches');
  const sb = document.getElementById('stat-bans');
  if (sw) sw.textContent = watchedCount;
  if (ss) ss.textContent = searchCount;
  if (sb) sb.textContent = banCount;

  if (watchedEl) {
    watchedEl.innerHTML = state.watched.length
      ? state.watched.map(w => `
        <div class="watched-item">
          <span>👤</span>
          <span class="watched-name">${escapeHtml(w.name)}</span>
          <span class="watched-alert ${String(w.status).toLowerCase() === 'banned' ? 'alert-ban' : 'alert-ok'}">${escapeHtml(w.status || 'watching')}</span>
        </div>
      `).join('')
      : '<div class="empty-state">No watched players yet.</div>';
  }

  if (recentEl) {
    recentEl.innerHTML = state.history.length
      ? state.history.slice(0, 8).map(h => `
        <div class="recent-item" onclick="quickSearch('${escapeHtml(h.steamId)}')">
          <span>👤</span>
          <span>${escapeHtml(h.name)}</span>
          <span class="ago">${timeAgo(h.searchedAt)}</span>
        </div>
      `).join('')
      : '<div class="empty-state">No searches yet.</div>';
  }
}

function quickSearch(id) {
  showPage('home');
  const input = document.getElementById('searchInput');
  if (!input) return;
  input.value = id;
  setTimeout(runSearch, 100);
}

async function pollLiveEvents() {
  if (!CONFIG.liveUrl) return;
  try {
    const base = CONFIG.liveUrl.replace(/\/$/, '');
    const url = new URL(base + '/events');
    url.searchParams.set('since', String(state.liveSince || 0));
    const res = await fetch(url.toString());
    if (!res.ok) return;
    const data = await res.json();
    const events = data.events || [];
    if (events.length) {
      state.liveSince = data.serverTime || Date.now();
      state.liveEvents = [...events, ...state.liveEvents].slice(0, 50);
      renderLiveFeed();
    }
  } catch (_) {}
}

async function pollServers() {
  if (!CONFIG.liveUrl) return;
  try {
    const base = CONFIG.liveUrl.replace(/\/$/, '');
    const res = await fetch(base + '/servers');
    if (!res.ok) return;
    const data = await res.json();
    state.servers = Array.isArray(data.servers) ? data.servers : [];
    state.featuredServer = state.servers.length ? state.servers[0] : null;
    renderServerTiming();
  } catch (_) {}
}

function startLivePolling() {
  pollLiveEvents();
  pollServers();
  setInterval(pollLiveEvents, CONFIG.livePollMs);
  setInterval(pollServers, CONFIG.serverPollMs);
}

function renderLiveFeed() {
  const list = document.getElementById('activityList');
  if (!list) return;

  if (!state.liveEvents.length) {
    list.innerHTML = `
      <div class="activity-item">
        <span>🛰️</span>
        <span>Waiting for live server events…</span>
        <span class="time">now</span>
      </div>
    `;
    return;
  }

  list.innerHTML = state.liveEvents.map(evt => `
    <div class="activity-item">
      <span>${escapeHtml(evt.icon || '⚡')}</span>
      <span>${escapeHtml(evt.message)}</span>
      <span class="time">${timeAgo(evt.ts)}</span>
    </div>
  `).join('');
}

function renderServerTiming() {
  const wrap = document.getElementById('serverTimingList');
  const stat = document.getElementById('featuredServerStatus');
  const count = document.getElementById('trackedServerCount');

  if (count) {
    count.textContent = String(state.servers.length || 0);
  }

  if (stat) {
    if (!state.featuredServer) {
      stat.innerHTML = `
        <div class="timing-empty">
          No server timing reported yet.<br>
          Use your in-game command and post to <code>/report-time</code>.
        </div>
      `;
    } else {
      const s = state.featuredServer;
      stat.innerHTML = `
        <div class="featured-server-name">${escapeHtml(s.serverName)}</div>
        <div class="featured-server-time">${escapeHtml(s.currentTime || '--:--')}</div>
        <div class="featured-server-label">${escapeHtml(s.timingLabel || 'Timing unavailable')}</div>
        <div class="featured-server-meta">
          Last updated ${timeAgo(s.lastSeen)}
          ${s.playerCount != null ? `• ${escapeHtml(String(s.playerCount))} online` : ''}
        </div>
      `;
    }
  }

  if (!wrap) return;

  if (!state.servers.length) {
    wrap.innerHTML = `
      <div class="empty-state">No discovered servers yet.</div>
    `;
    return;
  }

  wrap.innerHTML = state.servers.map(server => `
    <div class="server-row">
      <div class="server-row-main">
        <div class="server-row-name">${escapeHtml(server.serverName)}</div>
        <div class="server-row-sub">
          ${escapeHtml(server.currentTime || '--:--')} • ${escapeHtml(server.timingLabel || 'Timing unavailable')}
        </div>
      </div>
      <div class="server-row-right">
        ${server.playerCount != null ? `<div class="server-row-count">${escapeHtml(String(server.playerCount))} online</div>` : ''}
        <div class="server-row-seen">${timeAgo(server.lastSeen)}</div>
      </div>
    </div>
  `).join('');
}

function timeAgo(value) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.borderLeft = type === 'error'
    ? '3px solid var(--red)'
    : type === 'success'
      ? '3px solid var(--green)'
      : '3px solid var(--orange)';
  toast.classList.add('show');
  clearTimeout(window.__rwToastTimer);
  window.__rwToastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}