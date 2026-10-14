export const logCollectorVersion = "0.162.0";
export const logCollectorImage =
  "otel/opentelemetry-collector-contrib:0.162.0@sha256:39923a8e431bd1f57be82411999d389fcfe40857492e4365456d97a4c1f74be6";

export function buildLogCollectorConfiguration(input: {
  endpoint: string;
  token: string;
  serverId: string;
  sources: { containerId: string; startAt: "beginning" | "end" }[];
}) {
  const receivers: Record<string, unknown> = {};
  for (const source of input.sources) {
    if (!/^[a-f0-9]{64}$/u.test(source.containerId))
      throw new Error("Invalid Docker container identity");
    receivers[`filelog/${source.containerId}`] = {
      include: [
        `/var/lib/docker/containers/${source.containerId}/${source.containerId}-json.log`,
      ],
      start_at: source.startAt,
      include_file_record_offset: true,
      max_log_size: "512KiB",
      max_log_size_behavior: "truncate",
      storage: "file_storage/checkpoints",
      retry_on_failure: { enabled: true, max_elapsed_time: "0s" },
      resource: { "container.id": source.containerId },
      operators: [
        {
          type: "json_parser",
          timestamp: {
            parse_from: "attributes.time",
            layout_type: "gotime",
            layout: "2006-01-02T15:04:05.999999999Z07:00",
          },
        },
        { type: "move", from: "attributes.log", to: "body" },
        {
          type: "move",
          from: "attributes.stream",
          to: 'attributes["log.iostream"]',
        },
        { type: "remove", field: "attributes.time" },
      ],
    };
  }
  if (!input.sources.length)
    receivers["filelog/idle"] = {
      include: ["/var/lib/docker/containers/__towbar_no_sources__.log"],
      storage: "file_storage/checkpoints",
    };
  return {
    extensions: {
      "file_storage/checkpoints": {
        directory: "/var/lib/towbar-logs/checkpoints",
        create_directory: true,
      },
      "file_storage/queue": {
        directory: "/var/lib/towbar-logs/queue",
        create_directory: true,
        compaction: {
          on_start: true,
          on_rebound: true,
          directory: "/var/lib/towbar-logs/queue/compaction",
        },
      },
      health_check: { endpoint: "0.0.0.0:13133" },
    },
    receivers,
    processors: {
      memory_limiter: {
        check_interval: "1s",
        limit_mib: 192,
        spike_limit_mib: 32,
      },
      "transform/redact": {
        error_mode: "propagate",
        log_statements: [
          {
            context: "log",
            statements: [
              `replace_pattern(body, ${JSON.stringify(String.raw`(?i)("(?:password|secret|token|authorization|cookie)"\s*:\s*")[^"]*`)}, "$1[REDACTED]") where IsString(body)`,
              `replace_pattern(body, ${JSON.stringify(String.raw`(?i)(Bearer\s+)[a-zA-Z0-9._~+/-]+=*`)}, "$1[REDACTED]") where IsString(body)`,
            ],
          },
        ],
      },
    },
    exporters: {
      "otlphttp/towbar": {
        endpoint: new URL(input.endpoint).origin,
        logs_endpoint: input.endpoint,
        encoding: "json",
        compression: "none",
        timeout: "15s",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "X-Towbar-Server": input.serverId,
        },
        retry_on_failure: {
          enabled: true,
          initial_interval: "1s",
          max_interval: "30s",
          max_elapsed_time: "0s",
        },
        sending_queue: {
          enabled: true,
          storage: "file_storage/queue",
          sizer: "bytes",
          queue_size: 536870912,
          block_on_overflow: true,
          num_consumers: 2,
          batch: {
            sizer: "bytes",
            min_size: 32768,
            max_size: 131072,
            flush_timeout: "1s",
          },
        },
      },
    },
    service: {
      extensions: [
        "file_storage/checkpoints",
        "file_storage/queue",
        "health_check",
      ],
      telemetry: { logs: { level: "warn" } },
      pipelines: {
        logs: {
          receivers: Object.keys(receivers),
          processors: ["memory_limiter", "transform/redact"],
          exporters: ["otlphttp/towbar"],
        },
      },
    },
  };
}
