const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const ALLOWED_STATUSES = new Set(['PR_RAISED', 'ESCALATED']);
const UPDATABLE_FROM = new Set(['ISSUE_CREATED', 'IN_PROGRESS']);
const PR_RAISED_REPAIR_FROM = new Set(['ISSUE_CREATED', 'IN_PROGRESS', 'FAILED']);

/** Match issue/PR bodies stamped by incident-remediation-agent-copilot-fn */
const INCIDENT_ID_RE = /Incident MongoDB ID:\s*`?([a-f\d]{24})`?/i;

function extractIncidentMongoId(text) {
  if (!text) return null;
  const match = String(text).match(INCIDENT_ID_RE);
  return match ? match[1] : null;
}

function parseObjectId(id) {
  if (!id || !/^[a-f\d]{24}$/i.test(String(id))) {
    return null;
  }
  return new ObjectId(id);
}

function buildUpdateFields({ healingStatus, prUrl, prBranch, copilotGeneratedBranch, escalationReason, issueUrl }) {
  const now = new Date();
  const fields = { healingStatus, statusUpdatedAt: now };

  if (healingStatus === 'PR_RAISED') {
    if (prUrl) fields.prUrl = prUrl;
    const generatedBranch = copilotGeneratedBranch || prBranch;
    if (generatedBranch) {
      fields.copilotGeneratedBranch = generatedBranch;
      fields.prBranch = generatedBranch;
    }
    fields.prCreatedAt = now;
  }

  if (healingStatus === 'ESCALATED') {
    if (escalationReason) fields.escalationReason = escalationReason;
    if (issueUrl) fields.issueUrl = issueUrl;
    fields.escalatedAt = now;
  }

  return fields;
}

function canTransitionTo(healingStatus, currentStatus) {
  if (healingStatus === 'PR_RAISED') {
    return PR_RAISED_REPAIR_FROM.has(currentStatus);
  }
  return UPDATABLE_FROM.has(currentStatus);
}

/**
 * Transition incident healingStatus (Copilot webhook or manual PATCH).
 * @returns {{ ok: boolean, statusCode: number, body: object }}
 */
async function updateIncidentStatus(mongoIdRaw, update) {
  const mongoId = parseObjectId(mongoIdRaw);
  if (!mongoId) {
    return { ok: false, statusCode: 400, body: { error: 'Invalid MongoDB _id' } };
  }

  const { healingStatus } = update;
  if (!healingStatus || !ALLOWED_STATUSES.has(healingStatus)) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: 'healingStatus must be PR_RAISED or ESCALATED' },
    };
  }

  if (healingStatus === 'PR_RAISED' && !update.prUrl) {
    return { ok: false, statusCode: 400, body: { error: 'prUrl is required when healingStatus is PR_RAISED' } };
  }

  if (healingStatus === 'ESCALATED' && !update.escalationReason) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: 'escalationReason is required when healingStatus is ESCALATED' },
    };
  }

  const col = (await getDB()).collection(process.env.MONGO_COLLECTION);
  const existing = await col.findOne({ _id: mongoId }, { projection: { healingStatus: 1 } });

  if (!existing) {
    return { ok: false, statusCode: 404, body: { error: 'Incident not found' } };
  }

  if (existing.healingStatus === healingStatus) {
    logger.info(`Incident ${mongoId} already ${healingStatus} - idempotent OK`);
    return {
      ok: true,
      statusCode: 200,
      body: { incident_id: String(mongoId), healingStatus, status: 'unchanged' },
    };
  }

  if (!canTransitionTo(healingStatus, existing.healingStatus)) {
    return {
      ok: false,
      statusCode: 409,
      body: {
        error: `Cannot transition from ${existing.healingStatus} to ${healingStatus}`,
        currentStatus: existing.healingStatus,
      },
    };
  }

  const fields = buildUpdateFields(update);
  const updateDoc = { $set: fields };
  if (healingStatus === 'PR_RAISED' && existing.healingStatus === 'FAILED') {
    updateDoc.$unset = { agent_error: '' };
  }
  await col.updateOne({ _id: mongoId }, updateDoc);

  logger.info(`Incident ${mongoId}: ${existing.healingStatus} -> ${healingStatus}`);
  return {
    ok: true,
    statusCode: 200,
    body: {
      incident_id: String(mongoId),
      healingStatus,
      previousStatus: existing.healingStatus,
    },
  };
}

/**
 * Mark a Copilot remediation attempt as failed (empty PR after recheck window).
 * Allowed from ISSUE_CREATED or IN_PROGRESS only.
 */
async function markCopilotPrFailed(mongoIdRaw, { prUrl, reason }) {
  const mongoId = parseObjectId(mongoIdRaw);
  if (!mongoId) {
    return { ok: false, statusCode: 400, body: { error: 'Invalid MongoDB _id' } };
  }

  if (!reason) {
    return { ok: false, statusCode: 400, body: { error: 'reason is required when marking Copilot PR failed' } };
  }

  const col = (await getDB()).collection(process.env.MONGO_COLLECTION);
  const existing = await col.findOne({ _id: mongoId }, { projection: { healingStatus: 1 } });

  if (!existing) {
    return { ok: false, statusCode: 404, body: { error: 'Incident not found' } };
  }

  if (existing.healingStatus === 'FAILED') {
    return {
      ok: true,
      statusCode: 200,
      body: { incident_id: String(mongoId), healingStatus: 'FAILED', status: 'unchanged' },
    };
  }

  if (!UPDATABLE_FROM.has(existing.healingStatus)) {
    return {
      ok: false,
      statusCode: 409,
      body: {
        error: `Cannot transition from ${existing.healingStatus} to FAILED`,
        currentStatus: existing.healingStatus,
      },
    };
  }

  const now = new Date();
  const fields = {
    healingStatus: 'FAILED',
    statusUpdatedAt: now,
    agent_error: reason,
    agent_finished_at: now,
  };
  if (prUrl) fields.prUrl = prUrl;

  await col.updateOne({ _id: mongoId }, { $set: fields });

  logger.info(`Incident ${mongoId}: ${existing.healingStatus} -> FAILED (${reason})`);
  return {
    ok: true,
    statusCode: 200,
    body: {
      incident_id: String(mongoId),
      healingStatus: 'FAILED',
      previousStatus: existing.healingStatus,
    },
  };
}

module.exports = {
  updateIncidentStatus,
  markCopilotPrFailed,
  parseObjectId,
  extractIncidentMongoId,
};
