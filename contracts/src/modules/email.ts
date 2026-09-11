export type DeliveryStatus = 'queued' | 'sent' | 'failed';
export type EmailVariable = string | number | boolean;

export interface EmailApi {
  send: (input: {
    templateKey: string;
    to: string;
    variables?: Record<string, EmailVariable>;
    dedupeKey: string;
  }) => Promise<{
    ok: true;
    deliveryId: string;
    deduplicated: boolean;
    status: DeliveryStatus;
  }>;
}
