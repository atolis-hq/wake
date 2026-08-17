import type {
  ConfigurationResponse,
  HealthResponse,
  MetricsResponse,
  WakeProblemDetails,
} from '../../../api/contracts/index.js';
import {
  array,
  boolean,
  child,
  invalid,
  json,
  number,
  object,
  optionalStringProperty,
  string,
  type Decoder,
} from './decoder-primitives.js';

export const decodeMetrics: Decoder<MetricsResponse> = (value, path = '') => {
  const record = object(value, path);
  const values = object(record.values, child(path, 'values'));
  return {
    collectedAt: string(record.collectedAt, child(path, 'collectedAt')),
    window: decodeAnalyticsWindow(record.window, child(path, 'window')),
    values: Object.fromEntries(
      Object.entries(values).map(([key, item]) => [
        key,
        number(item, child(path, `values.${key}`)),
      ]),
    ),
  };
};

function decodeAnalyticsWindow(value: unknown, path: string) {
  const record = object(value, path);
  return {
    days: number(record.days, child(path, 'days')),
    from: string(record.from, child(path, 'from')),
    to: string(record.to, child(path, 'to')),
  };
}

export const decodeHealth: Decoder<HealthResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    status: healthStatus(record.status, child(path, 'status')),
    version: string(record.version, child(path, 'version')),
    checkedAt: string(record.checkedAt, child(path, 'checkedAt')),
    ...(record.checks === undefined
      ? {}
      : {
          checks: array(record.checks, child(path, 'checks'), (item, itemPath = '') => {
            const check = object(item, itemPath);
            return {
              name: string(check.name, child(itemPath, 'name')),
              status: healthStatus(check.status, child(itemPath, 'status')),
              ...optionalStringProperty(check, 'detail', itemPath),
            };
          }),
        }),
    ...(record.adapters === undefined
      ? {}
      : {
          adapters: array(record.adapters, child(path, 'adapters'), (item, itemPath = '') => {
            const check = object(item, itemPath);
            return {
              adapter: string(check.adapter, child(itemPath, 'adapterId')),
              provider: string(check.provider, child(itemPath, 'provider')),
              scope: string(check.scope, child(itemPath, 'scope')),
              channel: string(check.channel, child(itemPath, 'channel')),
              status: healthStatus(check.status, child(itemPath, 'status')),
              successCount: number(check.successCount, child(itemPath, 'successCount')),
              failureCount: number(check.failureCount, child(itemPath, 'failureCount')),
              ...optionalStringProperty(check, 'detail', itemPath),
            };
          }),
        }),
  };
};

export const decodeConfiguration: Decoder<ConfigurationResponse> = (value, path = '') => {
  const record = object(value, path);
  const configurationPath = child(path, 'configuration');
  return {
    configuration: object(json(record.configuration, configurationPath), configurationPath),
  };
};

export function decodeProblem(value: unknown, status: number): WakeProblemDetails {
  try {
    const record = object(value, 'problem');
    return {
      type: string(record.type, 'problem.type'),
      title: string(record.title, 'problem.title'),
      status: number(record.status, 'problem.status'),
      ...optionalStringProperty(record, 'detail', 'problem'),
      ...optionalStringProperty(record, 'instance', 'problem'),
      ...optionalStringProperty(record, 'code', 'problem'),
      ...(record.retryable === undefined
        ? {}
        : { retryable: boolean(record.retryable, 'problem.retryable') }),
      ...(record.current === undefined ? {} : { current: json(record.current, 'problem.current') }),
      ...(record.violations === undefined
        ? {}
        : {
            violations: array(record.violations, 'problem.violations', (item, itemPath = '') => {
              const violation = object(item, itemPath);
              return {
                path: string(violation.path, child(itemPath, 'path')),
                message: string(violation.message, child(itemPath, 'message')),
              };
            }),
          }),
    };
  } catch {
    return { type: 'about:blank', title: 'Request failed', status };
  }
}

function healthStatus(value: unknown, path: string): 'ok' | 'degraded' {
  const decoded = string(value, path);
  if (decoded !== 'ok' && decoded !== 'degraded') invalid(path);
  return decoded;
}
