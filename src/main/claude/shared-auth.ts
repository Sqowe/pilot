import { ModelRuntime } from '@earendil-works/pi-coding-agent';

// Singleton — safe because Electron main process is single-threaded.
// ModelRuntime.create() is async (0.80.8 replaced the synchronous AuthStorage),
// so the *promise* is memoized rather than the value: concurrent callers racing
// before the first resolves must not each build a runtime. Runtime API keys live
// on the instance, so the ref-counted release in agent-runner is only correct
// while every session shares this one runtime.
let sharedModelRuntime: Promise<ModelRuntime> | null = null;

export function getSharedModelRuntime(): Promise<ModelRuntime> {
  if (!sharedModelRuntime) {
    sharedModelRuntime = ModelRuntime.create({
      // Parity with the pre-0.80.8 `ModelRegistry.inMemory()`: never read pi's
      // ~/.pi/models.json. Open Cowork owns its provider config, and inheriting
      // the pi CLI's would bleed foreign models in. `null` also keeps the model
      // store in memory instead of writing a models-store.json alongside it.
      modelsPath: null,
      // 0.80.8 refreshes the pi.dev catalog inside create() and defaults this on,
      // which would add up to 15s to the first run and reach the network. Model
      // resolution goes through our own native catalog, so it buys nothing here.
      allowModelNetwork: false,
    }).catch((err: unknown) => {
      sharedModelRuntime = null; // let the next caller retry instead of caching the rejection
      throw err;
    });
  }
  return sharedModelRuntime;
}

export { ModelRuntime };
