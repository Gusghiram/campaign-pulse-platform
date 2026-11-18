/**
 * ============================================================================
 * SERVERLESS API GATEWAY: Google Sheets + BigQuery -> GitHub Pages / Sites
 * ============================================================================
 */
const CONFIG = {
  GCP_PROJECT_ID: 'taurocampaigns',
  BQ_DATASET: 'music_campaigns',
  USE_BIGQUERY_FOR_FACTS: true // Automatically falls back to Hoja 1 / Streams if false
};

function doGet(e) {
  if (e && e.parameter && e.parameter.api === '1') {
    const email = (e.parameter.email || '').trim().toLowerCase();
    const password = e.parameter.password || '';
    const payload = getDashboardPayload(email, password);
    return ContentService
      .createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('CampaignPulse | Music Label Intelligence')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function normalizeArtist(name) {
  if (!name) return '';
  const raw = String(name).trim();
  const lower = raw.toLowerCase();
  if (lower === 'bellakath') return 'Bellakath';
  if (lower === 'jeyone' || lower === 'jey one') return 'Jey One';
  if (lower === 'kaia luna' || lower === 'kaia lana') return 'Kaia Lana';
  if (lower === 'brytiago') return 'Brytiago';
  return raw;
}

function normalizeCompany(company) {
  if (!company) return 'Independent / Agency';
  const c = String(company).trim().toLowerCase();
  if (c.includes('sony')) return 'Sony Music';
  if (c.includes('warner')) return 'Warner Music';
  if (c.includes('onerpm')) return 'ONErpm';
  if (c === 'se' || c.includes('seitrack')) return 'Seitrack';
  if (c.includes('solido')) return 'Solido Records';
  if (c.includes('bam')) return 'BAM Music';
  return String(company).trim();
}

function getFieldCI(rowObj, targetKey) {
  if (!rowObj) return undefined;
  const target = targetKey.toLowerCase();
  const foundKey = Object.keys(rowObj).find(k => k.trim().toLowerCase() === target);
  return foundKey !== undefined ? rowObj[foundKey] : undefined;
}

function validateGovernanceUser(govRows, email, password) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(password ?? '').trim();

  const userRows = govRows.filter(r => {
    const rowEmail = String(getFieldCI(r, 'email') || '').trim().toLowerCase();
    return rowEmail === cleanEmail;
  });

  if (!userRows.length) {
    return {
      authorized: false,
      message: 'Access denied: ' + cleanEmail + ' is not registered in the Governance tab.'
    };
  }

  const hasPasswordCol = govRows.some(r =>
    Object.keys(r).some(k => k.trim().toLowerCase() === 'password')
  );

  if (hasPasswordCol) {
    const validPassword = userRows.some(r => {
      const rawPwd = getFieldCI(r, 'password');
      return rawPwd !== undefined && rawPwd !== null && String(rawPwd).trim() === cleanPassword;
    });

    if (!validPassword) {
      return {
        authorized: false,
        message: 'Incorrect password.'
      };
    }
  }

  return { authorized: true, userRows };
}

function getDashboardPayload(emailInput, passwordInput) {
  const email = String(emailInput || '').trim().toLowerCase();
  const password = String(passwordInput ?? '').trim();

  if (!email) {
    return { authorized: false, message: 'Please provide a valid email address.' };
  }
  if (!password) {
    return { authorized: false, message: 'Please enter your password.' };
  }

  const govRows = getSheetObjects('Governance');
  const insightRows = getSheetObjects('Insights');

  // Validate email + password against Governance sheet
  const authCheck = validateGovernanceUser(govRows, email, password);
  if (!authCheck.authorized) {
    return {
      authorized: false,
      message: authCheck.message
    };
  }

  const allowedArtistsSet = new Set();
  const allowedArtistsLowerSet = new Set();
  const companiesSet = new Set();
  let isAdmin = false;

  // PASS 1: Collect user's authorized companies & direct artists from validated rows
  authCheck.userRows.forEach(r => {
    const rawCompany = String(getFieldCI(r, 'company') || '').trim();
    if (rawCompany) {
      const normComp = normalizeCompany(rawCompany);
      companiesSet.add(normComp);
      const cLower = normComp.toLowerCase();
      if (cLower.includes('tauro') || cLower === 'admin' || cLower === 'all') {
        isAdmin = true;
      }
    }
    const directArt = normalizeArtist(getFieldCI(r, 'artist'));
    if (directArt) {
      allowedArtistsSet.add(directArt);
      allowedArtistsLowerSet.add(directArt.toLowerCase());
    }
  });

  // PASS 2: Collect all artists belonging to the user's company (if listed in Governance)
  govRows.forEach(r => {
    const rawCompany = String(getFieldCI(r, 'company') || '').trim();
    const normComp = rawCompany ? normalizeCompany(rawCompany) : '';

    if (isAdmin || (normComp && companiesSet.has(normComp))) {
      const art = normalizeArtist(getFieldCI(r, 'artist'));
      if (art) {
        allowedArtistsSet.add(art);
        allowedArtistsLowerSet.add(art.toLowerCase());
      }
    }
  });

  // Non-admins must have at least one artist assigned to their company
  if (!isAdmin && allowedArtistsSet.size === 0) {
    return {
      authorized: false,
      message: 'Access denied: No artists are assigned to your company in the Governance tab.'
    };
  }

  const allowedArtistsLower = Array.from(allowedArtistsLowerSet);

  let rrss = [];
  let streams = [];

  if (CONFIG.USE_BIGQUERY_FOR_FACTS && CONFIG.GCP_PROJECT_ID && CONFIG.GCP_PROJECT_ID !== 'YOUR_GCP_PROJECT_ID') {
    rrss = queryBigQueryRRSS(allowedArtistsLower, isAdmin).map(r => ({
      ...r,
      artist: normalizeArtist(r.artist)
    }));
    streams = queryBigQueryStreams(allowedArtistsLower, isAdmin).map(s => ({
      ...s,
      artist: normalizeArtist(s.artist)
    }));
  } else {
    rrss = getFallbackSheetRRSS(allowedArtistsLowerSet, isAdmin);
    streams = getFallbackSheetStreams(allowedArtistsLowerSet, isAdmin);
  }

  // If Admin/Tauro, populate allowedArtists automatically from all artists found in the data
  if (isAdmin) {
    rrss.forEach(r => {
      if (r.artist) {
        allowedArtistsSet.add(r.artist);
        allowedArtistsLowerSet.add(r.artist.toLowerCase());
      }
    });
    streams.forEach(s => {
      if (s.artist) {
        allowedArtistsSet.add(s.artist);
        allowedArtistsLowerSet.add(s.artist.toLowerCase());
      }
    });
  }

  const insights = insightRows
    .map(r => ({
      campaign: String(r['campaign'] || r['Campaign'] || '').trim(),
      artist: normalizeArtist(r['artist'] || r['Artist']),
      created_at: String(r['created_at'] || r['Date'] || '').slice(0, 10),
      insight: String(r['Insight'] || r['insight'] || '').trim()
    }))
    .filter(r => r.artist && (isAdmin || allowedArtistsLowerSet.has(r.artist.toLowerCase())));

  return {
    authorized: true,
    user: {
      email: email,
      companies: Array.from(companiesSet),
      allowedArtists: Array.from(allowedArtistsSet).sort()
    },
    rrss: rrss,
    streams: streams,
    insights: insights
  };
}

function queryBigQueryRRSS(allowedArtistsLower, isAdmin) {
  const whereClause = isAdmin ? '' : 'WHERE LOWER(TRIM(artist)) IN UNNEST(@artists)';
  const sql = `
    SELECT
      CAST(snapshot_date AS STRING) AS created_at,
      platform,
      platform_raw AS platformRaw,
      url,
      likes,
      all_reactions,
      comments,
      shares,
      favorites,
      views,
      repost,
      reply,
      bookmarks,
      interactions,
      campaign,
      artist,
      is_latest_snapshot,
      delta_views
    FROM \`${CONFIG.GCP_PROJECT_ID}.${CONFIG.BQ_DATASET}.vw_rrss_enriched\`
    ${whereClause}
    ORDER BY snapshot_date DESC, views DESC
  `;
  return isAdmin ? runBigQueryNoParams(sql) : runBigQueryArrayParam(sql, 'artists', allowedArtistsLower);
}

function queryBigQueryStreams(allowedArtistsLower, isAdmin) {
  const whereClause = isAdmin ? '' : 'WHERE LOWER(TRIM(artist)) IN UNNEST(@artists)';
  const sql = `
    SELECT
      CAST(stream_date AS STRING) AS date,
      artist,
      song,
      MAX(daily_streams) AS streams,
      MAX(accumulated_streams) AS accumulated_streams
    FROM \`${CONFIG.GCP_PROJECT_ID}.${CONFIG.BQ_DATASET}.fact_streams_daily\`
    ${whereClause}
    GROUP BY stream_date, artist, song
    ORDER BY stream_date ASC
  `;
  return isAdmin ? runBigQueryNoParams(sql) : runBigQueryArrayParam(sql, 'artists', allowedArtistsLower);
}

function runBigQueryArrayParam(sql, paramName, values) {
  const request = {
    query: sql,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [{
      name: paramName,
      parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
      parameterValue: { arrayValues: values.map(v => ({ value: v })) }
    }]
  };
  return executeBigQueryRequest(request);
}

function runBigQueryNoParams(sql) {
  const request = {
    query: sql,
    useLegacySql: false
  };
  return executeBigQueryRequest(request);
}

function executeBigQueryRequest(request) {
  const queryResults = BigQuery.Jobs.query(request, CONFIG.GCP_PROJECT_ID);
  const jobId = queryResults.jobReference.jobId;
  let rows = queryResults.rows || [];
  let pageToken = queryResults.pageToken;
  while (pageToken) {
    const nextRes = BigQuery.Jobs.getQueryResults(CONFIG.GCP_PROJECT_ID, jobId, { pageToken: pageToken });
    if (nextRes.rows) rows = rows.concat(nextRes.rows);
    pageToken = nextRes.pageToken;
  }
  const fields = queryResults.schema ? queryResults.schema.fields : [];
  return rows.map(row => {
    const obj = {};
    row.f.forEach((col, i) => {
      const field = fields[i];
      const val = col.v;
      if (val === null || val === undefined) {
        obj[field.name] = null;
      } else if (field.type === 'INTEGER' || field.type === 'FLOAT' || field.type === 'NUMERIC') {
        obj[field.name] = Number(val);
      } else if (field.type === 'BOOLEAN') {
        obj[field.name] = (val === 'true' || val === true);
      } else {
        obj[field.name] = String(val);
      }
    });
    return obj;
  });
}

function getSheetObjects(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const target = sheetName.trim().toLowerCase();
  const sheet = ss.getSheets().find(s => s.getName().trim().toLowerCase() === target);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(h => String(h).trim());
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row.every(c => c === '' || c === null)) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      let val = row[idx];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      obj[h] = val;
    });
    out.push(obj);
  }
  return out;
}

