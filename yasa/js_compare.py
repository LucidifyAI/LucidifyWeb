import json
import re
import time
from pathlib import Path

import numpy as np
import mne
from scipy.signal import welch, fftconvolve

# -----------------------------
# CONFIG (edit these)
# -----------------------------
EDF_PATH = r"C:\Users\ryan\Downloads\Patientcode_Firstname_1_2_26_18_6_57_to_2_2_26_2_8_44.edf"
EEG_CH = "Fp1"

JS_EPOCH_JSON = "js_epoch0_signal.json"     # must contain {"fs": 100, "signal": [...]}
YASA_DSP_JS_PATH = "yasa_dsp.js"            # taps live here

EPOCH_SEC = 30
WELCH_NPERSEG = 500                         # 5 sec at 100 Hz
WELCH_WINDOW = "hamming"

# -----------------------------
# JS-matching FIR helpers
# -----------------------------
def _js_fir_convolve_same(x: np.ndarray, taps: np.ndarray) -> np.ndarray:
    """
    Matches yasa_dsp.js __firConvolveSame:
      y[i] = sum_{k=0..m-1} x[i + k - half] * taps[k], with zero outside bounds.
    This equals standard convolution with taps reversed, mode='same'.
    """
    # fftconvolve does standard convolution; to match JS formula we reverse taps.
    return fftconvolve(x, taps[::-1], mode="same")

def _js_filtfilt_fir_reflect_same(x: np.ndarray, taps: np.ndarray) -> np.ndarray:
    """
    Matches yasa_dsp.js __filtfiltFIR_reflectSame:
      pad = min(n-1, 3*(m-1))
      xpad = [reflect-left] + x + [reflect-right]
      y = fir_same(xpad, taps)
      y = reverse(y); y = fir_same(y, taps); y = reverse(y)
      return y[pad:pad+n]
    """
    x = np.asarray(x, dtype=np.float64)
    taps = np.asarray(taps, dtype=np.float64)

    n = x.size
    m = taps.size
    if n == 0:
        return x.copy()
    if m < 2:
        return x.copy()

    pad = min(n - 1, 3 * (m - 1))
    if pad <= 0:
        # Degenerate case
        y = _js_fir_convolve_same(x, taps)
        y = _js_fir_convolve_same(y[::-1], taps)[::-1]
        return y

    xpad = np.empty(n + 2 * pad, dtype=np.float64)

    # left reflect: x[pad], x[pad-1], ..., x[1]
    # (this matches the JS loop xpad[i] = x[pad - i])
    for i in range(pad):
        xpad[i] = x[pad - i]

    xpad[pad:pad + n] = x

    # right reflect: x[n-2], x[n-3], ..., x[n-1-pad]
    # (this matches xpad[pad+n+i] = x[n-2-i])
    for i in range(pad):
        xpad[pad + n + i] = x[n - 2 - i]

    y = _js_fir_convolve_same(xpad, taps)
    y = _js_fir_convolve_same(y[::-1], taps)[::-1]

    return y[pad:pad + n].copy()

