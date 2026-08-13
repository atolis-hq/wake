export interface ApiApplication {
  start(): Promise<void>;
}

export const api = (application: ApiApplication) => application.start();
