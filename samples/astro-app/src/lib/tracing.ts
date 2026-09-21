import { createRequire } from 'node:module';

// `__require` mirrors rolldown's helper for an inlined CJS require: NFT can't follow it, so
// the exporter is invisible to the trace and pruned unless bonsai recovers it, yet
// resolves fine at runtime.
const __require = createRequire(import.meta.url);

export function createTraceExporter(): unknown {
  const { OTLPTraceExporter } = __require('@opentelemetry/exporter-trace-otlp-proto');

  return new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT });
}
