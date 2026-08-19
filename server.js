#!/usr/bin/env node
'use strict';

/**
 * ops-survey — lightweight, config-driven survey / voting system.
 *
 * - Zero npm dependencies. Node.js native `http` only.
 * - All surveys come from config.json. Nothing survey-specific is hardcoded here.
 * - Data is stored as one JSON file per survey under data/.
 * - Writes go through tmp file + rename so a crash never corrupts a data file.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const SURVEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VOTER_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const DEFAULT_TOKEN = 'CHANGE_ME_ADMIN_TOKEN';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

let configCache = null;
let configMtime = -1;

// Re-reads config.json only when its mtime changes, so editing the file
// (adding a new survey, toggling a flag) takes effect without a restart.
function loadConfig() {
  let mtime = -1;
  try {
    mtime = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch (e) {
    /* config file missing — fall through */
  }
  if (configCache && mtime === configMtime) return configCache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    configCache = JSON.parse(raw);
    configMtime = mtime;
  } catch (err) {
    console.error('[config] load error:', err.message);
    if (!configCache) configCache = { surveys: {} };
  }
  return configCache;
}

function toNum(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Normalize a single question. Returns null when it has no usable options.
function normalizeQuestion(raw, index) {
  if (!raw || !Array.isArray(raw.options) || raw.options.length === 0) return null;

  const options = raw.options.map((o, i) => {
    if (typeof o === 'string') return { id: String(i + 1), label: String(o) };
    return {
      id: String(o && o.id != null ? o.id : i + 1),
      label: String(o && o.label != null ? o.label : '')
    };
  });

  const allowMultiple = raw.allowMultiple !== false; // default: multi-select
  let minSelections = Math.max(0, toNum(raw.minSelections, 1));
  let maxSelections = allowMultiple ? toNum(raw.maxSelections, null) : 1;
  if (maxSelections !== null && maxSelections < minSelections) maxSelections = minSelections;
  if (minSelections > options.length) minSelections = options.length;

  return {
    id: String(raw.id != null ? raw.id : 'q' + (index + 1)),
    title: String(raw.title || ''),
    description: Array.isArray(raw.description)
      ? raw.description.map(String)
      : typeof raw.description === 'string'
        ? [String(raw.description)]
        : [],
    options,
    allowMultiple,
    minSelections,
    maxSelections
  };
}

// Normalize a survey entry into a well-typed object. Returns null when the
// survey is disabled or has no usable questions (treated as "not found").
//
// A survey holds an array of `questions` (each with its own options and
// selection rules). For backward compatibility, a survey without a `questions`
// key is treated as a single question built from the top-level `options` /
// `allowMultiple` / `minSelections` / `maxSelections` fields.
function normalizeSurvey(raw) {
  if (!raw || raw.enabled === false) return null;

  const description = Array.isArray(raw.description)
    ? raw.description.map(String)
    : typeof raw.description === 'string'
      ? [String(raw.description)]
      : [];

  let questions = [];
  if (Array.isArray(raw.questions) && raw.questions.length > 0) {
    questions = raw.questions.map((q, i) => normalizeQuestion(q, i)).filter(Boolean);
  } else if (Array.isArray(raw.options) && raw.options.length > 0) {
    const single = normalizeQuestion(
      {
        id: 'q1',
        options: raw.options,
        allowMultiple: raw.allowMultiple,
        minSelections: raw.minSelections,
        maxSelections: raw.maxSelections
      },
      0
    );
    if (single) questions = [single];
  }
  if (questions.length === 0) return null;

  return {
    title: String(raw.title || ''),
    description,
    questions,
    collectName: raw.collectName === true,
    // requireName can be set directly, or derived from allowAnonymous=false
    requireName: raw.requireName === true || raw.allowAnonymous === false,
    showTotalVoters: raw.showTotalVoters !== false,
    showResultsToPublic: raw.showResultsToPublic === true,
    allowRevote: raw.allowRevote !== false,
    startAt: raw.startAt || null,
    endAt: raw.endAt || null,
    thankYouText: String(raw.thankYouText || '回答ありがとうございます！'),
    admin: raw.admin || null
  };
}

function getSurvey(surveyId) {
  if (!SURVEY_ID_RE.test(surveyId)) return null;
  const cfg = loadConfig();
  const raw = (cfg.surveys || {})[surveyId];
  if (!raw) return null;
  const survey = normalizeSurvey(raw);
  if (!survey) return null;
  survey.id = surveyId;
  return survey;
}

function surveyStatus(survey) {
  const now = Date.now();
  const start = survey.startAt ? Date.parse(survey.startAt) : NaN;
  const end = survey.endAt ? Date.parse(survey.endAt) : NaN;
  if (Number.isFinite(start) && now < start) return 'upcoming';
  if (Number.isFinite(end) && now > end) return 'ended';
  return 'active';
}

function getAdminConfig(survey) {
  const cfg = loadConfig();
  return (survey && survey.admin) || cfg.admin || {};
}

/* ------------------------------------------------------------------ *
 * Data store (JSON file per survey, atomic write)
 * ------------------------------------------------------------------ */

function dataFile(surveyId) {
  return path.join(DATA_DIR, surveyId + '.json');
}

function readData(surveyId) {
  try {
    const data = JSON.parse(fs.readFileSync(dataFile(surveyId), 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (!data.voters || typeof data.voters !== 'object' || Array.isArray(data.voters)) {
        data.voters = {};
      }
      return data;
    }
  } catch (e) {
    /* missing or corrupt -> start fresh (never throw for a survey file) */
  }
  return { voters: {} };
}

function writeData(surveyId, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fp = dataFile(surveyId);
  const tmp = fp + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

/* ------------------------------------------------------------------ *
 * Answers + Stats
 * ------------------------------------------------------------------ */

// Normalize a stored voter's answers into `{ <questionId>: [optionId, ...] }`.
//
// Legacy data files may store `answers` as a plain array (single-question
// format). Each option id is assigned to the question that owns it, so old
// time-slot votes land on the `time` question regardless of question order.
function normalizeAnswers(answers, survey) {
  const result = {};
  const ownerByOptionId = {};
  const validByQuestion = {};
  for (const q of survey.questions) {
    validByQuestion[q.id] = new Set(q.options.map((o) => o.id));
    for (const o of q.options) ownerByOptionId[o.id] = q.id;
    result[q.id] = [];
  }

  if (Array.isArray(answers)) {
    for (const a of answers) {
      const id = String(a);
      const qid = ownerByOptionId[id];
      if (qid && !result[qid].includes(id)) result[qid].push(id);
    }
  } else if (answers && typeof answers === 'object') {
    for (const q of survey.questions) {
      const list = Array.isArray(answers[q.id]) ? answers[q.id] : [];
      for (const a of list) {
        const id = String(a);
        if (validByQuestion[q.id].has(id) && !result[q.id].includes(id)) result[q.id].push(id);
      }
    }
  }
  return result;
}

function computeStats(survey, data) {
  const voters = (data && data.voters) || {};
  const totalVoters = Object.keys(voters).length;

  const countsByQuestion = new Map();
  for (const q of survey.questions) {
    const counts = {};
    for (const o of q.options) counts[o.id] = 0;
    countsByQuestion.set(q.id, counts);
  }

  for (const v of Object.values(voters)) {
    const answers = normalizeAnswers(v.answers, survey);
    for (const q of survey.questions) {
      const counts = countsByQuestion.get(q.id);
      for (const a of answers[q.id] || []) {
        if (Object.prototype.hasOwnProperty.call(counts, a)) counts[a]++;
      }
    }
  }

  const questions = survey.questions.map((q) => {
    const counts = countsByQuestion.get(q.id);
    const options = q.options.map((o) => {
      const count = counts[o.id] || 0;
      const percentage = totalVoters > 0 ? Math.round((count / totalVoters) * 1000) / 10 : 0;
      return { id: o.id, label: o.label, count, percentage };
    });
    const ranking = options.slice().sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    return {
      id: q.id,
      title: q.title,
      options,
      ranking,
      mostPopular: ranking[0] || null
    };
  });

  return { totalVoters, questions };
}

function publicPayload(survey, stats, includeResults) {
  const payload = {
    surveyId: survey.id,
    title: survey.title,
    description: survey.description,
    questions: survey.questions.map((q) => ({
      id: q.id,
      title: q.title,
      description: q.description,
      allowMultiple: q.allowMultiple,
      minSelections: q.minSelections,
      maxSelections: q.allowMultiple ? q.maxSelections : 1,
      options: q.options.map((o) => ({ id: o.id, label: o.label }))
    })),
    collectName: survey.collectName,
    nameRequired: survey.requireName,
    showTotalVoters: survey.showTotalVoters,
    showResultsToPublic: survey.showResultsToPublic,
    allowRevote: survey.allowRevote,
    thankYouText: survey.thankYouText,
    status: surveyStatus(survey),
    startAt: survey.startAt,
    endAt: survey.endAt,
    totalVoters: stats.totalVoters
  };
  // Only when the survey explicitly opts in via showResultsToPublic.
  if (includeResults) {
    payload.questions = stats.questions;
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * Admin auth (Authorization: Bearer <token> or ?token=...)
 * ------------------------------------------------------------------ */

function extractBearer(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : '';
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(sha256hex(a), 'hex');
  const bb = Buffer.from(sha256hex(b), 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isAdminAuthorized(survey, req, searchParams) {
  const admin = getAdminConfig(survey);
  if (!admin || admin.enabled === false) return true; // admin disabled => open
  if (!admin.token) {
    console.error('[auth] admin enabled but no token configured');
    return false;
  }
  const provided = extractBearer(req) || searchParams.get('token') || '';
  return provided ? safeEqual(provided, admin.token) : false;
}

/* ------------------------------------------------------------------ *
 * Simple per-IP rate limiting (in-memory, vote endpoint only)
 * ------------------------------------------------------------------ */

const hitWindows = new Map();

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip, perMinute) {
  const now = Date.now();
  let arr = hitWindows.get(ip);
  if (!arr) {
    arr = [];
    hitWindows.set(ip, arr);
  }
  while (arr.length && now - arr[0] > 60000) arr.shift();
  if (arr.length >= perMinute) return true;
  arr.push(now);
  if (hitWindows.size > 5000) {
    for (const [k, v] of hitWindows) {
      while (v.length && now - v[0] > 60000) v.shift();
      if (v.length === 0) hitWindows.delete(k);
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Vote logic
 * ------------------------------------------------------------------ */

function validateVote(survey, body) {
  const voterId = typeof body.voterId === 'string' ? body.voterId.trim() : '';
  if (!VOTER_ID_RE.test(voterId)) return { error: 'invalid voterId' };

  // Legacy clients may send a plain array; normalize it against all questions.
  if (!body.answers || typeof body.answers !== 'object') {
    return { error: 'invalid answers' };
  }
  const answers = normalizeAnswers(body.answers, survey);

  for (const q of survey.questions) {
    const list = answers[q.id] || [];
    const max = q.allowMultiple ? q.maxSelections || q.options.length : 1;
    if (list.length > max) return { error: 'too many answers for ' + q.id };
    if (list.length < q.minSelections) return { error: 'too few answers for ' + q.id };
  }

  let name = '';
  if (survey.collectName) {
    name = typeof body.name === 'string' ? body.name.trim() : '';
    if (survey.requireName && !name) return { error: 'name required' };
    if (name.length > 50) return { error: 'name too long' };
  }

  return { voterId, name, answers };
}

function handleVote(survey, body, ip, perMinute) {
  if (surveyStatus(survey) !== 'active') {
    return { status: 403, json: { ok: false, error: 'survey not open' } };
  }
  if (isRateLimited(ip, perMinute)) {
    return { status: 429, json: { ok: false, error: 'rate limited' } };
  }

  const v = validateVote(survey, body);
  if (v.error) return { status: 400, json: { ok: false, error: v.error } };

  const data = readData(survey.id);
  const now = new Date().toISOString();
  const existing = (data.voters || {})[v.voterId];

  data.voters[v.voterId] = {
    name: v.name,
    answers: v.answers,
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    updatedAt: now
  };

  writeData(survey.id, data);

  const stats = computeStats(survey, data);
  console.log(`[vote] survey=${survey.id} voter=${v.voterId} answers=${JSON.stringify(v.answers)} total=${stats.totalVoters}`);
  return { status: 200, json: { ok: true, totalVoters: stats.totalVoters } };
}

function handleMyVote(survey, voterId) {
  if (!voterId || !VOTER_ID_RE.test(voterId)) {
    return { status: 400, json: { ok: false, error: 'invalid voterId' } };
  }
  const data = readData(survey.id);
  const rec = (data.voters || {})[voterId];
  if (!rec) return { status: 404, json: { ok: false, error: 'not found' } };

  return {
    status: 200,
    json: {
      ok: true,
      name: rec.name || '',
      answers: normalizeAnswers(rec.answers, survey),
      updatedAt: rec.updatedAt || null
    }
  };
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(html);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(res, fileName) {
  const safe = path.normalize(fileName).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUBLIC_DIR, safe);
  if (!(fp === PUBLIC_DIR || fp.startsWith(PUBLIC_DIR + path.sep))) {
    return sendHtml(res, 403, '<!doctype html><meta charset="utf-8"><title>403</title><h1>Forbidden</h1>');
  }
  fs.readFile(fp, (err, buf) => {
    if (err) {
      return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title><h1>404 Not Found</h1>');
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > maxBytes) {
      reject({ status: 413, message: 'Payload too large' });
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject({ status: 413, message: 'Payload too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject({ status: 400, message: 'Bad request' }));
  });
}

/* ------------------------------------------------------------------ *
 * Landing page (lists enabled surveys)
 * ------------------------------------------------------------------ */

function serveLanding(res) {
  const cfg = loadConfig();
  const items = Object.entries(cfg.surveys || {})
    .filter(
      ([id, s]) =>
        s &&
        s.enabled !== false &&
        ((Array.isArray(s.options) && s.options.length > 0) ||
          (Array.isArray(s.questions) && s.questions.length > 0))
    )
    .map(([id, s]) => {
      const title = esc(s.title || id);
      return `      <li><a href="/survey/${encodeURIComponent(id)}/">${title}</a></li>`;
    })
    .join('\n');
  sendHtml(
    res,
    200,
    `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>アンケート一覧</title>
<style>
body{font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;background:#f6f8f7;color:#1f2d26;line-height:1.7;margin:0}
.container{max-width:560px;margin:0 auto;padding:32px 16px}
h1{font-size:1.2rem}
ul{list-style:none;padding:0;margin:0}
li{margin:8px 0}
a{display:block;padding:14px 16px;background:#fff;border:1px solid #e2e8e4;border-radius:12px;text-decoration:none;color:#2f8f5b;font-weight:600}
a:hover{border-color:#2f8f5b}
</style>
</head>
<body>
<div class="container">
  <h1>アンケート一覧</h1>
  <ul>
${items}
  </ul>
</div>
</body>
</html>`
  );
}

function sendSurvey404(res) {
  sendHtml(
    res,
    404,
    `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404</title>
<style>body{font-family:sans-serif;text-align:center;padding:48px 16px;color:#1f2d26} a{color:#2f8f5b}</style>
</head>
<body>
<h1>404</h1>
<p>アンケートが見つかりません。</p>
<p><a href="/survey/">一覧へ戻る</a></p>
</body>
</html>`
  );
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

function handleApi(req, res, reqUrl, surveyId, action) {
  const survey = getSurvey(surveyId);
  if (!survey) return sendJson(res, 404, { ok: false, error: 'survey not found' });

  if (action === 'public') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const data = readData(survey.id);
    const stats = computeStats(survey, data);
    return sendJson(res, 200, publicPayload(survey, stats, survey.showResultsToPublic));
  }

  if (action === 'my-vote') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const voterId = reqUrl.searchParams.get('voterId') || '';
    const r = handleMyVote(survey, voterId);
    return sendJson(res, r.status, r.json);
  }

  if (action === 'vote') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const cfg = loadConfig();
    const perMinute = toNum(
      cfg.server && cfg.server.rateLimit && cfg.server.rateLimit.votePerMinute,
      20
    );
    const maxBytes = toNum(cfg.server && cfg.server.maxBodyBytes, 16384);
    readBody(req, maxBytes)
      .then((raw) => {
        let body = null;
        try {
          body = JSON.parse(raw || '{}');
        } catch (e) {
          body = null;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const r = handleVote(survey, body, clientIP(req), perMinute);
        return sendJson(res, r.status, r.json);
      })
      .catch((err) => {
        if (err && err.status) return sendJson(res, err.status, { ok: false, error: err.message });
        return sendJson(res, 500, { ok: false, error: 'internal error' });
      });
    return;
  }

  if (action === 'result') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const wantJson =
      reqUrl.searchParams.get('format') === 'json' ||
      /application\/json/.test(req.headers.accept || '');
    const authorized = isAdminAuthorized(survey, req, reqUrl.searchParams);

    if (!authorized) {
      // The HTML shell is served so the admin can enter a token in the browser;
      // the actual data is only reachable through the JSON response below.
      if (wantJson) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return serveStatic(res, 'admin.html');
    }

    if (wantJson) {
      const data = readData(survey.id);
      const stats = computeStats(survey, data);
      return sendJson(res, 200, {
        surveyId: survey.id,
        title: survey.title,
        totalVoters: stats.totalVoters,
        questions: stats.questions,
        collectedAt: new Date().toISOString()
      });
    }
    return serveStatic(res, 'admin.html');
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

function handleRequest(req, res) {
  let reqUrl;
  try {
    reqUrl = new URL(req.url, 'http://localhost');
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: 'bad request' });
  }
  const pathname = reqUrl.pathname;
  const segments = pathname.split('/').filter(Boolean);

  if (pathname === '/favicon.ico') {
    return serveStatic(res, 'favicon.ico');
  }

  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { Location: '/survey/' });
    return res.end();
  }

  // Health check (used by docker healthcheck)
  if (pathname === '/health' || pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (segments[0] !== 'survey') return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title><h1>404 Not Found</h1>');

  // /survey or /survey/  -> landing page
  if (segments.length === 1) return serveLanding(res);

  // /survey/api/<id>/<action>
  if (segments[1] === 'api') {
    const surveyId = segments[2] || '';
    const action = segments[3] || '';
    if (!surveyId || !action) return sendJson(res, 404, { ok: false, error: 'not found' });
    return handleApi(req, res, reqUrl, surveyId, action);
  }

  // /survey/<id>/  -> survey page
  const surveyId = segments[1];
  if (!SURVEY_ID_RE.test(surveyId) || !getSurvey(surveyId)) return sendSurvey404(res);
  return serveStatic(res, 'index.html');
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

function warnIfDefaults() {
  const cfg = loadConfig();
  const admin = cfg.admin || {};
  if (admin.enabled && (!admin.token || admin.token === DEFAULT_TOKEN)) {
    console.warn('[config] admin token is missing or still the default. Set a strong token in config.json.');
  }
}

const cfg = loadConfig();
const serverCfg = cfg.server || {};
const PORT = Number(process.env.PORT || serverCfg.port || 6533);
const HOST = process.env.HOST || serverCfg.host || '127.0.0.1';

warnIfDefaults();

http
  .createServer((req, res) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
    });
    try {
      handleRequest(req, res);
    } catch (err) {
      console.error('[error]', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`ops-survey listening on http://${HOST}:${PORT}`);
  });
