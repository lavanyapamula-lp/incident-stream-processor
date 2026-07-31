/**
 * monitoredServices.js
 *
 * Decides which Container Apps the log poller should treat as monitored,
 * without any hardcoded/static allowlist or env-var-based tag config:
 *   1. Primary: Azure resource tags, discovered via Resource Graph. The tag
 *      rule(s) to match on live in the shared `remediation_config` collection
 *      (_id: "tag_discovery") — a *list* of {key, value} rules, since
 *      different teams/projects tag their own resources differently, with
 *      matchMode "any" (default — resource matches if any rule hits) or
 *      "all" (must match every rule).
 *   2. Fallback: an explicit list stored in the same `config` collection
 *      (_id: "monitored_services"), used only when tag discovery finds
 *      nothing — no tag_discovery doc yet, or the query legitimately
 *      returns zero tagged resources.
 *
 * Result is cached in memory and refreshed periodically — discovery is not
 * re-run on every 60-second poll cycle.
 */

const { ResourceGraphClient } = require('@azure/arm-resourcegraph');
const { DefaultAzureCredential } = require('@azure/identity');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const AZURE_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID;
const REFRESH_INTERVAL_MS = Number(process.env.MONITORED_SERVICES_REFRESH_MS || 10 * 60_000);

function configCollectionName() {
  return process.env.CONFIG_COLLECTION || 'remediation_config';
}

let resourceGraphClient = null;
function getResourceGraphClient() {
  if (!resourceGraphClient) {
    resourceGraphClient = new ResourceGraphClient(new DefaultAzureCredential());
  }
  return resourceGraphClient;
}

let cache = { loadedAt: 0, names: [] };

async function loadTagDiscoveryConfig() {
  try {
    const db = await getDB();
    const doc = await db.collection(configCollectionName()).findOne({ _id: 'tag_discovery' });
    if (doc?.rules?.length) {
      return { rules: doc.rules, matchMode: doc.matchMode === 'all' ? 'all' : 'any' };
    }
  } catch (err) {
    logger.warn(`monitoredServices: failed to read tag_discovery config — ${err.message}`);
  }
  return null;
}

function buildTagFilter(rules, matchMode) {
  const clauses = rules
    .filter((rule) => rule?.key && rule?.value)
    .map((rule) => `tags['${rule.key}'] == '${rule.value}'`);
  if (clauses.length === 0) return null;
  return clauses.join(matchMode === 'all' ? ' and ' : ' or ');
}

async function discoverByTags() {
  const config = await loadTagDiscoveryConfig();
  if (!config) {
    logger.info('monitoredServices: no tag_discovery config in Mongo — skipping tag discovery');
    return [];
  }

  if (!AZURE_SUBSCRIPTION_ID) {
    logger.warn('monitoredServices: AZURE_SUBSCRIPTION_ID not set — skipping tag discovery');
    return [];
  }

  const tagFilter = buildTagFilter(config.rules, config.matchMode);
  if (!tagFilter) {
    logger.warn('monitoredServices: tag_discovery config has no valid rules — skipping tag discovery');
    return [];
  }

  const query = `
    Resources
    | where type =~ 'microsoft.app/containerapps'
    | where (${tagFilter})
    | project name
  `;

  try {
    const client = getResourceGraphClient();
    const result = await client.resources({ query, subscriptions: [AZURE_SUBSCRIPTION_ID] });
    return (result.data || []).map((row) => row.name).filter(Boolean);
  } catch (err) {
    logger.error(`monitoredServices: tag discovery query failed — ${err.message}`);
    return [];
  }
}

async function discoverFromMongoFallback() {
  try {
    const db = await getDB();
    const doc = await db.collection(configCollectionName()).findOne({ _id: 'monitored_services' });
    return (doc?.services || []).map((service) => service.containerAppName).filter(Boolean);
  } catch (err) {
    logger.error(`monitoredServices: Mongo fallback lookup failed — ${err.message}`);
    return [];
  }
}

/** Container app names to monitor — tags first, Mongo fallback if tags find nothing. */
async function discoverMonitoredContainerApps(force = false) {
  if (!force && cache.names.length && Date.now() - cache.loadedAt < REFRESH_INTERVAL_MS) {
    return cache.names;
  }

  let names = await discoverByTags();
  let source = 'tags';

  if (names.length === 0) {
    names = await discoverFromMongoFallback();
    source = 'monitored_services (Mongo fallback)';
  }

  if (names.length === 0) {
    logger.error('monitoredServices: no monitored container apps found via tags or Mongo fallback — poller has nothing to query');
  } else {
    logger.info(`monitoredServices: resolved ${names.length} container app(s) via ${source} — ${names.join(', ')}`);
  }

  cache = { loadedAt: Date.now(), names };
  return names;
}

function invalidateCache() {
  cache = { loadedAt: 0, names: [] };
}

module.exports = { discoverMonitoredContainerApps, invalidateCache };
