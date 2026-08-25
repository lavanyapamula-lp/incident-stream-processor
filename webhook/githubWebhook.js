const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const { updateIncidentStatus, markCopilotPrFailed, extractIncidentMongoId } = require('../services/incidentStatusUpdate');
const {
  hasDeliverableChanges,
  isLikelyCopilotPr,
  resolveIncidentMongoId,
  findMongoIdFromRecentIssue,
  isCopilotBotUser,
  parseCopilotAgentFailure,
} = require('../services/copilotPrValidation');
const {
  cancelScheduledRecheck,
  scheduleEmptyCopilotPrRecheck,
} = require('../services/copilotPrRecheck');
const { logLlmInvocation, estimateTokens } = require('../services/llmInvocationLogger');
const { finalizeCopilotBilling } = require('../services/copilotBilling');
const { maybeAdvanceCopilotModelQueue } = require('../services/copilotModelOrchestrator');

const router = express.Router();

function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !rawBody) return false;

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

function parseEscalationReason(commentBody) {
  const text = String(commentBody || '').trim();
  if (!text.toUpperCase().startsWith('ESCALATED:')) return null;
  return text.slice('ESCALATED:'.length).trim() || null;
}

async function handlePullRequest(payload) {
  const pr = payload.pull_request;
  const action = payload.action;
  const repository = payload.repository;

  if (!pr) return { handled: false, reason: 'missing pull_request' };
  if (!['opened', 'synchronize'].includes(action)) {
    return { handled: false, reason: `unsupported pull_request action ${action}` };
  }

  const owner = repository?.owner?.login;
  const repo = repository?.name;
  let mongoId = await resolveIncidentMongoId(pr, repository);

  if (!mongoId && action === 'opened' && isLikelyCopilotPr(pr)) {
    mongoId = await findMongoIdFromRecentIssue(repository);
  }

  if (hasDeliverableChanges(pr)) {
    if (!mongoId) {
      return { handled: false, reason: 'PR missing Incident MongoDB ID' };
    }

    if (owner && repo && pr.number) {
      cancelScheduledRecheck(owner, repo, pr.number);
    }

    const result = await updateIncidentStatus(mongoId, {
      healingStatus: 'PR_RAISED',
      prUrl: pr.html_url,
      prBranch: pr.head?.ref,
      copilotGeneratedBranch: pr.head?.ref,
    });

    await finalizeCopilotBilling(mongoId, { pr, repository, step: 'copilot_ai_credits_session' });
    await maybeAdvanceCopilotModelQueue(mongoId);

    return { handled: true, mongoId, result, action, deliverable: true };
  }

  if (action === 'opened' && isLikelyCopilotPr(pr) && mongoId && owner && repo) {
    scheduleEmptyCopilotPrRecheck({ mongoId, pr, owner, repo });
    return {
      handled: true,
      mongoId,
      action,
      deliverable: false,
      result: {
        ok: true,
        statusCode: 202,
        body: {
          incident_id: mongoId,
          status: 'awaiting_copilot_changes',
          message: 'Empty Copilot PR opened; recheck scheduled',
        },
      },
    };
  }

  return {
    handled: false,
    reason: action === 'opened'
      ? 'PR has no file changes yet'
      : 'PR synchronize event had no deliverable file changes',
  };
}

async function handleIssueCommentCreated(payload) {
  const comment = payload.comment;
  const issue = payload.issue;
  if (!comment || !issue) return { handled: false, reason: 'missing comment or issue' };

  const mongoId = extractIncidentMongoId(issue.body);
  if (!mongoId) {
    return { handled: false, reason: 'issue body missing Incident MongoDB ID' };
  }

  const copilotFailure = parseCopilotAgentFailure(comment.body);
  if (copilotFailure && isCopilotBotUser(comment.user?.login)) {
    const result = await markCopilotPrFailed(mongoId, { reason: copilotFailure });
    await maybeAdvanceCopilotModelQueue(mongoId);
    return { handled: true, mongoId, result, copilotFailure: true };
  }

  const escalationReason = parseEscalationReason(comment.body);
  if (!escalationReason) {
    return { handled: false, reason: 'comment is not a Copilot failure or ESCALATED:' };
  }

  const result = await updateIncidentStatus(mongoId, {
    healingStatus: 'ESCALATED',
    escalationReason,
    issueUrl: issue.html_url,
  });

  await maybeAdvanceCopilotModelQueue(mongoId);

  await logLlmInvocation({
    incidentId: mongoId,
    model: process.env.COPILOT_MODEL || 'claude-sonnet-5',
    provider: 'github-copilot',
    step: 'copilot_escalated',
    promptTokens: estimateTokens(comment.body),
    completionTokens: estimateTokens(escalationReason),
    metadata: { issueNumber: issue.number, issueUrl: issue.html_url },
  });

  return { handled: true, mongoId, result };
}

/**
 * POST /api/github/webhook
 * Mount with express.raw({ type: 'application/json' }) so HMAC verification works.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('GitHub webhook: GITHUB_WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'Expected raw JSON body' });
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    logger.warn('GitHub webhook: rejected - invalid x-hub-signature-256');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const event = req.headers['x-github-event'];
  const action = payload.action;

  try {
    if (event === 'pull_request' && ['opened', 'synchronize'].includes(action)) {
      const outcome = await handlePullRequest(payload);
      if (!outcome.handled) {
        logger.info(`GitHub webhook: ignored pull_request.${action} - ${outcome.reason}`);
        return res.status(200).json({ status: 'ignored', reason: outcome.reason });
      }

      const status = outcome.result?.body?.healingStatus
        || outcome.result?.body?.status
        || 'processed';
      logger.info(
        `GitHub webhook: pull_request.${action} incident=${outcome.mongoId} deliverable=${outcome.deliverable} -> ${status}`
      );
      return res.status(outcome.result.statusCode).json(outcome.result.body);
    }

    if (event === 'issue_comment' && action === 'created') {
      const outcome = await handleIssueCommentCreated(payload);
      if (!outcome.handled) {
        logger.info(`GitHub webhook: ignored issue_comment.created - ${outcome.reason}`);
        return res.status(200).json({ status: 'ignored', reason: outcome.reason });
      }

      logger.info(
        `GitHub webhook: issue_comment.created incident=${outcome.mongoId} -> ${outcome.result.body.healingStatus ?? 'error'}`
      );
      return res.status(outcome.result.statusCode).json(outcome.result.body);
    }

    logger.info(`GitHub webhook: ignored event=${event} action=${action}`);
    return res.status(200).json({ status: 'ignored', event, action });
  } catch (err) {
    logger.error(`GitHub webhook error: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
