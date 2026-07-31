export interface UiApplication {
  start(): Promise<void>;
}
/** UI starts the HTTP surface plus packaged assets; it has no local data store. */
export const ui = (application: UiApplication) => application.start();
