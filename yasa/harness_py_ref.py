# harness_py_ref.py
# Usage:
#   python harness_py_ref.py
#
# Produces:
#   yasa_ref.json   (raw/resampled/bandpassed + PSD + bandpower scalars)

import json
import math
import numpy as np
from scipy import signal

FS_IN = 500.0
FS = 100.0
def dump_feature_rows(df_feat, idx, out_path="yasa_feat_ref.json"):
    feature_names = df_feat.columns.tolist()
    X = df_feat.to_numpy(dtype=np.float64)

    out = {
        "feature_names": feature_names,
        "idx": [int(i) for i in idx],
        "X_rows": { str(int(i)): X[int(i), :].tolist() for i in idx },
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"Wrote {out_path} (rows={len(idx)} cols={len(feature_names)})")
# Match the common filtfilt pad heuristic we used in JS:
# padlen = min(n-1, 3*(num_taps-1))
dump_feature_rows(df_feat, idx=[0, 1, 10, 100])
def filtfilt_fir_reflect(x: np.ndarray, b: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = x.size
    m = b.size
    pad = min(n - 1, 3 * (m - 1))
    if pad <= 0:
        return signal.convolve(x, b, mode="same")

    # reflect padding similar to our JS reflect-padding
    left = x[1:pad+1][::-1]          # reflect around x[0]
    right = x[-pad-1:-1][::-1]       # reflect around x[-1]
    xp = np.concatenate([left, x, right])

    y = signal.convolve(xp, b, mode="same")
    y = y[::-1]
    y = signal.convolve(y, b, mode="same")
    y = y[::-1]

    return y[pad:pad+n]

def checksum64(x: np.ndarray) -> float:
    # deterministic-ish checksum (not crypto)
    x = np.asarray(x, dtype=np.float64)
    idx = np.arange(x.size, dtype=np.float64)
    return float(np.sum(x * (idx + 1.0)))

def stats(x: np.ndarray) -> dict:
    x = np.asarray(x, dtype=np.float64)
    return {
        "n": int(x.size),
        "mean": float(np.mean(x)),
        "std": float(np.std(x, ddof=0)),
        "min": float(np.min(x)),
        "max": float(np.max(x)),
        "chk": checksum64(x),
    }

def welch_median_density(x: np.ndarray, fs: float, nperseg: int, noverlap: int | None = None):
    # SciPy welch density scaling (V^2/Hz), detrend='constant', window='hamming'
    if noverlap is None:
        noverlap = nperseg // 2
    f, Pxx = signal.welch(
        x,
        fs=fs,
        window="hamming",
        nperseg=nperseg,
        noverlap=noverlap,
        detrend="constant",
        return_onesided=True,
        scaling="density",
        average="median",
    )
    return f.astype(np.float64), Pxx.astype(np.float64)

def trapz_band(f, pxx, f0, f1):
    lo, hi = (f0, f1) if f0 <= f1 else (f1, f0)
    m = (f >= lo) & (f <= hi)
    if not np.any(m):
        return 0.0
    return float(np.trapz(pxx[m], f[m]))

def resample_500_to_100(x500: np.ndarray) -> np.ndarray:
    # polyphase is the closest “standard” to what we’ve been matching
    # (and avoids FFT ringing for long files)
    # up=1, down=5
    return signal.resample_poly(x500, up=1, down=5).astype(np.float64)

def make_synth(fs: float, seconds: float) -> np.ndarray:
    t = np.arange(int(fs * seconds), dtype=np.float64) / fs
    # A soup of rhythms: slow drift + delta + alpha + beta + a bit of noise
    rng = np.random.default_rng(1234)
    x = (
        120.0 * np.sin(2 * np.pi * 1.2 * t) +     # delta-ish
        40.0 * np.sin(2 * np.pi * 10.0 * t) +     # alpha
        15.0 * np.sin(2 * np.pi * 20.0 * t) +     # beta
        30.0 * np.sin(2 * np.pi * 0.2 * t) +      # slow drift
        5.0 * rng.standard_normal(t.size)         # noise
    )
    return x.astype(np.float64)

def main():
    # Load MNE FIR taps you exported (the JSON you showed)
    with open("mne_fir_0p4_30_fs100.json", "r", encoding="utf-8") as f:
        j = json.load(f)
    taps = np.array(j["taps"], dtype=np.float64)
    assert taps.size == 825, f"expected 825 taps, got {taps.size}"

    # Build a 30s “epoch” at 500 Hz (to mirror your logs)
    x500 = make_synth(FS_IN, seconds=30.0)

    # Reference pipeline
    x100 = resample_500_to_100(x500)
    xbp = filtfilt_fir_reflect(x100, taps)

    # Welch like staging: nperseg=5s @100Hz => 500
    freqs, psd = welch_median_density(xbp, fs=FS, nperseg=500)

    out = {
        "meta": {
            "fs_in": FS_IN,
            "fs": FS,
            "fir_taps_len": int(taps.size),
        },
        "signals": {
            "raw_500": {"stats": stats(x500), "first32": x500[:32].tolist()},
            "resamp_100": {"stats": stats(x100), "first32": x100[:32].tolist()},
            "bandpass_100": {"stats": stats(xbp), "first32": xbp[:32].tolist()},
        },
        "welch": {
            "nperseg": 500,
            "freqs": freqs.tolist(),
            "psd": psd.tolist(),
            "psd_sum": float(np.sum(psd)),
            "df": float(freqs[1] - freqs[0]),
            "psd_sum_df": float(np.sum(psd) * (freqs[1] - freqs[0])),
        },
        "bandpower": {
            "abs_0p4_30": trapz_band(freqs, psd, 0.4, 30.0),
            "abs_sdelta": trapz_band(freqs, psd, 0.4, 1.0),
            "abs_fdelta": trapz_band(freqs, psd, 1.0, 4.0),
            "abs_delta": trapz_band(freqs, psd, 0.4, 4.0),
            "abs_alpha": trapz_band(freqs, psd, 8.0, 12.0),
            "abs_beta": trapz_band(freqs, psd, 12.0, 30.0),
        }
    }

    with open("yasa_ref.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print("Wrote yasa_ref.json")

if __name__ == "__main__":
    main()