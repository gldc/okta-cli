export class ExitError extends Error {}

export class CommunicationError extends Error {}

export interface OktaErrorBody {
  errorCode?: string;
  errorSummary?: string;
  errorLink?: string;
  errorId?: string;
  errorCauses?: { errorSummary: string }[];
}

export class OktaApiError extends Error {
  constructor(public readonly body: OktaErrorBody, public readonly status: number) {
    super(body.errorSummary ?? `HTTP ${status}`);
  }
  get errorCode(): string {
    return this.body.errorCode ?? "UNKNOWN";
  }
  get errorCauses(): { errorSummary: string }[] {
    return this.body.errorCauses ?? [];
  }
}
