const axios = require('axios');
const { getDB } = require('../config/db');
const { extractIncidentMongoId } = require('./incidentStatusUpdate');

const COPILOT_BRANCH_RE = /^(copilot\/|fix\/incident-[a-f\d]{24})/i;
const AGENT_BRANCH_RE = /^(gemini|claude|foundry|copilot)\/[a-f\d]{24}$/i;
const COPILOT_USER_RE = /copilot/i;
const LINKED_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const ISSUE_REF_RE = /#(\d+)\b/g;

function hasDeliverableChanges(pr) {
  if (Number(pr?.changed_files) > 0) return true;
  return Number(pr?.additions || 0) + Number(pr?.deletions || 0) > 0;
}

function isLikelyCopilotPr(pr) {
  const user = pr?.user?.login || '';
  const branch = pr?.head?.ref || '';
  return COPILOT_USER_RE.test(user) || COPILOT_BRANCH_RE.test(branch) || AGENT_BRANCH_RE.test(branch);
}

function extractMongoIdFromTexts(texts) {
  for (const text of texts) {
    const mongoId = extractIncidentMongoId(text);
    if (mongoId) return mongoId;
  }
  return null;
}

function parseLinkedIssueNumbers(text) {
  const numbers = new Set();
  if (!text) return numbers;

  for (const match of String(text).matchAll(LINKED_ISSUE_RE)) {
    numbers.add(Number(match[1]));
  }

  if (numbers.size === 0) {
    for (const match of String(text).matchAll(ISSUE_REF_RE)) {
      numbers.add(Number(match[1]));
    }
  }

  return numbers;
}

function githubAuthHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchPullRequestCommitMessages(owner, repo, pullNumber) {
  const headers = githubAuthHeaders();
  if (!headers) return [];

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/commits`;
  const { data } = await axios.get(url, {
    headers,
    params: { per_page: 100 },
    timeout: 15000,
  });

  return (data || []).map((commit) => commit.commit?.message || '').filter(Boolean);
}

async function fetchIssueBody(owner, repo, issueNumber) {
  const headers = githubAuthHeaders();
  if (!headers) return null;

  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  const { data } = await axios.get(url, { headers, timeout: 15000 });
  return data?.body || null;
}

async function fetchLinkedIssueBodies(owner, repo, prBody) {
  const issueNumbers = parseLinkedIssueNumbers(prBody);
  const bodies = [];

  for (const issueNumber of issueNumbers) {
    const body = await fetchIssueBody(owner, repo, issueNumber);
    if (body) bodies.push(body);
  }

  return bodies;
}

/**
 * Resolve incident MongoDB ID from PR body, commit messages, or linked issue bodies.
 * Falls back to GitHub API only when GITHUB_TOKEN is configured.
 */
async function resolveIncidentMongoId(pr, repository) {
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const texts = [pr?.body].filter(Boolean);

  let mongoId = extractMongoIdFromTexts(texts);
  if (mongoId) return mongoId;

  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    return null;
  }

  if (pr?.number) {
    const commitMessages = await fetchPullRequestCommitMessages(owner, repo, pr.number);
    mongoId = extractMongoIdFromTexts(commitMessages);
    if (mongoId) return mongoId;
  }

  const issueBodies = await fetchLinkedIssueBodies(owner, repo, pr?.body);
  mongoId = extractMongoIdFromTexts(issueBodies);
  return mongoId;
}

async function fetchPullRequestStats(owner, repo, pullNumber) {
  const headers = githubAuthHeaders();
  if (!headers) {
    throw new Error('GITHUB_TOKEN is not configured');
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;
  const { data } = await axios.get(url, { headers, timeout: 15000 });
  return data;
}

/**
 * Fallback when Copilot opens an empty PR without stamping the MongoDB ID.
 * Uses the most recent ISSUE_CREATED incident for this repo (last 24h).
 */
async function findMongoIdFromRecentIssue(repository) {
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (!owner || !repo) return null;

  const col = (await getDB()).collection(process.env.MONGO_COLLECTION);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const repoFullName = `${owner}/${repo}`;

  const doc = await col.findOne(
    {
      healingStatus: 'ISSUE_CREATED',
      issueCreatedAt: { $gte: since },
      $or: [{ githubRepo: repoFullName }, { serviceName: repo }],
    },
    { sort: { issueCreatedAt: -1 }, projection: { _id: 1 } }
  );

  return doc?._id ? String(doc._id) : null;
}

const COPILOT_BOT_USER_RE = /copilot/i;
const COPILOT_AGENT_FAILURE_RE = /encountered an error|unable to start|ruleset violation/i;

function isCopilotBotUser(login) {
  return COPILOT_BOT_USER_RE.test(String(login || ''));
}

/** Copilot posts this when the coding agent cannot start (e.g. ruleset violation). */
function parseCopilotAgentFailure(commentBody) {
  const text = String(commentBody || '').trim();
  if (!text || !COPILOT_AGENT_FAILURE_RE.test(text)) return null;
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || text;
  return firstLine.slice(0, 500);
}

module.exports = {
  hasDeliverableChanges,
  isLikelyCopilotPr,
  resolveIncidentMongoId,
  fetchPullRequestStats,
  findMongoIdFromRecentIssue,
  parseLinkedIssueNumbers,
  extractMongoIdFromTexts,
  isCopilotBotUser,
  parseCopilotAgentFailure,
};
