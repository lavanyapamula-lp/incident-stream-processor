/**
 * Unit tests for Copilot PR validation helpers.
 * Usage: node test/copilot-pr-validation.test.js
 */

const {
  hasDeliverableChanges,
  isLikelyCopilotPr,
  extractMongoIdFromTexts,
  parseLinkedIssueNumbers,
  isCopilotBotUser,
  parseCopilotAgentFailure,
} = require('../services/copilotPrValidation');

let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed += 1;
  }
}

const mongoId = '6a3890020875add9c739496c';

assert(hasDeliverableChanges({ changed_files: 3 }) === true, 'non-zero changed_files counts as deliverable');
assert(hasDeliverableChanges({ changed_files: 0 }) === false, 'zero changed_files is not deliverable');
assert(hasDeliverableChanges({}) === false, 'missing changed_files is not deliverable');

assert(
  isLikelyCopilotPr({ user: { login: 'app/copilot-swe-agent' }, head: { ref: 'feature/foo' } }) === true,
  'copilot user is recognized'
);
assert(
  isLikelyCopilotPr({ user: { login: 'devuser' }, head: { ref: `copilot/${mongoId}` } }) === true,
  'copilot/incident-id branch is recognized'
);
assert(
  isLikelyCopilotPr({ user: { login: 'devuser' }, head: { ref: `gemini/${mongoId}` } }) === true,
  'gemini/incident-id branch is recognized'
);
assert(
  isLikelyCopilotPr({ user: { login: 'devuser' }, head: { ref: 'copilot/fix-valueerror' } }) === false,
  'legacy descriptive copilot branch is not treated as remediation'
);
assert(
  isLikelyCopilotPr({ user: { login: 'devuser' }, head: { ref: `fix/incident-${mongoId}` } }) === true,
  'legacy fix/incident branch is still recognized'
);
assert(
  isLikelyCopilotPr({ user: { login: 'devuser' }, head: { ref: 'feature/manual-fix' } }) === false,
  'unrelated branch is not treated as copilot remediation'
);

assert(
  extractMongoIdFromTexts([`Incident MongoDB ID: \`${mongoId}\``]) === mongoId,
  'extracts mongo id from stamped text'
);
assert(
  extractMongoIdFromTexts(['no id here']) === null,
  'returns null when mongo id is absent'
);

const linked = [...parseLinkedIssueNumbers('Closes #48 and refs #49')];
assert(linked.includes(48), 'parses Closes issue number');
assert(linked.length === 1, 'prefers explicit close/fix references over bare issue refs');

const bareRefs = [...parseLinkedIssueNumbers('See issue #48 for context')];
assert(bareRefs.includes(48), 'parses bare issue references when no close/fix verb is present');

assert(isCopilotBotUser('Copilot') === true, 'Copilot display user is recognized');
assert(
  parseCopilotAgentFailure('The agent encountered an error and was unable to start working on this issue') != null,
  'Copilot agent failure comment is detected'
);
assert(parseCopilotAgentFailure('Looks good to me') === null, 'normal comments are ignored');

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log('OK — copilot PR validation tests passed');
