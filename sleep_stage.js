// sleep_stage.js (classic script)
(function () {
  "use strict";

  // Lazy-load modules on first use
  let _modsPromise = null;
  function loadMods() {
    if (!_modsPromise) {
      _modsPromise = Promise.all([
        import("./sleep_stage_model.js"),
        import("./sleep_stage_features.js"),
        import("./hypnogram_pipeline.js"),
      ]);
    }
    return _modsPromise;
  }

  // Expose a small global API
  window.LucidifySleepStage = {
    // returns Promise<{stages: string[], probs?: number[][], meta?: object}>
    async run(recording, opts = {}) {
      const [modelMod, featMod, pipeMod] = await loadMods();

      // Expect hypnogram_pipeline.js to orchestrate feature extraction + prediction.
      // If your hypnogram_pipeline exports different names, adjust here.
      const runHypnogram =
        pipeMod.runHypnogram || pipeMod.run || pipeMod.default;

      if (!runHypnogram) {
        throw new Error("hypnogram_pipeline.js must export runHypnogram (or run/default).");
      }

      return await runHypnogram({
        recording,
        ...opts,
      });
    },
  };
})();
