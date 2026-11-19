/**
 * ============================================================================
 * SERVERLESS API GATEWAY: Google Sheets + BigQuery + Gemini (100% Free Tier)
 * ============================================================================
 */
const CONFIG = {
  GCP_PROJECT_ID: 'taurocampaigns',
  BQ_DATASET: 'music_campaigns',
  USE_BIGQUERY_FOR_FACTS: true, // Automatically falls back to Hoja 1 / Streams if false
  GEMINI_MODEL: 'gemini-3.8-flash'
};

function doGet(e) {
  if (e && e.parameter && e.parameter.api === '1') {
    const email = (e.parameter.email || '').trim().toLowerCase();
    const password = e.parameter.password || '';
    const action = (e.parameter.action || '').trim().toLowerCase();

    // On-demand Gemini Insights endpoint triggered by the dashboard button:
    // ?api=1&action=ai_insights&email=...&password=...&artist=...&campaign=...&save=1
    if (action === 'ai_insights') {
      const artistFilter = (e.parameter.artist || '').trim();
      const campaignFilter = (e.parameter.campaign || '').trim();
      const saveToSheet = e.parameter.save === '1';
      const aiPayload = generateGeminiInsightsForUser(
        email,
        password,
        artistFilter,
        campaignFilter,
        saveToSheet
      );
      return ContentService
        .createTextOutput(JSON.stringify(aiPayload))
        .setMimeType(ContentService.MimeType.JSON);
    }

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

// ============================================================================
// ON-DEMAND GEMINI INSIGHTS ENGINE (BigQuery + GSheet Synthesis)
// ============================================================================

/**
 * Triggered on demand when the user clicks "Generate Insights with Gemini".
 */
function generateGeminiInsightsForUser(email, password, artistFilter, campaignFilter, saveToSheet) {
  const baseData = getDashboardPayload(email, password);
  if (!baseData.authorized) {
    return baseData;
  }

  const targetArtist = normalizeArtist(artistFilter);
  const targetCampaign = String(campaignFilter || '').trim();

  const filteredRrss = baseData.rrss.filter(r =>
    (!targetArtist || targetArtist === 'ALL' || r.artist === targetArtist) &&
    (!targetCampaign || targetCampaign === 'ALL' || r.campaign === targetCampaign)
  );

  const filteredStreams = baseData.streams.filter(s =>
    (!targetArtist || targetArtist === 'ALL' || s.artist === targetArtist) &&
    (!targetCampaign || targetCampaign === 'ALL' || s.song === targetCampaign)
  );

  if (!filteredRrss.length && !filteredStreams.length) {
    return {
      authorized: true,
      success: false,
      message: 'No RRSS or Spotify data found for the selected artist/campaign.'
    };
  }

  // Pass governance-filtered GSheet insights into the cohort builder
  const cohorts = buildCampaignCohortsForAI_(filteredRrss, filteredStreams, baseData.insights || []);
  const generatedList = [];
  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Process up to 3 cohorts per on-demand click to stay fast and within free-tier RPM limits
  cohorts.slice(0, 3).forEach(cohort => {
    const insightText = callGeminiForCampaign_(cohort);
    const entry = {
      artist: cohort.artist,
      campaign: cohort.campaign,
      created_at: todayStr,
      insight: insightText
    };
    generatedList.push(entry);

    if (saveToSheet) {
      saveInsightToSheet_(entry.artist, entry.campaign, entry.created_at, entry.insight);
    }
  });

  return {
    authorized: true,
    success: true,
    generatedInsights: generatedList
  };
}

function buildCampaignCohortsForAI_(rrssRows, streamRows, sheetInsights) {
  const map = new Map();

  rrssRows.forEach(r => {
    const artist = r.artist || 'Unknown Artist';
    const campaign = r.campaign || 'General Campaign';
    const key = `${artist}|||${campaign}`;
    if (!map.has(key)) {
      map.set(key, { artist, campaign, postsByUrl: new Map(), streams: [] });
    }
    const cohort = map.get(key);
    const urlKey = r.url || `${r.platform}-${r.created_at}-${Math.random()}`;
    const existing = cohort.postsByUrl.get(urlKey);

    if (!existing || (Number(r.views) || 0) >= existing.views) {
      cohort.postsByUrl.set(urlKey, {
        platform: r.platform || 'Other',
        platformRaw: r.platformRaw || r.platform || 'Other',
        url: r.url || '',
        views: Number(r.views) || 0,
        likes: Number(r.likes) || 0,
        comments: Number(r.comments) || 0,
        shares: (Number(r.shares) || 0) + (Number(r.bookmarks) || 0) + (Number(r.favorites) || 0),
        interactions: Number(r.interactions) || 0
      });
    }
  });

  streamRows.forEach(s => {
    const artist = s.artist || 'Unknown Artist';
    const campaign = s.song || 'General Track';
    const key = `${artist}|||${campaign}`;
    if (!map.has(key)) {
      map.set(key, { artist, campaign, postsByUrl: new Map(), streams: [] });
    }
    map.get(key).streams.push(s);
  });

  return Array.from(map.values()).map(c => {
    const sortedPosts = Array.from(c.postsByUrl.values())
      .sort((a, b) => b.views - a.views);

    const totalViews = sortedPosts.reduce((sum, p) => sum + p.views, 0);
    const totalInteractions = sortedPosts.reduce((sum, p) => sum + p.interactions, 0);
    const totalSharesSaves = sortedPosts.reduce((sum, p) => sum + p.shares, 0);
    const avgER = totalViews > 0 ? ((totalInteractions / totalViews) * 100).toFixed(2) : '0.00';
    const saveShareRate = totalViews > 0 ? ((totalSharesSaves / totalViews) * 100).toFixed(2) : '0.00';

    // Aggregate BigQuery performance by platform
    const platMap = new Map();
    sortedPosts.forEach(p => {
      const platName = p.platform || 'Other';
      if (!platMap.has(platName)) {
        platMap.set(platName, { platform: platName, posts: 0, views: 0, interactions: 0, sharesSaves: 0 });
      }
      const agg = platMap.get(platName);
      agg.posts += 1;
      agg.views += p.views;
      agg.interactions += p.interactions;
      agg.sharesSaves += p.shares;
    });

    const platformBreakdown = Array.from(platMap.values())
      .sort((a, b) => b.views - a.views)
      .map(pl => ({
        ...pl,
        viewSharePct: totalViews > 0 ? ((pl.views / totalViews) * 100).toFixed(1) : '0.0',
        erPct: pl.views > 0 ? ((pl.interactions / pl.views) * 100).toFixed(2) : '0.00',
        viralityPct: pl.views > 0 ? ((pl.sharesSaves / pl.views) * 100).toFixed(2) : '0.00'
      }));

    // Streaming summary & growth trajectory
    const sortedStreams = c.streams.sort((a, b) => a.date.localeCompare(b.date));
    const firstStream = sortedStreams.length ? sortedStreams[0] : null;
    const latestStream = sortedStreams.length ? sortedStreams[sortedStreams.length - 1] : null;
    const peakDaily = sortedStreams.reduce((max, s) => Math.max(max, Number(s.streams) || 0), 0);
    const dailyGrowthPct = (firstStream && latestStream && sortedStreams.length > 1 && firstStream.streams > 0)
      ? (((latestStream.streams - firstStream.streams) / firstStream.streams) * 100).toFixed(1)
      : null;

    // Match Google Sheet Insights (current campaign + artist historical campaigns)
    const artistLower = c.artist.toLowerCase();
    const campaignLower = c.campaign.toLowerCase();
    const artistSheetInsights = (sheetInsights || [])
      .filter(i => i.artist && i.artist.toLowerCase() === artistLower && i.insight)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    const currentCampaignInsights = artistSheetInsights
      .filter(i => i.campaign && i.campaign.toLowerCase() === campaignLower)
      .slice(0, 5);

    const pastArtistInsights = artistSheetInsights
      .filter(i => !i.campaign || i.campaign.toLowerCase() !== campaignLower)
      .slice(0, 4);

    return {
      artist: c.artist,
      campaign: c.campaign,
      totalUniquePosts: sortedPosts.length,
      totalViews,
      totalInteractions,
      totalSharesSaves,
      avgER,
      saveShareRate,
      platformBreakdown,
      topPosts: sortedPosts.slice(0, 6),
      streamSummary: latestStream
        ? {
            firstDate: firstStream.date,
            latestDate: latestStream.date,
            latestDailyStreams: latestStream.streams,
            accumulatedStreams: latestStream.accumulated_streams,
            peakDailyStreams: peakDaily,
            dailyGrowthPct: dailyGrowthPct
          }
        : null,
      currentCampaignInsights,
      pastArtistInsights
    };
  });
}

/**
 * Calls Gemini API using BigQuery metrics + Google Sheet historical insights + URL Context.
 */
function callGeminiForCampaign_(cohort) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in Apps Script Project Settings -> Script Properties.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;

  const platformBlock = cohort.platformBreakdown.length
    ? cohort.platformBreakdown.map(pl =>
        `- ${pl.platform}: ${pl.posts} post(s) | ${pl.views.toLocaleString()} views (${pl.viewSharePct}% share) | ER: ${pl.erPct}% | Save/Share Rate: ${pl.viralityPct}%`
      ).join('\n')
    : 'No platform breakdown available.';

  const topUrlsBlock = cohort.topPosts.length
    ? cohort.topPosts.map((p, i) => {
        const er = p.views > 0 ? ((p.interactions / p.views) * 100).toFixed(2) + '%' : '0%';
        return `${i + 1}. [${p.platformRaw}] ${p.url || '(no URL)'} — Views: ${p.views.toLocaleString()}, Likes: ${p.likes.toLocaleString()}, Comments: ${p.comments.toLocaleString()}, Shares/Saves: ${p.shares.toLocaleString()}, ER: ${er}`;
      }).join('\n')
    : 'No social post URLs logged yet.';

  const streamBlock = cohort.streamSummary
    ? `Window: ${cohort.streamSummary.firstDate} to ${cohort.streamSummary.latestDate} | Latest Daily Streams: ${cohort.streamSummary.latestDailyStreams.toLocaleString()} | Peak Daily Streams: ${cohort.streamSummary.peakDailyStreams.toLocaleString()} | Accumulated Streams: ${cohort.streamSummary.accumulatedStreams.toLocaleString()}${cohort.streamSummary.dailyGrowthPct !== null ? ` | Daily Velocity Change: ${Number(cohort.streamSummary.dailyGrowthPct) >= 0 ? '+' : ''}${cohort.streamSummary.dailyGrowthPct}%` : ''}`
    : 'No Spotify streaming rows logged yet.';

  const currentSheetBlock = cohort.currentCampaignInsights.length
    ? cohort.currentCampaignInsights.map(i => `[${i.created_at || 'No Date'}] ${i.insight}`).join('\n')
    : 'None logged yet for this specific campaign.';

  const pastSheetBlock = cohort.pastArtistInsights.length
    ? cohort.pastArtistInsights.map(i => `[${i.campaign || 'Past Campaign'} — ${i.created_at || 'No Date'}] ${i.insight}`).join('\n')
    : 'None logged yet for other campaigns by this artist.';

  const prompt = `
You are a Senior Music Marketing, Audience Strategy & Streaming Intelligence Director advising a record label.

ARTIST: ${cohort.artist}
CAMPAIGN / SONG: ${cohort.campaign}

=== 1. BIGQUERY RRSS PERFORMANCE ===
- Unique Tracked Posts: ${cohort.totalUniquePosts}
- Total Views: ${cohort.totalViews.toLocaleString()}
- Total Interactions: ${cohort.totalInteractions.toLocaleString()}
- Overall Engagement Rate: ${cohort.avgER}%
- Overall Save/Share Virality Rate: ${cohort.saveShareRate}%

PLATFORM BREAKDOWN (BIGQUERY):
${platformBlock}

TOP PERFORMING POST URLS:
${topUrlsBlock}

=== 2. BIGQUERY SPOTIFY STREAMING PERFORMANCE ===
${streamBlock}

=== 3. GOOGLE SHEET HISTORICAL & MANUAL INSIGHTS ===
Current Campaign Notes:
${currentSheetBlock}

Artist's Prior Campaigns Learnings:
${pastSheetBlock}

INSTRUCTIONS:
1. Synthesize BOTH the quantitative performance data (RRSS platforms, virality rates, URLs, Spotify streams) AND the qualitative historical insights above. Do NOT repeat or copy-paste prior notes verbatim—use them as baseline context to validate trends, spot shifts, and generate NEW net-incremental insights. Do not mention internal data tools like "BigQuery" or "Google Sheets" in your response; refer naturally to RRSS performance, streaming data, and prior campaign learnings.
2. Use URL Context to inspect any publicly accessible content from the URLs above (e.g., YouTube videos/Shorts). If a social platform blocks direct URL fetching, rely strictly on the metrics and historical context provided.
3. Deliver a sharp, executive strategic playbook formatted strictly as 5 bullet points using "• **Title:**" syntax (no markdown "#" headings, no intro/outro text):
   • **Insights:** Net-new findings from analyzing the RRSS and streams performance alongside prior campaign learnings (what is accelerating, plateauing, or diverging from past benchmarks).
   • **Recommended Post Types & Creative Angles:** Specific content formats, hook structures, video lengths, and UGC vs. official asset mixes to prioritize based on platform ER and save/share signals.
   • **Future Campaign Strategy & Rollout:** Tactical multi-phase campaign structure (pre-save/tease, creator seeding waves, cross-channel funnel from short-form video to Spotify conversion).
   • **Audience Segmentation & Targeting:** High-intent audience personas, behavioral retargeting pools (e.g., high-save vs. passive-view cohorts), and platform-specific demographic/interest segments for future campaigns.
   • **Additional Strategic Levers (KPIs & Testing):** Concrete A/B tests, release cadence adjustments, and target KPI benchmarks for the next campaign cycle.
`.trim();

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    tools: [
      { url_context: {} }
    ],
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 1600
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(endpoint, options);
  const statusCode = response.getResponseCode();
  const body = JSON.parse(response.getContentText());

  if (statusCode !== 200) {
    const errMsg = (body.error && body.error.message) ? body.error.message : response.getContentText();
    throw new Error(`Gemini API Error (${statusCode}): ${errMsg}`);
  }

  const candidate = body.candidates && body.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts ? candidate.content.parts : [];
  const textOutput = parts.map(p => p.text || '').join('').trim();

  return textOutput || 'No insight generated.';
}

function saveInsightToSheet_(artist, campaign, createdAt, insightText) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets().find(s => s.getName().trim().toLowerCase() === 'insights');
  if (!sheet) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const newRow = headers.map(h => {
    const key = String(h).trim().toLowerCase();
    if (key === 'artist' || key === 'artista') return artist;
    if (key === 'campaign' || key === 'campaña' || key === 'song') return campaign;
    if (key === 'created_at' || key === 'date' || key === 'fecha') return createdAt;
    if (key === 'insight' || key === 'insights') return insightText;
    return '';
  });

  sheet.appendRow(newRow);
}

// ============================================================================
// BIGQUERY & GOOGLE SHEETS DATA LAYER
// ============================================================================

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