function getFallbackSheetRRSS(allowedArtistsLowerSet, isAdmin) {
  return getSheetObjects('Hoja 1')
    .map(r => {
      const likes = Number(r['likes']) || 0;
      const comments = Number(r['comments']) || 0;
      const shares = Number(r['shares']) || 0;
      const favorites = Number(r['favorites']) || 0;
      const bookmarks = Number(r['bookmarks']) || 0;
      const repost = Number(r['repost']) || 0;
      const reply = Number(r['reply']) || 0;
      const all_reactions = Number(r['all_reactions']) || 0;
      const views = Number(r['views']) || 0;
      const rawPlat = String(r['platform'] || '').trim();
      const pLower = rawPlat.toLowerCase();
      const platform = pLower.includes('tiktok') ? 'TikTok'
        : pLower.includes('instagram') ? 'Instagram'
        : pLower.includes('youtube') ? 'YouTube'
        : pLower.includes('facebook') ? 'Facebook'
        : pLower === 'x' ? 'X' : rawPlat;
      return {
        created_at: String(r['created_at'] || '').slice(0, 10),
        platform: platform,
        platformRaw: rawPlat,
        url: String(r['url'] || '').trim(),
        likes: likes,
        all_reactions: all_reactions,
        comments: comments,
        shares: shares,
        favorites: favorites,
        views: views,
        repost: repost,
        reply: reply,
        bookmarks: bookmarks,
        interactions: likes + comments + shares + favorites + bookmarks + repost + reply + all_reactions,
        campaign: String(r['campaign'] || '').trim(),
        artist: normalizeArtist(r['artist'])
      };
    })
    .filter(r => r.artist && (isAdmin || allowedArtistsLowerSet.has(r.artist.toLowerCase())));
}

function getFallbackSheetStreams(allowedArtistsLowerSet, isAdmin) {
  const map = new Map();
  getSheetObjects('Streams').forEach(r => {
    const artist = normalizeArtist(r['Artist']);
    if (!artist || (!isAdmin && !allowedArtistsLowerSet.has(artist.toLowerCase()))) return;
    const song = String(r['Song'] || '').trim();
    const date = String(r['Date'] || '').slice(0, 10);
    const streams = Number(r['Streams']) || 0;
    const accumulated_streams = Number(r['Accumulated Streams']) || 0;
    const key = artist + '||' + song + '||' + date;
    
    if (!map.has(key) || accumulated_streams > map.get(key).accumulated_streams) {
      map.set(key, { 
        date: date, 
        artist: artist, 
        song: song, 
        streams: streams, 
        accumulated_streams: accumulated_streams 
      });
    }
  });
  
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}
