// Approves every Lumen stage for the models currently configured, as a
// reviewed deployment would. Tests of the routing itself start from here;
// test/chat-provider-policy-guards.test.js covers what happens without it.
// Call it after the stage models are set: each approval is pinned to them.
export function approveLumenStages(config) {
  config.lumenPrimaryApproved = true;
  config.lumenApprovals.primaryModel = undefined;
  for (const [stage, modelKey] of [["gateway", "lumenFallback1"], ["secondary", "lumenFallback2"], ["reserve", "lumenFallback3"]]) {
    config.lumenApprovals[stage] = { approved: true, model: config.chatModels[modelKey] };
  }
}
