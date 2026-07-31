/**
 * checkpointStore.js
 *
 * Poller checkpoint storage in MongoDB — cloud-agnostic, replacing the
 * per-poller Azure Blob Storage checkpoint mechanism. Each poller
 * (application-log-poller, dynatrace-log-poller, ...) gets its own document
 * keyed by poller name, so this collection can serve multiple pollers.
 */

const { getDB } = require('../config/db');
const logger = require('../utils/logger');

function collectionName() {
  return process.env.POLLER_CHECKPOINT_COLLECTION || 'poller_checkpoints';
}

/** Returns the stored checkpoint, or a lookback-window default if none exists yet. */
async function readCheckpoint(pollerName, fallbackLookbackMs) {
  try {
    const db = await getDB();
    const doc = await db.collection(collectionName()).findOne({ _id: pollerName });
    if (doc?.lastProcessedTime) {
      logger.info(`checkpointStore: ${pollerName} checkpoint read — ${doc.lastProcessedTime}`);
      return doc.lastProcessedTime;
    }
  } catch (err) {
    logger.error(`checkpointStore: failed to read checkpoint for ${pollerName} — ${err.message}`);
  }

  const fallback = new Date(Date.now() - fallbackLookbackMs).toISOString();
  logger.info(`checkpointStore: no checkpoint for ${pollerName}, defaulting to ${fallback}`);
  return fallback;
}

async function writeCheckpoint(pollerName, timestamp) {
  const db = await getDB();
  await db.collection(collectionName()).updateOne(
    { _id: pollerName },
    { $set: { lastProcessedTime: timestamp, updatedAt: new Date() } },
    { upsert: true },
  );
  logger.info(`checkpointStore: ${pollerName} checkpoint updated — ${timestamp}`);
}

module.exports = { readCheckpoint, writeCheckpoint };
