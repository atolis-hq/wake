import { z } from 'zod';
import { defineClosedVocabulary } from '../../../kernel/index.js';

export const WebhookOperation = defineClosedVocabulary({
  Configure: 'configure webhook',
  Read: 'read managed webhook',
  Create: 'create webhook',
  Update: 'update managed webhook',
  State: 'persist webhook state',
} as const);

export const webhookDiagnosisSchema = z.object({
  operation: z.enum(WebhookOperation),
  status: z.number().int().min(100).max(599).optional(),
});

export type WebhookDiagnosis = z.infer<typeof webhookDiagnosisSchema>;

export class WebhookProvisioningFailure extends Error {
  constructor(readonly diagnosis: WebhookDiagnosis) {
    super('Webhook provisioning failed');
  }
}

export function renderWebhookDiagnosis(scope: string, diagnosis: WebhookDiagnosis): string {
  const { operation, status } = diagnosis;
  const reason =
    operation === WebhookOperation.Configure
      ? 'surfaces.web.publicUrl is not configured'
      : status === 403 || status === 404
        ? `HTTP ${status}; the token may lack repository Webhooks read/write permission; verify repository access and token permissions`
        : status === undefined
          ? 'request or local webhook state operation failed; check connectivity and provider state access'
          : `HTTP ${status}; check GitHub availability and webhook configuration`;
  return `GitHub ${scope}: ${operation} failed: ${reason}. Intake continues by polling.`;
}

export async function webhookOperation<T>(
  operation: WebhookDiagnosis['operation'],
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof error.status === 'number' &&
      Number.isInteger(error.status) &&
      error.status >= 100 &&
      error.status <= 599
        ? error.status
        : undefined;
    throw new WebhookProvisioningFailure({
      operation,
      ...(status === undefined ? {} : { status }),
    });
  }
}
