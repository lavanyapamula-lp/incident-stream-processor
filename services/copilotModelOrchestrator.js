const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const logger = require('../utils/logger');

const TERMINAL_STATUSES = new Set(['PR_RAISED', 'FAILED', 'ESCALATED']);
const QUEUED_STATUS = 'COPILOT_QUEUED';
const ACTIVE_COPILOT_STATUSES = ['PENDING', 'IN_PROGRESS', 'ISSUE_CREATED'];

function resolveCopilotModelBenchmark(run) {
  const raw = run?.copilotModelBenchmark;
  if (!raw) return null;
  if (raw.enabled !== undefined) return raw;
  if (raw.copilotModelBenchmark?.enabled !== undefined) return raw.copilotModelBenchmark;
  return null;
}

async function maybeAdvanceCopilotModelQueue(mongoId) {
  const col = (await getDB()).collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  const incident = await col.findOne({ _id: new ObjectId(String(mongoId)) });
  if (!incident?.benchmarkRunId || !incident.benchmarkCopilotModelId) return { advanced: false };

  if (!TERMINAL_STATUSES.has(incident.healingStatus)) {
    return { advanced: false, reason: 'not_terminal' };
  }

  return advanceCopilotModelQueue(incident.benchmarkRunId, incident.benchmarkCopilotModelId);
}

/**
 * Promote the next COPILOT_QUEUED child to PENDING after a model run completes.
 */
async function advanceCopilotModelQueue(benchmarkRunId, completedModelId) {
  const db = await getDB();
  const incidentCol = db.collection(process.env.MONGO_COLLECTION || 'service_error_logs');
  const runsCol = db.collection(process.env.BENCHMARK_RUNS_COLLECTION || 'benchmark_runs');
  const runId = new ObjectId(String(benchmarkRunId));

  const run = await runsCol.findOne({ _id: runId });
  const copilotModelBenchmark = resolveCopilotModelBenchmark(run);
  if (!copilotModelBenchmark?.enabled) {
    return { advanced: false, reason: 'not_multi_model_run' };
  }

  const activeCopilot = await incidentCol.findOne(
    {
      benchmarkRunId: runId,
      benchmarkCopilotModelId: { $exists: true },
      healingStatus: { $in: ACTIVE_COPILOT_STATUSES },
    },
    { projection: { _id: 1, healingStatus: 1, benchmarkCopilotModel: 1 } },
  );
  if (activeCopilot) {
    return {
      advanced: false,
      reason: 'copilot_model_still_active',
      activeIncidentId: String(activeCopilot._id),
      activeModel: activeCopilot.benchmarkCopilotModel,
    };
  }

  const completedKey = `copilot:${completedModelId}`;
  const completedModels = new Set(copilotModelBenchmark.completedModels || []);
  if (!completedModels.has(completedModelId)) {
    completedModels.add(completedModelId);
  }

  const next = await incidentCol
    .find({
      benchmarkRunId: runId,
      healingStatus: QUEUED_STATUS,
      benchmarkCopilotModelId: { $exists: true },
    })
    .sort({ benchmarkCopilotSequence: 1 })
    .limit(1)
    .next();

  const patch = {
    'copilotModelBenchmark.completedModels': [...completedModels],
    'copilotModelBenchmark.currentModelIndex': copilotModelBenchmark.models.indexOf(completedModelId) + 1,
  };

  if (!next) {
    patch['copilotModelBenchmark.status'] = 'completed';
    await runsCol.updateOne({ _id: runId }, { $set: patch });
    logger.info(`Copilot model queue completed for benchmark run ${String(runId)}`);
    return { advanced: false, completed: true, completedModel: completedModelId };
  }

  await incidentCol.updateOne(
    { _id: next._id },
    {
      $set: {
        healingStatus: 'PENDING',
        copilotQueuePromotedAt: new Date(),
      },
      $unset: { dispatchedAt: '', dispatchedTo: '' },
    },
  );

  patch['copilotModelBenchmark.status'] = 'running';
  await runsCol.updateOne({ _id: runId }, { $set: patch });

  logger.info(
    `Copilot model queue advanced for run ${String(runId)}: `
    + `${completedKey} done → promoting ${next.benchmarkCopilotModel} (${String(next._id)})`,
  );

  return {
    advanced: true,
    completedModel: completedModelId,
    nextModel: next.benchmarkCopilotModel,
    nextIncidentId: String(next._id),
  };
}

module.exports = {
  maybeAdvanceCopilotModelQueue,
  advanceCopilotModelQueue,
  QUEUED_STATUS,
};
