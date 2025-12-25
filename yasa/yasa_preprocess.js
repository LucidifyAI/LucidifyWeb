/*!
 * YASA JS port (sleep staging)
 * Based on concepts/feature definitions from YASA (BSD-3-Clause). See ./LICENSE.
 */

(function () {
  const ns = (window.__yasa_internal = window.__yasa_internal || {});

  // TODO: implement downsampling to 100 Hz with anti-aliasing (polyphase or FIR).
  ns.downsampleTo100Hz = function downsampleTo100Hz(samples, fs) {
    if (fs === 100) return { samples, fs: 100 };
    // Placeholder: naive decimation if integer ratio; otherwise throw.
    const ratio = fs / 100;
    const isInt = Math.abs(ratio - Math.round(ratio)) < 1e-9;
    if (!isInt) {
      throw new Error(
        `YASA preprocess: non-integer downsample ratio fs=${fs} -> 100 not implemented`
      );
    }
    const r = Math.round(ratio);
    const out = new Array(Math.floor(samples.length / r));
    for (let i = 0, j = 0; j < out.length; i += r, j++) out[j] = samples[i];
    return { samples: out, fs: 100 };
  };

  // Units: ensure microvolts (µV). Your EDF loader likely already yields µV (physDim).
  // This is a placeholder hook in case some channels come in volts.
  ns.ensureMicrovolts = function ensureMicrovolts(samples, physDim) {
    if (!physDim) return samples;
    const dim = String(physDim).toLowerCase();
    if (dim.includes("uv") || dim.includes("µv")) return samples;
    if (dim === "v" || dim.includes("volt")) {
      return samples.map((v) => v * 1e6);
    }
    return samples;
  };
})();
