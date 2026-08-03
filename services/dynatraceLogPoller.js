const axios = require('axios');
const { BlobServiceClient } = require('@azure/storage-blob');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const { ingestIncidentDocument } = require('./incidentIngest');

// ── Config ────────────────────────────────────────────────────────────────────
const DT_ENV_URL       = process.env.DT_ENV_URL;
const DT_CLIENT_ID     = process.env.DT_CLIENT_ID;
const DT_CLIENT_SECRET = process.env.DT_CLIENT_SECRET;
const POLL_INTERVAL_MS = 60 * 1000;
const CHECKPOINT_LOOKBACK_MS = parseInt(process.env.POLLER_CHECKPOINT_LOOKBACK_MS || '', 10) || 15 * 60 * 1000;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION;
const POLLER_SERVICE_NAMES = (process.env.POLLER_SERVICE_NAMES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const CHECKPOINT_CONNECTION = process.env.CHECKPOINT_STORAGE_CONNECTION_STRING;
const CHECKPOINT_CONTAINER  = process.env.CHECKPOINT_CONTAINER || 'dynatrace-poller-checkpoints';
const CHECKPOINT_BLOB       = process.env.CHECKPOINT_BLOB      || 'checkpoint.json';

// ── OAuth token (cached until 30s before expiry) ──────────────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getOAuthToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  let res;
  try {
    res = await axios.post(
      'https://sso.dynatrace.com/sso/oauth2/token',
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     DT_CLIENT_ID,
        client_secret: DT_CLIENT_SECRET,
        scope:         'storage:logs:read storage:buckets:read',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (err) {
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OAuth token request failed (${err.response?.status ?? 'no response'}): ${body}`);
  }

  cachedToken    = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 30) * 1000;
  logger.info('Dynatrace log poller: OAuth token refreshed');
  return cachedToken;
}

// ── Blob Storage checkpoint ───────────────────────────────────────────────────
function getBlobClient() {
  const service   = BlobServiceClient.fromConnectionString(CHECKPOINT_CONNECTION);
  const container = service.getContainerClient(CHECKPOINT_CONTAINER);
  return container.getBlockBlobClient(CHECKPOINT_BLOB);
}

async function readCheckpoint() {
  try {
    const blobClient = getBlobClient();
    const download   = await blobClient.download();
    const chunks     = [];
    for await (const chunk of download.readableStreamBody) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    logger.info(`Dynatrace log poller: checkpoint read — ${parsed.lastProcessedTime}`);
    return parsed.lastProcessedTime;
  } catch {
    const fallback = new Date(Date.now() - CHECKPOINT_LOOKBACK_MS).toISOString();
    logger.info(`Dynatrace log poller: no checkpoint, defaulting to ${fallback}`);
    return fallback;
  }
}

async function writeCheckpoint(timestamp) {
  try {
    const blobClient = getBlobClient();
    await blobClient.uploadData(
      Buffer.from(JSON.stringify({ lastProcessedTime: timestamp })),
      { overwrite: true }
    );
    logger.info(`Dynatrace log poller: checkpoint updated — ${timestamp}`);
  } catch (err) {
    logger.error(`Dynatrace log poller: failed to write checkpoint — ${err.message}`);
    throw err;
  }
}

// ── DQL execution ─────────────────────────────────────────────────────────────
async function executeDql(token, query) {
  let res;
  try {
    res = await axios.post(
      `${DT_ENV_URL}/platform/storage/query/v1/query:execute`,
      { query },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`DQL execute failed (${err.response?.status ?? 'no response'}): ${body}`);
  }

  if (res.data.state === 'SUCCEEDED') return res.data.result?.records || [];

  // Async path — poll until complete
  const requestToken = res.data.requestToken;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, 1000));
    const poll = await axios.get(
      `${DT_ENV_URL}/platform/storage/query/v1/query:poll`,
      { params: { 'request-token': requestToken }, headers: { Authorization: `Bearer ${token}` } }
    );
    if (poll.data.state === 'SUCCEEDED') return poll.data.result?.records || [];
    if (poll.data.state === 'FAILED' || poll.data.state === 'CANCELLED') {
      throw new Error(`DQL query ended with state: ${poll.data.state}`);
    }
  }
  throw new Error('DQL query did not complete within 10 seconds');
}

// ── Error signature for deduplication ────────────────────────────────────────
// Uses content (message) for exception type + exception (stack trace) for file:line.
// Same bug at the same location always produces the same key → one incident per bug.
function extractErrorSignature(content, exceptionText) {
  const forType     = `${content || ''} ${exceptionText || ''}`;
  const forLocation = exceptionText || content || '';

  let exceptionType = 'UnknownException';

  const javaEx = forType.match(/\b([A-Z]\w+(?:Exception|Error))\b/);
  if (javaEx) exceptionType = javaEx[1];

  const dotnetEx = forType.match(/\b(System\.\w+Exception)\b/);
  if (dotnetEx) exceptionType = dotnetEx[1].split('.').pop();

  let failingLocation = '';

  // Java: find first non-framework frame
  const javaFrames = [...forLocation.matchAll(/\bat\s+([\w$.]+)\(([\w]+\.java):(\d+)\)/g)];
  for (const frame of javaFrames) {
    if (!/^(java\.|javax\.|sun\.|com\.sun\.|org\.springframework\.|org\.apache\.)/.test(frame[1])) {
      failingLocation = `${frame[2]}:${frame[3]}`;
      break;
    }
  }

  // .NET
  if (!failingLocation) {
    const dotnetFrame = forLocation.match(/\bat\s+.+?\s+in\s+(.+\.cs):line\s+(\d+)/i);
    if (dotnetFrame) {
      failingLocation = `${dotnetFrame[1].split(/[\\/]/).pop()}:${dotnetFrame[2]}`;
    }
  }

  // Python — use last frame (actual crash site)
  if (!failingLocation) {
    const pyFrames = [...forLocation.matchAll(/File "(.+\.py)", line (\d+)/g)];
    if (pyFrames.length > 0) {
      const last = pyFrames[pyFrames.length - 1];
      failingLocation = `${last[1].split(/[\\/]/).pop()}:${last[2]}`;
    }
  }

  if (!failingLocation) {
    failingLocation = (content || '').substring(0, 80).replace(/[^a-zA-Z0-9]/g, '_');
  }

  return `${exceptionType}:${failingLocation}`;
}

// ── Incident filtering ────────────────────────────────────────────────────────
// Returns true for business/validation exceptions (4xx) that should NOT create
// incidents. Only 5xx / unhandled exceptions with stack traces create incidents.
function isExpectedException(content, exceptionText) {
  const fullText = `${content || ''} ${exceptionText || ''}`;
  if (!fullText.trim()) return false;

  // Spring's built-in 404 for an unmatched route / missing static resource (e.g. a
  // browser hitting the bare service URL or "/favicon.ico" directly). The stack trace
  // points into framework code (ResourceHttpRequestHandler, HttpServlet), never
  // application code, so there's nothing for a remediation agent to fix.
  if (/NoResourceFoundException/.test(fullText)) return true;

  // HTTP status code takes priority
  const statusPatterns = [
    /\b(?:status|Status|STATUS)[\s:=]+(\d{3})\b/i,
    /\bStatus\s*Code[\s:=]+(\d{3})\b/i,
    /^(?:Error\s+)?(\d{3})\s+(?:Error|Not Found|Bad Request|Unauthorized|Forbidden)/im,
    /\breturning\s+(?:status\s+)?(\d{3})\b/i,
  ];

  for (const pattern of statusPatterns) {
    const match = fullText.match(pattern);
    if (match) {
      const code = parseInt(match[1], 10);
      if (code >= 400 && code < 500) return true;   // 4xx → skip
      if (code >= 500 && code < 600) return false;  // 5xx → incident
    }
  }

  // Check both fields — Node.js logs often embed the stack trace in content rather
  // than a separate exception field, so fullText covers both cases.
  const hasStackTrace = /\s+at\s+[\w$.]+\([^)]+\)/.test(fullText) ||
                        /\s+in\s+.+\.cs:line\s+\d+/i.test(fullText) ||
                        /File\s+".+\.py",\s+line\s+\d+/.test(fullText);
  if (hasStackTrace) return false;

  // No stack trace — business error keyword in the message only
  return /\b(?:not found|already exists|invalid|required|forbidden|unauthorized)\b/i.test(content || '');
}

// ── Incident document mapping ─────────────────────────────────────────────────
function mapToIncidentDocument(record) {
  // content  = human-readable error message (from logback message field)
  // exception = full Java stack trace (from logback exception field)
  const content       = record.content   || '';
  const exceptionText = record.exception || '';

  // service.name is a direct structured field set by the log forwarder
  const serviceName    = record['service.name'] || 'unknown';
  const errorSignature = extractErrorSignature(content, exceptionText);

  return {
    incidentId:       `${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
    traceId:          record['dt.trace_id'] || record['trace_id'] || record['trace.id'] || null,
    spanId:           record['span_id'] || null,
    serviceName,
    applicationName:  serviceName,
    hostName:         record['host.name'] || 'unknown',
    pid:              0,
    exceptionType:    errorSignature.split(':')[0] || 'UnhandledException',
    exceptionMessage: content,
    stackTrace:       exceptionText || content,
    causedByChain:    exceptionText
                        ? [exceptionText.split('\n')[0]]
                        : [content],
    context: {
      source:         'dynatrace-log-poller',
      logger:         record.logger  || '',
      thread:         record.thread  || '',
      status:         record.status,
      timestamp:      record.timestamp,
      errorSignature,
      cloudProvider:  record['cloud.provider'] || 'unknown',
      cloudPlatform:  record['cloud.platform'] || 'unknown',
    },
    createdAt:       new Date(),
    occurredAt:      new Date(record.timestamp),
    lastSeenAt:      new Date(record.timestamp),
    occurrenceCount: 0,
    healingStatus:   'PENDING',
    incidentKey:     `${serviceName}:${errorSignature}`,
    _class:          'com.dynatrace.log.LogEntry',
  };
}

// ── Poll cycle ────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const lastProcessedTime = await readCheckpoint();
    logger.info(`Dynatrace log poller: poll cycle started (checkpoint: ${lastProcessedTime})`);
    const token             = await getOAuthToken();

    // Use checkpoint time as DQL `from` so no logs are missed during gaps or
    // restarts. Dynatrace Grail loglevel is always "INFO" for custom-ingested
    // logs regardless of status field — filter on isNotNull(exception) instead,
    // since the forwarder only sets that field for actual stack-trace errors.
    const serviceFilter = POLLER_SERVICE_NAMES
      .map(n => `\`service.name\` == "${n}"`)
      .join(' or ');
    const query = [
      `fetch logs, from: "${lastProcessedTime}"`,
      `| filter (${serviceFilter})`,
      '| filter isNotNull(exception)',
      '| sort timestamp asc',
      '| limit 100',
    ].join('\n');

    const records = await executeDql(token, query);
    if (records.length === 0) {
      logger.info('Dynatrace log poller: no logs');
      return;
    }
    logger.info(`Dynatrace log poller: DQL returned ${records.length} record(s)`);

    const newRecords = records.filter(r => new Date(r.timestamp) > new Date(lastProcessedTime));
    if (newRecords.length === 0) {
      logger.info('Dynatrace log poller: no new logs since checkpoint');
      return;
    }
    logger.info(`Dynatrace log poller: ${newRecords.length} new record(s) after checkpoint filter`);

    // Fix 2/4: pass both content and exception to the filter
    const incidentRecords = newRecords.filter(
      r => !isExpectedException(r.content || '', r.exception || '')
    );
    const skipped = newRecords.length - incidentRecords.length;
    logger.info(`Dynatrace log poller: ${incidentRecords.length} incident(s) to create, ${skipped} skipped`);

    if (incidentRecords.length === 0) {
      logger.info(`Dynatrace log poller: no logs to process (${skipped} skipped as expected/business errors)`);
      const latest = new Date(newRecords[newRecords.length - 1].timestamp);
      latest.setMilliseconds(latest.getMilliseconds() + 1);
      await writeCheckpoint(latest.toISOString());
      return;
    }

    const db  = await getDB();
    const col = db.collection(MONGO_COLLECTION);

    for (const record of incidentRecords) {
      const doc = mapToIncidentDocument(record);
      await ingestIncidentDocument(col, doc, record.timestamp);
    }

    logger.info(`Dynatrace log poller: processed ${incidentRecords.length} error(s)`);

    const latest = new Date(newRecords[newRecords.length - 1].timestamp);
    latest.setMilliseconds(latest.getMilliseconds() + 1);
    await writeCheckpoint(latest.toISOString());

  } catch (err) {
    logger.error(`Dynatrace log poller error: ${err.message}`);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function ensureContainer() {
  try {
    const service   = BlobServiceClient.fromConnectionString(CHECKPOINT_CONNECTION);
    const container = service.getContainerClient(CHECKPOINT_CONTAINER);
    await container.createIfNotExists();
    logger.info(`Dynatrace log poller: checkpoint container '${CHECKPOINT_CONTAINER}' ready`);
  } catch (err) {
    logger.error(`Dynatrace log poller: failed to create checkpoint container — ${err.message}`);
    throw err;
  }
}

async function ensureIndexes() {
  try {
    const db  = await getDB();
    const col = db.collection(MONGO_COLLECTION);
    await col.createIndex({ incidentKey: 1 },   { unique: true, background: true });
    await col.createIndex({ healingStatus: 1 },  { background: true });
    await col.createIndex({ incidentId: -1 },    { background: true });
    await col.createIndex({ createdAt: -1 },     { background: true });
    await col.createIndex({ traceId: 1 },        { background: true, sparse: true });
    logger.info('Dynatrace log poller: MongoDB indexes ensured');
  } catch (err) {
    if (err.code !== 85 && err.code !== 86) {
      logger.warn(`Dynatrace log poller: index creation warning — ${err.message}`);
    }
  }
}

function start() {
  if (!DT_ENV_URL || !DT_CLIENT_ID || !DT_CLIENT_SECRET) {
    logger.warn('Dynatrace log poller: DT_ENV_URL / DT_CLIENT_ID / DT_CLIENT_SECRET not set — poller disabled');
    return;
  }
  if (POLLER_SERVICE_NAMES.length === 0) {
    logger.warn('Dynatrace log poller: POLLER_SERVICE_NAMES not set — poller disabled');
    return;
  }
  if (!CHECKPOINT_CONNECTION) {
    logger.warn('Dynatrace log poller: CHECKPOINT_STORAGE_CONNECTION_STRING not set — poller disabled');
    return;
  }

  logger.info(`Dynatrace log poller starting (DT_ENV_URL=${DT_ENV_URL})...`);
  Promise.all([ensureContainer(), ensureIndexes()])
    .then(() => { poll(); setInterval(poll, POLL_INTERVAL_MS); })
    .catch(err => logger.error(`Dynatrace log poller failed to start: ${err.message}`));
}

module.exports = { start };
