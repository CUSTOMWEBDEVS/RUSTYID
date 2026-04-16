const CONFIG = {
  SHEET_ID: 'PUT_YOUR_GOOGLE_SHEET_ID_HERE',
  STEAM_API_KEY: 'PUT_YOUR_STEAM_WEB_API_KEY_HERE',
  RUST_APP_ID: 252490,
  HISTORY_LIMIT: 50
};

function doGet(e) {
  const p = e && e.parameter ? e.parameter : {};
  const callback = p.callback || '';

  try {
    validateConfig_();
    ensureSheets_();

    const action = (p.action || 'health').trim();
    let payload;

    switch (action) {
      case 'health':
        payload = {
          ok: true,
          app: 'rustwho-gas',
          timestamp: new Date().toISOString()
        };
        break;

      case 'bootstrap':
        payload = bootstrap_();
        break;

      case 'search':
        payload = searchPlayer_(p.q || '');
        break;

      case 'addWatched':
        payload = addWatched_(p.steamid || '', p.name || '', p.status || 'watching');
        break;

      default:
        throw new Error('Unknown action: ' + action);
    }

    return output_(payload, callback);
  } catch (err) {
    return output_({
      ok: false,
      error: err && err.message ? err.message : String(err)
    }, callback);
  }
}

function output_(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    const safeCallback = sanitizeCallback_(callback);
    return ContentService
      .createTextOutput(`${safeCallback}(${json});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeCallback_(name) {
  const safe = String(name || '').replace(/[^\w.$]/g, '');
  if (!safe) throw new Error('Invalid callback name.');
  return safe;
}

function validateConfig_() {
  if (!CONFIG.SHEET_ID || CONFIG.SHEET_ID === 'PUT_YOUR_GOOGLE_SHEET_ID_HERE') {
    throw new Error('Set CONFIG.SHEET_ID in Code.gs.');
  }
  if (!CONFIG.STEAM_API_KEY || CONFIG.STEAM_API_KEY === 'PUT_YOUR_STEAM_WEB_API_KEY_HERE') {
    throw new Error('Set CONFIG.STEAM_API_KEY in Code.gs.');
  }
}

function sheet_() {
  return SpreadsheetApp.openById(CONFIG.SHEET_ID);
}

function ensureSheets_() {
  const ss = sheet_();

  ensureSheet_(ss, 'Searches', [
    'Timestamp',
    'Query',
    'SteamID',
    'Name',
    'RustHours',
    'VACBans',
    'GameBans',
    'ProfilePrivate',
    'RiskLevel',
    'Source'
  ]);

  ensureSheet_(ss, 'Watched', [
    'SteamID',
    'Name',
    'Status',
    'AddedAt',
    'LastCheckedAt'
  ]);

  ensureSheet_(ss, 'Names', [
    'SteamID',
    'Name',
    'FirstSeenAt',
    'LastSeenAt',
    'SeenCount'
  ]);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function bootstrap_() {
  const watched = getWatched_();
  const history = getHistory_();
  const activeBans = watched.filter(w => String(w.status || '').toLowerCase() === 'banned').length;

  return {
    ok: true,
    watched,
    history,
    summary: {
      watched: watched.length,
      searches: history.length,
      bans: activeBans
    }
  };
}

function searchPlayer_(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) throw new Error('Search query is required.');

  const resolved = resolveSteamInput_(query);
  const summary = getPlayerSummary_(resolved.steamId);
  if (!summary) throw new Error('Steam player not found.');

  const bans = getPlayerBans_(resolved.steamId);
  const rust = getRustGameDataSafe_(resolved.steamId);
  const steamLevel = getSteamLevelSafe_(resolved.steamId);

  recordNameSnapshot_(resolved.steamId, summary.personaname);
  const names = getNameHistory_(resolved.steamId, summary.personaname);

  const player = buildPlayerResult_(query, resolved, summary, bans, rust, steamLevel, names);

  logSearch_(query, player);
  refreshWatchedStatusIfExists_(player);

  return {
    ok: true,
    player
  };
}

function resolveSteamInput_(input) {
  const q = String(input).trim();

  if (/^7656119\d{10}$/.test(q)) {
    return { steamId: q, kind: 'steamid' };
  }

  const profilesMatch = q.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/i);
  if (profilesMatch) {
    return { steamId: profilesMatch[1], kind: 'profile-url' };
  }

  const vanityUrlMatch = q.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (vanityUrlMatch) {
    const steamId = resolveVanityUrl_(vanityUrlMatch[1]);
    return { steamId, kind: 'vanity-url', vanity: vanityUrlMatch[1] };
  }

  if (/^[A-Za-z0-9_-]{2,64}$/.test(q)) {
    const steamId = resolveVanityUrl_(q);
    return { steamId, kind: 'vanity', vanity: q };
  }

  throw new Error('Enter a valid SteamID64, Steam profile URL, or vanity name.');
}

function resolveVanityUrl_(vanity) {
  const data = steamGet_('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/', {
    vanityurl: vanity
  });

  const response = data && data.response ? data.response : {};
  if (String(response.success) !== '1' || !response.steamid) {
    throw new Error('Could not resolve vanity URL: ' + vanity);
  }

  return String(response.steamid);
}

function getPlayerSummary_(steamId) {
  const data = steamGet_('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/', {
    steamids: steamId
  });

  const players = data && data.response && data.response.players ? data.response.players : [];
  return players.length ? players[0] : null;
}

function getPlayerBans_(steamId) {
  const data = steamGet_('https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/', {
    steamids: steamId
  });

  const players = data && data.players ? data.players : [];
  return players.length ? players[0] : {
    NumberOfVACBans: 0,
    NumberOfGameBans: 0,
    DaysSinceLastBan: 0
  };
}

function getRustGameDataSafe_(steamId) {
  try {
    const data = steamGet_('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/', {
      steamid: steamId,
      include_appinfo: 'false',
      include_played_free_games: 'true'
    });

    const games = data && data.response && data.response.games ? data.response.games : [];
    const rust = games.find(g => Number(g.appid) === Number(CONFIG.RUST_APP_ID));
    if (!rust) return null;

    return {
      appid: rust.appid,
      playtime_forever: Number(rust.playtime_forever || 0),
      playtime_windows_forever: Number(rust.playtime_windows_forever || 0)
    };
  } catch (err) {
    return null;
  }
}

function getSteamLevelSafe_(steamId) {
  try {
    const data = steamGet_('https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/', {
      steamid: steamId
    });

    return data && data.response ? Number(data.response.player_level || 0) : 0;
  } catch (err) {
    return 0;
  }
}

function steamGet_(baseUrl, params) {
  const allParams = Object.assign({}, params || {}, { key: CONFIG.STEAM_API_KEY });
  const query = Object.keys(allParams)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(allParams[k]))
    .join('&');

  const url = baseUrl + '?' + query;

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error('Steam API error ' + code + ' for ' + baseUrl);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Steam API returned invalid JSON.');
  }
}

function buildPlayerResult_(query, resolved, summary, bans, rust, steamLevel, names) {
  const vacBans = Number(bans.NumberOfVACBans || 0);
  const gameBans = Number(bans.NumberOfGameBans || 0);
  const communityVisibility = Number(summary.communityvisibilitystate || 1);
  const profilePrivate = communityVisibility !== 3;

  const rustHours = rust ? round1_(Number(rust.playtime_forever || 0) / 60) : null;
  const memberSince = summary.timecreated ? formatDate_(summary.timecreated) : null;
  const accountAge = summary.timecreated ? formatAge_(summary.timecreated) : null;

  const riskLevel = determineRisk_(vacBans, gameBans, profilePrivate, rustHours);
  const notes = buildNotes_(summary, bans, rustHours, profilePrivate, riskLevel);

  return {
    query,
    resolvedBy: resolved.kind,
    name: summary.personaname || 'Unknown',
    steamId: String(summary.steamid || resolved.steamId),
    profileUrl: summary.profileurl || '',
    avatar: summary.avatarfull || summary.avatarmedium || summary.avatar || '',
    profilePrivate,
    accountAge,
    memberSince,
    vacBans,
    gameBans,
    serverBans: 0,
    lastBanDaysAgo: bans.DaysSinceLastBan !== undefined ? Number(bans.DaysSinceLastBan) : null,
    rustHours,
    steamHours: rustHours,
    privateHours: null,
    actualPlayingTime: null,
    names,
    banHistory: buildBanHistory_(vacBans, gameBans, bans.DaysSinceLastBan),
    activityPattern: 'Activity tracking has not been built yet in the MVP.',
    riskLevel,
    altLikelihood: 'low',
    notes,
    onlineStatus: getOnlineStatus_(summary),
    level: steamLevel || 0
  };
}

function buildBanHistory_(vacBans, gameBans, daysSinceLastBan) {
  const out = [];

  if (vacBans > 0) {
    out.push({
      server: 'Steam VAC',
      date: daysSinceLastBan !== null && daysSinceLastBan !== undefined ? daysSinceLastBan + ' days ago' : 'Unknown',
      active: true,
      type: 'vac'
    });
  }

  if (gameBans > 0) {
    out.push({
      server: 'Steam Game Ban',
      date: daysSinceLastBan !== null && daysSinceLastBan !== undefined ? daysSinceLastBan + ' days ago' : 'Unknown',
      active: true,
      type: 'game'
    });
  }

  return out;
}

function determineRisk_(vacBans, gameBans, profilePrivate, rustHours) {
  if (vacBans > 0) return 'very high';
  if (gameBans > 0) return 'high';
  if (profilePrivate && rustHours === null) return 'medium';
  return 'low';
}

function buildNotes_(summary, bans, rustHours, profilePrivate, riskLevel) {
  const parts = [];

  if (Number(bans.NumberOfVACBans || 0) > 0) {
    parts.push('Steam reports one or more VAC bans on this account.');
  } else if (Number(bans.NumberOfGameBans || 0) > 0) {
    parts.push('Steam reports one or more game bans on this account.');
  } else {
    parts.push('No Steam VAC or game bans were returned by the official API.');
  }

  if (rustHours === null) {
    parts.push('Rust hours were not visible from Steam, so this MVP leaves them unavailable instead of inventing a number.');
  } else {
    parts.push('Public Rust playtime is approximately ' + rustHours + ' hours.');
  }

  if (profilePrivate) {
    parts.push('The profile is not fully public, so some fields are naturally limited.');
  }

  parts.push('Overall risk is marked as ' + riskLevel + ' based on public Steam signals only.');

  return parts.join(' ');
}

function getOnlineStatus_(summary) {
  const personastate = Number(summary.personastate || 0);
  const gameid = String(summary.gameid || '');

  if (gameid === String(CONFIG.RUST_APP_ID)) return 'in-game';
  if (personastate > 0) return 'online';
  return 'offline';
}

function logSearch_(query, player) {
  const sh = sheet_().getSheetByName('Searches');
  sh.appendRow([
    new Date(),
    query,
    player.steamId,
    player.name,
    player.rustHours === null ? '' : player.rustHours,
    player.vacBans,
    player.gameBans,
    player.profilePrivate ? 'yes' : 'no',
    player.riskLevel,
    'steam-web-api'
  ]);
}

function addWatched_(steamId, name, status) {
  steamId = String(steamId || '').trim();
  name = String(name || '').trim();
  status = String(status || 'watching').trim();

  if (!steamId) throw new Error('steamid is required.');

  const sh = sheet_().getSheetByName('Watched');
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === steamId) {
      sh.getRange(i + 1, 2).setValue(name || values[i][1] || steamId);
      sh.getRange(i + 1, 3).setValue(status || values[i][2] || 'watching');
      sh.getRange(i + 1, 5).setValue(new Date());
      return { ok: true, message: 'Updated watch entry.' };
    }
  }

  sh.appendRow([
    steamId,
    name || steamId,
    status,
    new Date(),
    new Date()
  ]);

  return { ok: true, message: 'Added to watchlist.' };
}

function refreshWatchedStatusIfExists_(player) {
  const sh = sheet_().getSheetByName('Watched');
  const values = sh.getDataRange().getValues();
  const status = (player.vacBans + player.gameBans + player.serverBans) > 0 ? 'banned' : 'clean';

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === player.steamId) {
      sh.getRange(i + 1, 2).setValue(player.name);
      sh.getRange(i + 1, 3).setValue(status);
      sh.getRange(i + 1, 5).setValue(new Date());
      return;
    }
  }
}

function getWatched_() {
  const sh = sheet_().getSheetByName('Watched');
  const values = sh.getDataRange().getValues();

  return values.slice(1)
    .filter(r => r[0])
    .map(r => ({
      steamId: String(r[0]),
      name: String(r[1] || r[0]),
      status: String(r[2] || 'watching'),
      addedAt: toIso_(r[3]),
      lastCheckedAt: toIso_(r[4])
    }));
}

function getHistory_() {
  const sh = sheet_().getSheetByName('Searches');
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];

  const values = sh.getRange(2, 1, lastRow - 1, 10).getValues();

  return values
    .filter(r => r[2])
    .slice(-CONFIG.HISTORY_LIMIT)
    .reverse()
    .map(r => ({
      searchedAt: toIso_(r[0]),
      query: String(r[1] || ''),
      steamId: String(r[2] || ''),
      name: String(r[3] || ''),
      hours: r[4] === '' ? null : Number(r[4]),
      vacBans: Number(r[5] || 0),
      gameBans: Number(r[6] || 0),
      profilePrivate: String(r[7] || '') === 'yes',
      riskLevel: String(r[8] || 'low'),
      source: String(r[9] || '')
    }));
}

function recordNameSnapshot_(steamId, currentName) {
  if (!steamId || !currentName) return;

  const sh = sheet_().getSheetByName('Names');
  const values = sh.getDataRange().getValues();
  const now = new Date();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === steamId && String(values[i][1]) === currentName) {
      const seenCount = Number(values[i][4] || 1) + 1;
      sh.getRange(i + 1, 4).setValue(now);
      sh.getRange(i + 1, 5).setValue(seenCount);
      return;
    }
  }

  sh.appendRow([steamId, currentName, now, now, 1]);
}

function getNameHistory_(steamId, currentName) {
  const sh = sheet_().getSheetByName('Names');
  const values = sh.getDataRange().getValues();

  const rows = values.slice(1)
    .filter(r => String(r[0]) === String(steamId))
    .sort((a, b) => {
      const aTime = a[3] instanceof Date ? a[3].getTime() : 0;
      const bTime = b[3] instanceof Date ? b[3].getTime() : 0;
      return bTime - aTime;
    })
    .map(r => String(r[1]))
    .filter(Boolean);

  const unique = [];
  const seen = {};

  if (currentName) {
    unique.push(currentName);
    seen[currentName] = true;
  }

  rows.forEach(name => {
    if (!seen[name]) {
      unique.push(name);
      seen[name] = true;
    }
  });

  return unique.slice(0, 6);
}

function formatDate_(unixSeconds) {
  return Utilities.formatDate(
    new Date(Number(unixSeconds) * 1000),
    Session.getScriptTimeZone(),
    'MMM d, yyyy'
  );
}

function formatAge_(unixSeconds) {
  const then = new Date(Number(unixSeconds) * 1000);
  const now = new Date();

  let years = now.getFullYear() - then.getFullYear();
  let months = now.getMonth() - then.getMonth();

  if (months < 0) {
    years--;
    months += 12;
  }

  if (years < 0) years = 0;
  if (months < 0) months = 0;

  if (years === 0) return months + ' month' + (months === 1 ? '' : 's');
  return years + ' year' + (years === 1 ? '' : 's') + (months ? ', ' + months + ' month' + (months === 1 ? '' : 's') : '');
}

function round1_(n) {
  return Math.round(Number(n) * 10) / 10;
}

function toIso_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}
