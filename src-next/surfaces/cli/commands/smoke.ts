export interface SmokeRunner {
  run(): Promise<{ readonly ok: boolean }>;
}

export const runSmoke = (runner: SmokeRunner) => runner.run();
