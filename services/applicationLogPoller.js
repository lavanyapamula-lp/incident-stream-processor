/**
 * applicationLogPoller.js
 *
 * Polls an observability backend for application error logs and turns them
 * into incident documents. Today's backend is Azure Log Analytics (queried
 * directly — no Dynatrace hop). Kept source-agnostic in name/shape so a
 * different backend can be swapped in later without renaming the module
 * every service already imports.
 */

const { DefaultAzureCredential } = require('@azure/identity');
const { LogsQueryClient, LogsQueryResultStatus } = require('@azure/monitor-query');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');
const { ingestIncidentDocument } = require('./incidentIngest');
const { categorizeIncident } = require('./issueCategory');
const { readCheckpoint, writeCheckpoint } = require('./checkpointStore');
const { discoverMonitoredContainerApps } = require('./monitoredServices');

// ── Config ────────────────────────────────────────────────────────────────────
const LOG_WORKSPACE_ID  = process.env.LOG_WORKSPACE_ID;
// Deliberately no fallback to MONGO_COLLECTION (the production collection) — this
// must be set explicitly, both during testing (service_error_logs_azure) and at
// cutover (service_error_logs), so a missing env var fails loud instead of silently
// writing to production.
const MONGO_COLLECTION = process.env.MONGO_COLLECTION_APP_LOG;

const POLL_INTERVAL_MS       = Number(process.env.APP_LOG_POLL_INTERVAL_MS || 60_000);
const CHECKPOINT_LOOKBACK_MS = Number(process.env.APP_LOG_CHECKPOINT_LOOKBACK_MS || 15 * 60_000);

const SOURCE_NAME = 'application-log-poller';

let logsClient = null;
function getLogsClient() {
  if (!logsClient) logsClient = new LogsQueryClient(new DefaultAzureCredential());
  return logsClient;
}

// ── Log Analytics query ───────────────────────────────────────────────────────
function buildQuery(lastProcessedTime, containerApps) {
  const appFilter = containerApps.length === 1
    ? `| where ContainerAppName_s == "${containerApps[0]}"`
    : `| where ContainerAppName_s in (${containerApps.map(n => `"${n}"`).join(', ')})`;

  return `
    ContainerAppConsoleLogs_CL
    | where TimeGenerated > todatetime("${lastProcessedTime}")
    ${appFilter}
    | where Log_s contains '"severity":"ERROR"'
        or Log_s contains '"severity":"CRITICAL"'
        or Log_s contains '"severity":"FATAL"'
    | project TimeGenerated, ContainerAppName_s, Log_s
    | order by ContainerAppName_s asc, TimeGenerated asc
  `;
}

/** Container Apps prefixes each console line with "F " (stdout) / "P " (stderr) before the JSON body. */
function parseLogLine(raw) {
  const line = String(raw || '').trim();
  const body = /^[FP] /.test(line) ? line.slice(2) : line;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function queryErrorLogs(lastProcessedTime) {
  const containerApps = await discoverMonitoredContainerApps();
  if (containerApps.length === 0) {
    logger.warn(`${SOURCE_NAME}: no monitored container apps resolved — skipping this poll cycle`);
    return [];
  }

  const client = getLogsClient();
  const result = await client.queryWorkspace(
    LOG_WORKSPACE_ID,
    buildQuery(lastProcessedTime, containerApps),
    { duration: 'P1D' } // timespan is required by the SDK; the KQL `where` clause is the real filter
  );

  if (result.status !== LogsQueryResultStatus.Success) {
    throw new Error(`Log Analytics query failed: ${result.status}`);
  }

  const table = result.tables[0];
  return (table?.rows || []).map((row) => {
    const [timeGenerated, containerAppName, logLine] = row;
    const time = timeGenerated instanceof Date ? timeGenerated.toISOString() : String(timeGenerated);
    return {
      time,
      containerAppName,
      parsed: parseLogLine(logLine),
      raw: logLine,
    };
  });
}

// ── Error signature for deduplication ────────────────────────────────────────
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

  const javaFrames = [...forLocation.matchAll(/\bat\s+([\w$.]+)\(([\w]+\.java):(\d+)\)/g)];
  for (const frame of javaFrames) {
    if (!/^(java\.|javax\.|sun\.|com\.sun\.|org\.springframework\.|org\.apache\.)/.test(frame[1])) {
      failingLocation = `${frame[2]}:${frame[3]}`;
      break;
    }
  }

  if (!failingLocation) {
    const dotnetFrame = forLocation.match(/\bat\s+.+?\s+in\s+(.+\.cs):line\s+(\d+)/i);
    if (dotnetFrame) {
      failingLocation = `${dotnetFrame[1].split(/[\\/]/).pop()}:${dotnetFrame[2]}`;
    }
  }

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
// Only 5xx / unhandled exceptions with stack traces become incidents; 4xx / business
// validation errors are noise the remediation agents shouldn't be paged for.
function isExpectedException(content, exceptionText) {
  const fullText = `${content || ''} ${exceptionText || ''}`;
  if (!fullText.trim()) return false;

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
      if (code >= 400 && code < 500) return true;
      if (code >= 500 && code < 600) return false;
    }
  }

  const hasStackTrace = /\s+at\s+[\w$.]+\([^)]+\)/.test(fullText) ||
                        /\s+in\s+.+\.cs:line\s+\d+/i.test(fullText) ||
                        /File\s+".+\.py",\s+line\s+\d+/.test(fullText);
  if (hasStackTrace) return false;

  return /\b(?:not found|already exists|invalid|required|forbidden|unauthorized)\b/i.test(content || '');
}

