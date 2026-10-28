"use client";

import { defineClientTool, useAgentChat } from "@avgeek-oss/agent-react";
import {
  AgentChat,
  type AgentConversationSummary,
} from "@avgeek-oss/design-system/patterns/agent-chat/agent-chat";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { config } from "@/lib/config";
import { refreshApiQueries } from "@/hooks/use-api-query";
import { useRouter } from "@/hooks/use-guarded-router";

export function Assistant({
  onClose,
  workspaceName,
  entityNames,
}: {
  onClose: () => void;
  workspaceName: string;
  entityNames?: Record<string, string>;
}) {
  const router = useRouter();
  const assistantFetch = useCallback<typeof fetch>((input, init) => {
    const url = new URL(config.apiBaseUrl + String(input));
    return fetch(url, {
      ...init,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
  }, []);
  const clientTools = useMemo(
    () => [
      defineClientTool({
        name: "refresh_page_data",
        description:
          "Refresh the visible infrastructure and operation status after changes.",
        input: z.object({}),
        run: () => {
          refreshApiQueries();
          router.refresh();
          return "Page data refreshed.";
        },
      }),
      defineClientTool({
        name: "open_towbar_page",
        description:
          "Open the overview, services, datastores, servers, repositories, deployments or logs.",
        input: z.object({
          page: z.enum([
            "overview",
            "services",
            "datastores",
            "servers",
            "repositories",
            "deployments",
            "logs",
          ]),
        }),
        run: ({ page }) => {
          const paths = {
            overview: "/",
            services: "/services",
            datastores: "/datastores",
            servers: "/servers",
            repositories: "/repositories",
            deployments: "/deployments",
            logs: "/monitoring/logs",
          };
          router.push(paths[page]);
          return `Opened ${page}.`;
        },
      }),
    ],
    [router],
  );
  const chat = useAgentChat({
    endpoint: "/v1/agent",
    fetch: assistantFetch,
    clientTools,
  });
  const refreshPage = useCallback(() => {
    refreshApiQueries();
    router.refresh();
  }, [router]);
  const approvedCalls = useRef(new Set<string>());
  useEffect(() => {
    for (const item of chat.state.items) {
      if (
        item.type !== "tool_call" ||
        item.status === "pending" ||
        !approvedCalls.current.delete(item.id)
      )
        continue;
      if (item.status === "succeeded") refreshPage();
    }
  }, [chat.state.items, refreshPage]);
  const displayedItems = useMemo(
    () =>
      chat.state.items.map((item) => {
        if (
          item.type !== "tool_call" ||
          !item.input ||
          typeof item.input !== "object" ||
          Array.isArray(item.input)
        )
          return item;
        const input = Object.fromEntries(
          Object.entries(item.input).flatMap(([key, value]) => {
            if (["idempotencyKey", "orgId"].includes(key)) return [];
            if (key === "workspaceId") return [["workspace", workspaceName]];
            if (typeof value === "string" && entityNames?.[value])
              return [[key.replace(/Id$/, ""), entityNames[value]]];
            return [[key, value]];
          }),
        );
        return { ...item, input, name: item.name.replace(/^towbar_/, "") };
      }),
    [chat.state.items, workspaceName, entityNames],
  );
  const [conversations, setConversations] = useState<
    AgentConversationSummary[]
  >([]);
  const { listConversations, stop } = chat;
  const refresh = useCallback(async () => {
    const list = await listConversations();
    setConversations(
      list.map((item) => ({
        id: item.id,
        title: item.title,
        time: new Date(item.updatedAt).toLocaleDateString(),
        dateTime: item.updatedAt,
      })),
    );
  }, [listConversations]);
  useEffect(() => {
    if (chat.state.status === "idle")
      void refresh().catch(() =>
        toast.danger("Conversation history could not be loaded. Try again."),
      );
  }, [chat.state.status, refresh]);
  useEffect(() => () => stop(), [stop]);
  return (
    <AgentChat
      productName="Towbar"
      items={displayedItems}
      pending={chat.state.pending}
      status={chat.state.status}
      error={chat.state.error}
      thinking={chat.state.thinking}
      onSend={(text) => {
        void chat.send(text);
      }}
      onDecide={(id, approved) => {
        if (approved) approvedCalls.current.add(id);
        chat.decide(id, approved);
      }}
      onStop={chat.stop}
      onNewConversation={() => {
        approvedCalls.current.clear();
        chat.reset();
      }}
      onClose={onClose}
      suggestions={[
        "Which deployments need attention?",
        "Show the health of my servers.",
        "Help me inspect a failed deployment.",
      ]}
      emptyDescription="Inspect your infrastructure or prepare an action for approval."
      conversations={conversations}
      activeConversationId={chat.state.conversationId}
      onSelectConversation={(id) => {
        void chat.load(id);
      }}
      onDeleteConversation={async (id) => {
        await chat.deleteConversation(id);
        await refresh();
      }}
    />
  );
}