# -----------------------------
# Robust taps extraction
# -----------------------------
def load_mne_fir_taps_from_js(js_path: str) -> np.ndarray:
    """
    Extract FIR taps array from yasa_dsp.js.

    Supports either:
      const __MNE_FIR_0P4_30_FS100__ = { ... taps: [ ... ] ... };
    or:
      const MNE_FIR_0P4_30_FS100 = { ... taps: [ ... ] ... };

    Critically: only parses numbers *inside the taps [ ... ]* block.
    """
    with open(js_path, "r", encoding="utf-8") as f:
        txt = f.read()

    # Find whichever object name exists
    obj_names = ["__MNE_FIR_0P4_30_FS100__", "MNE_FIR_0P4_30_FS100"]
    obj_body = None
    for name in obj_names:
        m_obj = re.search(
            rf"const\s+{re.escape(name)}\s*=\s*\{{([\s\S]*?)\}}\s*;",
            txt
        )
        if m_obj:
            obj_body = m_obj.group(1)
            break
    if obj_body is None:
        raise RuntimeError(f"Could not locate FIR object in {js_path} (tried {obj_names})")

    m_taps = re.search(r"\btaps\s*:\s*\[([\s\S]*?)\]", obj_body)
    if not m_taps:
        raise RuntimeError(f"Could not find taps: [ ... ] inside FIR object in {js_path}")

    taps_body = m_taps.group(1)
    nums = re.findall(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?", taps_body)
    taps = np.array([float(x) for x in nums], dtype=np.float64)

    if taps.size != 825:
        raise RuntimeError(f"Expected 825 taps, got {taps.size}. First6={taps[:6].tolist()}")

    return taps


def sanity_check_taps(taps: np.ndarray) -> None:
    """
    Reject obviously broken tap vectors early.
    """
    if not np.isfinite(taps).all():
        raise RuntimeError("Taps contain NaN/Inf")

    # MNE FIR taps are tiny (~1e-3-ish max). A '825' here means corruption.
    max_abs = float(np.max(np.abs(taps)))
    if max_abs > 1.0:
        raise RuntimeError(f"Taps look corrupted (max|tap|={max_abs}). Did we accidentally include num_taps?")

    # Bandpass taps should have near-zero DC gain => sum near ~0 (not exactly 0).
    s = float(np.sum(taps))
    if abs(s) > 0.5:
        raise RuntimeError(f"Taps sum is suspicious (sum={s}). Likely wrong array extracted.")

# -----------------------------
# Utilities
# -----------------------------
def compare_signals(a: np.ndarray, b: np.ndarray, label: str):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = min(a.size, b.size)
    a = a[:n]
    b = b[:n]

    corr = float(np.corrcoef(a, b)[0, 1]) if n > 1 else float("nan")
    rmse = float(np.sqrt(np.mean((a - b) ** 2))) if n else float("nan")
    mad = float(np.max(np.abs(a - b))) if n else float("nan")

    print(f"\n=== Compare: {label} ===")
    print("len a/b", a.size, b.size)
    print("var a/b", float(np.var(a)), float(np.var(b)))
    print("mean a/b", float(np.mean(a)), float(np.mean(b)))
    print("signal corr:", corr)
    print("signal rmse:", rmse)
    print("signal max abs diff:", mad)
    print("first16 a:", a[:16])
    print("first16 b:", b[:16])

def welch_psd(x: np.ndarray, fs: float):
    freqs, psd = welch(
        x,
        fs=fs,
        window=WELCH_WINDOW,
        nperseg=WELCH_NPERSEG,
        noverlap=WELCH_NPERSEG // 2,
        detrend="constant",
        return_onesided=True,
        scaling="density",
        average="median",
    )
    dx = freqs[1] - freqs[0]
    p_int = float(np.sum(psd) * dx)
    return freqs, psd, dx, p_int
    
def best_lag(a: np.ndarray, b: np.ndarray, max_lag: int = 400) -> int:
    """
    Find lag in samples (a shifted relative to b) that maximizes correlation.
    Searches [-max_lag, +max_lag].
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = min(len(a), len(b))
    a = a[:n] - np.mean(a[:n])
    b = b[:n] - np.mean(b[:n])

    best = 0
    best_r = -1.0
    for lag in range(-max_lag, max_lag + 1):
        if lag < 0:
            aa = a[-lag:]
            bb = b[:len(aa)]
        elif lag > 0:
            bb = b[lag:]
            aa = a[:len(bb)]
        else:
            aa = a
            bb = b
        if len(aa) < 200:
            continue
        r = float(np.corrcoef(aa, bb)[0, 1])
        if r > best_r:
            best_r = r
            best = lag
    print(f"best lag = {best} samples, corr={best_r}")
    return best
    
def best_lag_corr(a: np.ndarray, b: np.ndarray, max_lag: int = 200):
    """
    Find lag (in samples) maximizing correlation between a and b.
    Positive lag means 'a' should be shifted right (a[lag:] vs b[:-lag]).
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = min(len(a), len(b))
    a = a[:n] - np.mean(a[:n])
    b = b[:n] - np.mean(b[:n])

    best_lag = 0
    best_corr = -1e9
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            aa = a[lag:]
            bb = b[:len(aa)]
        else:
            bb = b[-lag:]
            aa = a[:len(bb)]
        if len(aa) < 100:
            continue
        c = np.corrcoef(aa, bb)[0, 1]
        if c > best_corr:
            best_corr = float(c)
            best_lag = lag
    return best_lag, best_corr
    
def best_lag_by_corr(a: np.ndarray, b: np.ndarray, max_lag: int = 200):
    """
    Find lag (in samples) to apply to 'a' so that a_shifted aligns best with b.
    lag > 0 means shift a forward: a_shifted = a[lag:lag+n]
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = min(a.size, b.size)

    best = (None, -1.0)
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            aa = a[lag:lag+n]
            bb = b[:aa.size]
        else:
            aa = a[:n+lag]
            bb = b[-lag:-lag+aa.size]
        if aa.size < 10:
            continue
        c = float(np.corrcoef(aa, bb)[0, 1])
        if c > best[1]:
            best = (lag, c)
    return best  # (lag, corr)
# -----------------------------
# Main
# -----------------------------
def main():
    t0 = time.time()

    # Load JS epoch
    with open(JS_EPOCH_JSON, "r") as f:
        j = json.load(f)
    epoch_js = np.array(j["signal"], dtype=np.float64)
    fs_js = float(j["fs"])
    print(f"Loaded JS epoch: len={epoch_js.size} fs={fs_js}")

    # Read EDF
    print("Reading EDF (this can take a moment)...")
    t = time.time()
    raw = mne.io.read_raw_edf(EDF_PATH, preload=True, verbose="ERROR").pick([EEG_CH])
    fs_in = float(raw.info["sfreq"])
    x_v = raw.get_data()[0]      # volts
    x_uv = x_v * 1e6             # microvolts
    print(f"EDF loaded: fs_in={fs_in}, samples={x_uv.size}, elapsed={time.time()-t:.2f}s")

    # Downsample 500 -> 100 by integer /5 (match the JS diagnostic path)
    if abs(fs_in / 5.0 - 100.0) < 1e-6:
        print("Downsampling to 100.0 Hz...")
        t = time.time()
        x_ds = x_uv[::5].copy()
        fs = fs_in / 5.0
        print(f"Downsample done: samples={x_ds.size}, fs={fs}, elapsed={time.time()-t:.2f}s")
    else:
        raise RuntimeError(f"Expected fs_in=500 for /5 downsample, got fs_in={fs_in}")

    n_epoch = int(fs_js * EPOCH_SEC)
    if n_epoch != epoch_js.size:
        print(f"Warning: JS epoch length {epoch_js.size} != expected {n_epoch}; using min.")
        n_epoch = min(n_epoch, epoch_js.size)

    epoch_resample_only = x_ds[:n_epoch]
    compare_signals(epoch_resample_only, epoch_js[:n_epoch], "resample-only (PY) vs JS epoch")

    # Load taps and run JS-style filtfilt
    taps = load_mne_fir_taps_from_js(YASA_DSP_JS_PATH)
    sanity_check_taps(taps)
    print("Loaded taps:", len(taps), "first5:", taps[:5])

    print("Bandpass 0.4–30 using JS taps via filtfilt...")
    t = time.time()
    x_bp = _js_filtfilt_fir_reflect_same(x_ds, taps)
    print(f"Filter done: samples={x_bp.size}, elapsed={time.time()-t:.2f}s")

    epoch_bp = x_bp[:n_epoch]
    compare_signals(epoch_bp, epoch_js[:n_epoch], "resample+FIR bandpass (PY) vs JS epoch")
    lag = best_lag(epoch_bp, epoch_js[:n_epoch], max_lag=400)
    lag, c = best_lag_corr(epoch_bp, epoch_js[:n_epoch], max_lag=200)
    print(f"best lag = {lag} samples, corr={c}")
    # --- Find and APPLY lag on the bandpassed epoch ---
    lag, cbest = best_lag_by_corr(epoch_bp, epoch_js[:n_epoch], max_lag=200)
    print(f"best lag (apply to PY) = {lag} samples, corr={cbest}")

    # Build aligned pair (same length)
    if lag >= 0:
        epoch_bp_aligned = x_bp[lag:lag + n_epoch].copy()
        epoch_js_aligned = epoch_js[:epoch_bp_aligned.size].copy()
    else:
        epoch_bp_aligned = x_bp[:n_epoch + lag].copy()         # lag negative shortens
        epoch_js_aligned = epoch_js[-lag:-lag + epoch_bp_aligned.size].copy()

    compare_signals(epoch_bp_aligned, epoch_js_aligned, "bandpass (PY lag-aligned) vs JS epoch")
    # Re-slice python epoch using lag so we compare the same 30s chunk
    start = max(0, lag)
    end = start + n_epoch
    if end <= len(x_bp):
        epoch_bp_aligned = x_bp[start:end]
    else:
        epoch_bp_aligned = epoch_bp  # fallback, shouldn't happen

    compare_signals(epoch_bp_aligned, epoch_js[:n_epoch], "bandpass (PY aligned) vs JS epoch")

    # And do Welch on epoch_bp_aligned (not epoch_bp)
    freqs_bp, psd_bp, dx_bp, pint_bp = welch_psd(epoch_bp_aligned, fs_js)
    # PSD comparisons
    print("\n--- PSD stage: resample-only ---")
    freqs_py, psd_py, dx_py, pint_py = welch_psd(epoch_resample_only, fs_js)
    freqs_js, psd_js, dx_js, pint_js = welch_psd(epoch_js[:n_epoch], fs_js)
    print("df", dx_py)
    print("freqs[:10]", freqs_py[:10])
    print("PSD_int py", pint_py)
    print("PSD_int js", pint_js)
    print("ratio py", float(pint_py / (np.var(epoch_resample_only) or 1.0)))
    print("ratio js", float(pint_js / (np.var(epoch_js[:n_epoch]) or 1.0)))
    print("psd first10 py:", psd_py[:10])
    print("psd first10 js:", psd_js[:10])
    print("psd max abs diff:", float(np.max(np.abs(psd_py - psd_js))))
    
    print("\n--- PSD stage: resample+bandpass (LAG-ALIGNED) ---")
    freqs_bp, psd_bp, dx_bp, pint_bp = welch_psd(epoch_bp_aligned, fs_js)
    freqs_js2, psd_js2, dx_js2, pint_js2 = welch_psd(epoch_js_aligned, fs_js)

    print("df", dx_bp)
    print("PSD_int py", pint_bp)
    print("PSD_int js", pint_js2)
    print("ratio py", float(pint_bp / (np.var(epoch_bp_aligned) or 1.0)))
    print("ratio js", float(pint_js2 / (np.var(epoch_js_aligned) or 1.0)))
    print("psd max abs diff:", float(np.max(np.abs(psd_bp - psd_js2))))
    with open("py_vs_js_psd_resample_only.json", "w") as f:
        json.dump(
            {"fs": fs_js, "freqs": freqs_py.tolist(), "psd_py": psd_py.tolist(), "psd_js": psd_js.tolist()},
            f
        )
    print("Wrote py_vs_js_psd_resample_only.json")

    print("\n--- PSD stage: resample+bandpass ---")
    freqs_bp, psd_bp, dx_bp, pint_bp = welch_psd(epoch_bp, fs_js)
    print("df", dx_bp)
    print("freqs[:10]", freqs_bp[:10])
    print("PSD_int py", pint_bp)
    print("PSD_int js", pint_js)
    print("ratio py", float(pint_bp / (np.var(epoch_bp) or 1.0)))
    print("ratio js", float(pint_js / (np.var(epoch_js[:n_epoch]) or 1.0)))
    print("psd first10 py:", psd_bp[:10])
    print("psd first10 js:", psd_js[:10])
    print("psd max abs diff:", float(np.max(np.abs(psd_bp - psd_js))))
    with open("py_vs_js_psd_resample_bandpass.json", "w") as f:
        json.dump(
            {"fs": fs_js, "freqs": freqs_bp.tolist(), "psd_py": psd_bp.tolist(), "psd_js": psd_js.tolist()},
            f
        )
    print("Wrote py_vs_js_psd_resample_bandpass.json")

    print(f"\nTOTAL elapsed: {time.time()-t0:.2f}s")


if __name__ == "__main__":
    main()