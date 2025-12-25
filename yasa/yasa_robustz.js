/*!
 * YASA JS port (sleep staging)
 * Based on concepts/feature definitions from YASA (BSD-3-Clause). See ./LICENSE.
 */

(function () {
  const ns = (window.__yasa_internal = window.__yasa_internal || {});

  function median(arr) {
    const a = arr.slice().sort((p, q) => p - q);
    const n = a.length;
    if (!n) return NaN;
    const mid = (n / 2) | 0;
    return n % 2 ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
  }

  function percentile(arr, p) {
    const a = arr.slice().sort((p, q) => p - q);
    const n = a.length;
    if (!n) return NaN;
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return a[lo];
    const t = idx - lo;
    return a[lo] * (1 - t) + a[hi] * t;
  }

  // Robust z-score using median and IQR (placeholder — confirm exact YASA formula).
  ns.robustZ = function robustZ(x) {
    const med = median(x);
    const q25 = percentile(x, 25);
    const q75 = percentile(x, 75);
    const iqr = q75 - q25;
    const denom = iqr === 0 ? 1 : iqr;
    return x.map((v) => (v - med) / denom);
  };
})();
