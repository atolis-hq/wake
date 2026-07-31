export interface StopApplication {
  stop(): Promise<void>;
}
export const stop = (application: StopApplication) => application.stop();
