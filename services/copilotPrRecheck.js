const logger = require('../utils/logger');
const { updateIncidentStatus, markCopilotPrFailed } = require('./incidentStatusUpdate');
const {
  fetchPullRequestStats,
  hasDeliverableChanges,
  resolveIncidentMongoId,
} = require('./copilotPrValidation');
const { finalizeCopilotBilling } = require('./copilotBilling');
const { maybeAdvanceCopilotModelQueue } = require('./copilotModelOrchestrator');

const pendingTimers = new Map();
const recheckAttempts = new Map();

function recheckDelayMs() {
  const configured = Number(process.env.COPILOT_PR_RECHECK_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 300000;
}

function maxRecheckAttempts() {
  const configured = Number(process.env.COPILOT_PR_RECHECK_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured > 0 ? configured : 3;
}

function scheduleKey(owner, repo, pullNumber) {
  return `${owner}/${repo}#${pullNumber}`;
}

function cancelScheduledRecheck(owner, repo, pullNumber) {
  const key = scheduleKey(owner, repo, pullNumber);
  const timer = pendingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(key);
  }
  recheckAttempts.delete(key);
}

async function recheckCopilotPr({ mongoId, owner, repo, pullNumber, prUrl, attempt = 1 }) {
  if (!process.env.GITHUB_TOKEN) {
    logger.warn(`Copilot PR recheck skipped for #${pullNumber} — GITHUB_TOKEN not set`);
    return { ok: false, reason: 'GITHUB_TOKEN not set' };
  }

  try {
    const pr = await fetchPullRequestStats(owner, repo, pullNumber);
    const resolvedMongoId = mongoId || (await resolveIncidentMongoId(pr, { owner: { login: owner }, name: repo }));

    if (!resolvedMongoId) {
      logger.warn(`Copilot PR recheck for #${pullNumber} — Incident MongoDB ID not found`);
      return { ok: false, reason: 'Incident MongoDB ID not found' };
    }

    if (hasDeliverableChanges(pr)) {
      cancelScheduledRecheck(owner, repo, pullNumber);
      const result = await updateIncidentStatus(resolvedMongoId, {
        healingStatus: 'PR_RAISED',
        prUrl: pr.html_url || prUrl,
        prBranch: pr.head?.ref,
      });
      await finalizeCopilotBilling(resolvedMongoId, {
        pr,
        repository: { owner: { login: owner }, name: repo },
        step: 'copilot_ai_credits_session',
      });
      logger.info(`Copilot PR recheck: PR #${pullNumber} now has changes -> PR_RAISED`);
      return { ok: true, outcome: 'PR_RAISED', result };
    }

    const key = scheduleKey(owner, repo, pullNumber);
    const maxAttempts = maxRecheckAttempts();

    if (attempt < maxAttempts) {
      recheckAttempts.set(key, attempt + 1);
      const delayMs = recheckDelayMs();
      const timer = setTimeout(() => {
        pendingTimers.delete(key);
        recheckCopilotPr({
          mongoId: resolvedMongoId,
          owner,
          repo,
          pullNumber,
          prUrl: pr.html_url || prUrl,
          attempt: attempt + 1,
        }).catch((err) => {
          logger.error(`Scheduled Copilot PR recheck error: ${err.message}`);
        });
      }, delayMs);
      pendingTimers.set(key, timer);
      logger.info(
        `Copilot PR #${pullNumber} still empty (attempt ${attempt}/${maxAttempts}) — next recheck in ${Math.round(delayMs / 1000)}s`
      );
      return { ok: true, outcome: 'RECHECK_SCHEDULED', attempt };
    }

    recheckAttempts.delete(key);
    const result = await markCopilotPrFailed(resolvedMongoId, {
      prUrl: pr.html_url || prUrl,
      reason: 'Copilot PR had no file changes after recheck window',
    });
    await maybeAdvanceCopilotModelQueue(resolvedMongoId);
    logger.warn(`Copilot PR recheck: PR #${pullNumber} still empty -> FAILED`);
    return { ok: true, outcome: 'FAILED', result };
  } catch (err) {
    logger.error(`Copilot PR recheck failed for #${pullNumber}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

function scheduleEmptyCopilotPrRecheck({ mongoId, pr, owner, repo }) {
  if (!pr?.number) return;

  const key = scheduleKey(owner, repo, pr.number);
  if (pendingTimers.has(key)) return;

  recheckAttempts.set(key, 1);
  const delayMs = recheckDelayMs();
  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    recheckCopilotPr({
      mongoId,
      owner,
      repo,
      pullNumber: pr.number,
      prUrl: pr.html_url,
    }).catch((err) => {
      logger.error(`Scheduled Copilot PR recheck error: ${err.message}`);
    });
  }, delayMs);

  pendingTimers.set(key, timer);
  logger.info(
    `Scheduled Copilot PR recheck in ${Math.round(delayMs / 1000)}s for ${owner}/${repo}#${pr.number}`
  );
}

module.exports = {
  scheduleEmptyCopilotPrRecheck,
  recheckCopilotPr,
  cancelScheduledRecheck,
  recheckDelayMs,
};
