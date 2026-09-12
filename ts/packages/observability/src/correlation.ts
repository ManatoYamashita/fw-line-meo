import type { Sink } from './sink.js';

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CLOUD_TRACE_CONTEXT_RE = /^([0-9a-f]{32})\/[0-9a-f]+(?:;o=[01])?$/i;
const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const TRACE_PREFIX = 'projects/';

export function projectIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT ?? env.GCP_PROJECT;
}

export function correlationIdFromTraceId(traceId: string | undefined, projectId: string | undefined): string | undefined {
  if (!projectId || !traceId || !TRACE_ID_RE.test(traceId)) return undefined;
  return `${TRACE_PREFIX}${projectId}/traces/${traceId.toLowerCase()}`;
}

export function traceIdFromHeaders(headers: Headers): string | undefined {
  const cloudTrace = headers.get('x-cloud-trace-context');
  const cloudMatch = cloudTrace ? CLOUD_TRACE_CONTEXT_RE.exec(cloudTrace.trim()) : null;
  if (cloudMatch) return cloudMatch[1]!.toLowerCase();

  const traceparent = headers.get('traceparent');
  const parentMatch = traceparent ? TRACEPARENT_RE.exec(traceparent.trim()) : null;
  return parentMatch?.[1]?.toLowerCase();
}

export function correlationIdFromHeaders(
  headers: Headers,
  projectId = projectIdFromEnv(),
): string | undefined {
  return correlationIdFromTraceId(traceIdFromHeaders(headers), projectId);
}

export function executionCorrelationId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const projectId = projectIdFromEnv(env);
  const executionId = env.CLOUD_RUN_EXECUTION;
  if (!projectId || !executionId || !EXECUTION_ID_RE.test(executionId)) return undefined;
  return `${TRACE_PREFIX}${projectId}/traces/${executionId}`;
}

export function supportCodeFromCorrelationId(correlationId: string | undefined): string | undefined {
  const match = correlationId?.match(/\/traces\/([A-Za-z0-9_-]{8,})$/);
  return match?.[1]?.slice(0, 8).toLowerCase();
}

export function withCorrelation(sink: Sink, correlationId: string | undefined): Sink {
  return (level, event, fields) => {
    if (!correlationId) return sink(level, event, fields);
    sink(level, event, { ...fields, correlationId });
  };
}
