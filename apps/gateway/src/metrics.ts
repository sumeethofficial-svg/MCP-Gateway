import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/** Prometheus metrics, served on /metrics (cluster-internal only; the Ingress does not route it). */
export class Metrics {
  readonly registry = new Registry();

  readonly toolCalls = new Counter({
    name: "gateway_tool_calls_total",
    help: "Tool calls handled by the gateway",
    labelNames: ["server", "tool", "outcome", "via"],
    registers: [this.registry],
  });

  readonly toolDuration = new Histogram({
    name: "gateway_tool_call_duration_seconds",
    help: "End-to-end tool call latency as seen by the caller",
    labelNames: ["server", "outcome"],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly upstreamUp = new Gauge({
    name: "gateway_upstream_up",
    help: "1 if the last health check of the upstream succeeded, else 0",
    labelNames: ["server"],
    registers: [this.registry],
  });

  readonly authFailures = new Counter({
    name: "gateway_auth_failures_total",
    help: "Rejected authentication attempts",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  readonly chatRuns = new Counter({
    name: "gateway_chat_runs_total",
    help: "Chat agent runs",
    labelNames: ["outcome"],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
