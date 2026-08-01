import type { StatusResponse } from '../contracts/status.js';

export function presentStatus(status: StatusResponse): StatusResponse {
  return status;
}
