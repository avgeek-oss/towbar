import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { executeLogCollectorActivity, failLogCollectorActivity } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "10 minutes",
    heartbeatTimeout: "30 seconds",
    retry: {
      maximumAttempts: 3,
      initialInterval: "10 seconds",
      maximumInterval: "1 minute",
    },
  });
export async function runLogCollectorWorkflow(input: {
  serverId: string;
  generation: string;
}) {
  try {
    await executeLogCollectorActivity(input);
  } catch {
    await failLogCollectorActivity(input);
  }
}