// ── Incident document mapping ─────────────────────────────────────────────────
function mapToIncidentDocument(entry) {
  const parsed = entry.parsed || {};
  const content       = parsed.message || '';
  const exceptionText = parsed.exception || '';

  const serviceName    = parsed['service.name'] || entry.containerAppName.replace(/-svc$/, '-service');
  const errorSignature = extractErrorSignature(content, exceptionText);
  const exceptionType  = errorSignature.split(':')[0] || 'UnhandledException';

  return {
    incidentId:       `${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
    traceId:          parsed.traceId || parsed.trace_id || null,
    spanId:           parsed.spanId || parsed.span_id || null,
    serviceName,
    applicationName:  serviceName,
    hostName:         entry.containerAppName || 'unknown',
    pid:              0,
    exceptionType,
    category:         categorizeIncident({ incidentType: 'application_error', exceptionType }),
    exceptionMessage: content,
    stackTrace:       exceptionText || content,
    causedByChain:    exceptionText ? [exceptionText.split('\n')[0]] : [content],
    context: {
      source:         SOURCE_NAME,
      logger:         parsed.logger || '',
      thread:         parsed.thread || '',
      errorSignature,
    },
    createdAt:       new Date(),
    occurredAt:      new Date(entry.time),
    lastSeenAt:      new Date(entry.time),
    occurrenceCount: 0,
    healingStatus:   'PENDING',
    incidentKey:     `${serviceName}:${errorSignature}`,
    _class:          'com.azure.log.LogEntry',
  };
}

// ── Poll cycle ────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const lastProcessedTime = await readCheckpoint(SOURCE_NAME, CHECKPOINT_LOOKBACK_MS);
    logger.info(`${SOURCE_NAME}: poll cycle started (checkpoint: ${lastProcessedTime})`);

    const entries = await queryErrorLogs(lastProcessedTime);
    if (entries.length === 0) {
      logger.info(`${SOURCE_NAME}: no error logs`);
      return;
    }
    logger.info(`${SOURCE_NAME}: query returned ${entries.length} log line(s)`);

    const newEntries = entries.filter(e => new Date(e.time) > new Date(lastProcessedTime));
    if (newEntries.length === 0) {
      logger.info(`${SOURCE_NAME}: no new logs since checkpoint`);
      return;
    }

    const parseable = newEntries.filter((e) => {
      if (e.parsed) return true;
      logger.warn(`${SOURCE_NAME}: skipping unparseable log line for ${e.containerAppName}`);
      return false;
    });

    const incidentEntries = parseable.filter((e) => {
      const content = e.parsed.message || '';
      const exceptionText = e.parsed.exception || '';
      return !isExpectedException(content, exceptionText);
    });
    const skipped = newEntries.length - incidentEntries.length;
    logger.info(`${SOURCE_NAME}: ${incidentEntries.length} incident(s) to create, ${skipped} skipped`);

    if (incidentEntries.length > 0) {
      const db  = await getDB();
      const col = db.collection(MONGO_COLLECTION);

      for (const entry of incidentEntries) {
        const doc = mapToIncidentDocument(entry);
        await ingestIncidentDocument(col, doc, entry.time);
      }
      logger.info(`${SOURCE_NAME}: processed ${incidentEntries.length} error(s) into ${MONGO_COLLECTION}`);
    }

    const latest = new Date(newEntries[newEntries.length - 1].time);
    latest.setMilliseconds(latest.getMilliseconds() + 1);
    await writeCheckpoint(SOURCE_NAME, latest.toISOString());
  } catch (err) {
    logger.error(`${SOURCE_NAME}: poll error — ${err.message}`);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function ensureIndexes() {
  try {
    const db  = await getDB();
    const col = db.collection(MONGO_COLLECTION);
    await col.createIndex({ incidentKey: 1 },  { unique: true, background: true });
    await col.createIndex({ healingStatus: 1 }, { background: true });
    await col.createIndex({ incidentId: -1 },   { background: true });
    await col.createIndex({ createdAt: -1 },    { background: true });
    await col.createIndex({ traceId: 1 },       { background: true, sparse: true });
    logger.info(`${SOURCE_NAME}: MongoDB indexes ensured on ${MONGO_COLLECTION}`);
  } catch (err) {
    if (err.code !== 85 && err.code !== 86) {
      logger.warn(`${SOURCE_NAME}: index creation warning — ${err.message}`);
    }
  }
}

function start() {
  if (!LOG_WORKSPACE_ID) {
    logger.warn(`${SOURCE_NAME}: LOG_WORKSPACE_ID not set — poller disabled`);
    return;
  }
  if (!MONGO_COLLECTION) {
    logger.warn(`${SOURCE_NAME}: MONGO_COLLECTION_APP_LOG not set — refusing to start (will not fall back to the production collection)`);
    return;
  }

  logger.info(`${SOURCE_NAME} starting (workspace=${LOG_WORKSPACE_ID}, collection=${MONGO_COLLECTION})...`);
  ensureIndexes()
    .then(() => { poll(); setInterval(poll, POLL_INTERVAL_MS); })
    .catch(err => logger.error(`${SOURCE_NAME}: failed to start — ${err.message}`));
}

module.exports = {
  start,
  poll,
  buildQuery,
  parseLogLine,
  extractErrorSignature,
  isExpectedException,
  mapToIncidentDocument,
};
