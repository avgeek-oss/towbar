import { ApplicationFailure, Context } from "@temporalio/activity";

import {
  type ServerPreparationStep,
  type ServerPreparationStepId,
  createServerPreparationSteps,
  limitServerPreparationStepMessage,
} from "@workspace/towbar-core";
import {
  HostKeyNotTrustedError,
  type LogCollectorExecutionContext,
  type ServerPreparationContext,
  ServerPreparationError,
  prepareServer,
  reconcileLogCollector,
} from "@workspace/towbar-deployer";

import { signedApiRequest } from "../infrastructure/towbar-api.js";

export async function executeServerPreparationActivity(preparationId: string) {
  const activity = Context.current();
  const steps = createServerPreparationSteps();
  const pulse = setInterval(
    () => activity.heartbeat({ preparationId }),
    10_000,
  );

  const updateStep = async (input: {
    id: ServerPreparationStepId;
    message: string;
    status: "running" | "succeeded" | "failed";
  }) => {
    const step = steps.find((candidate) => candidate.id === input.id);
    if (!step) throw new Error(`Unknown server preparation step: ${input.id}`);
    const now = new Date().toISOString();
    if (input.status === "running") {
      step.startedAt ??= now;
      step.finishedAt = null;
    } else {
      step.startedAt ??= now;
      step.finishedAt = now;
    }
    step.message = limitServerPreparationStepMessage(input.message);
    step.status = input.status;
    await signedApiRequest(
      "POST",
      `/v1/internal/server-preparations/${preparationId}/events`,
      { status: "running", steps },
    );
    activity.heartbeat({ preparationId, step: input.id });
  };

  try {
    const response = await signedApiRequest<{
      context: ServerPreparationContext;
    }>("GET", `/v1/internal/server-preparations/${preparationId}/context`);
    const result = await prepareServer(response.context, {
      step: updateStep,
      installLogCollector: async () => {
        const { context, message } = await signedApiRequest<{
          context: LogCollectorExecutionContext | null;
          message: string;
        }>(
          "POST",
          `/v1/internal/server-preparations/${preparationId}/log-collector`,
          {},
        );
        if (!context) return message;
        const completion = `/v1/internal/log-collectors/${context.serverId}/${context.generation}/complete`;
        try {
          await reconcileLogCollector(context, activity.cancellationSignal);
        } catch {
          await signedApiRequest("POST", completion, { succeeded: false });
          throw new Error(
            "Log collector installation failed. Check Docker, SSH access, and outbound HTTPS to the Towbar API, then retry setup.",
          );
        }
        await signedApiRequest("POST", completion, { succeeded: true });
        return message;
      },
      log: async ({ id, log, logTruncated }) => {
        const step = steps.find((candidate) => candidate.id === id);
        if (!step) throw new Error(`Unknown server preparation step: ${id}`);
        step.log = log;
        step.logTruncated = logTruncated;
        await signedApiRequest(
          "POST",
          `/v1/internal/server-preparations/${preparationId}/events`,
          { status: "running", steps },
        );
        activity.heartbeat({ preparationId, step: id });
      },
    });
    await signedApiRequest(
      "POST",
      `/v1/internal/server-preparations/${preparationId}/events`,
      { result, status: "succeeded", steps },
    );
  } catch (error) {
    const errorMessage = safeErrorMessage(error);
    await signedApiRequest(
      "POST",
      `/v1/internal/server-preparations/${preparationId}/events`,
      {
        errorCode:
          error instanceof HostKeyNotTrustedError
            ? "HOST_KEY_NOT_TRUSTED"
            : error instanceof ServerPreparationError
              ? `SERVER_PREPARATION_${error.stepId.toUpperCase()}`
              : "SERVER_PREPARATION_FAILED",
        errorMessage,
        status: "failed",
        steps: normalizeFailedSteps(steps, error),
      },
    );
    throw ApplicationFailure.create({
      message: errorMessage,
      nonRetryable: true,
      type:
        error instanceof ServerPreparationError
          ? "ServerPreparationFailed"
          : "ServerPreparationUnavailable",
    });
  } finally {
    clearInterval(pulse);
  }
}

function normalizeFailedSteps(steps: ServerPreparationStep[], error: unknown) {
  if (
    error instanceof ServerPreparationError &&
    !steps.some((step) => step.status === "failed")
  ) {
    const step = steps.find((candidate) => candidate.id === error.stepId);
    if (step) {
      const now = new Date().toISOString();
      step.startedAt ??= now;
      step.finishedAt = now;
      step.message = safeErrorMessage(error);
      step.status = "failed";
    }
  }
  return steps;
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 800)
    : "Server preparation failed";
}
