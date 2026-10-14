import { Context } from "@temporalio/activity";
import {
  type LogCollectorExecutionContext,
  reconcileLogCollector,
} from "@workspace/towbar-deployer";
import { signedApiRequest } from "../infrastructure/towbar-api.js";

export async function executeLogCollectorActivity(input: {
  serverId: string;
  generation: string;
}) {
  const activity = Context.current(),
    pulse = setInterval(() => activity.heartbeat(input), 10000);
  try {
    const { context } = await signedApiRequest<{
      context: LogCollectorExecutionContext | null;
    }>(
      "GET",
      `/v1/internal/log-collectors/${input.serverId}/${input.generation}/context`,
    );
    if (!context) return;
    await reconcileLogCollector(context, activity.cancellationSignal);
    await signedApiRequest(
      "POST",
      `/v1/internal/log-collectors/${input.serverId}/${input.generation}/complete`,
      { succeeded: true },
    );
  } catch {
    throw new Error("Log collector operation failed");
  } finally {
    clearInterval(pulse);
  }
}
export async function failLogCollectorActivity(input: {
  serverId: string;
  generation: string;
}) {
  await signedApiRequest(
    "POST",
    `/v1/internal/log-collectors/${input.serverId}/${input.generation}/complete`,
    { succeeded: false },
  );
}
