import json
import re
import time
from dataclasses import dataclass

import numpy as np
import mne
from scipy.signal import welch


# ------------------------- CONFIG -------------------------

EDF_PATH = r"C:\Users\ryan\Downloads\Patientcode_Firstname_1_2_26_18_6_57_to_2_2_26_2_8_44.edf"
EEG_CH = "Fp1"

# Point this at your local file; keep the same name if you like.
YASA_DSP_JS_PATH = r"yasa_dsp.js"

# Your exported JS epoch (already in uV, fs=100)
JS_EPOCH_PATH = r"js_epoch0_signal.json"

EPOCH_SEC = 30
FS_TARGET = 100.0
N_PER_SEG = 500  # 5 sec @ 100 Hz
OVERLAP = N_PER_SEG // 2


# ------------------------- UTIL: JS taps extraction -------------------------

_FLOAT_RE = r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?"

def _extract_first_taps_array(js_text: str) -> np.ndarray:
    """
    Find the first occurrence of `taps: [ ... ]` in a JS object literal and parse floats.
    This is robust to whitespace/newlines and ignores other numeric fields.
    """
    m = re.search(r"\btaps\s*:\s*\[([\s\S]*?)\]", js_text)
    if not m:
        raise RuntimeError("Could not find any `taps: [ ... ]` array in the JS file.")
    body = m.group(1)
    nums = re.findall(_FLOAT_RE, body)
    if not nums:
        raise RuntimeError("Found `taps: [...]` but could not parse any floats.")
    return np.array([float(x) for x in nums], dtype=np.float64)

def load_mne_fir_taps_from_js(js_path: str) -> np.ndarray:
    """
    Preferred: specifically pull taps for the MNE 0.4–30 @ 100 Hz kernel if present.
    Fallback: pull the first `taps: [...]` array in the file.
    """
    with open(js_path, "r", encoding="utf-8") as f:
        txt = f.read()

    # 1) Try to target the exact object name you actually have in yasa_dsp.js:
    #    const __MNE_FIR_0P4_30_FS100__ = { ... taps: [ ... ] }
    target = "__MNE_FIR_0P4_30_FS100__"
    m = re.search(
        rf"const\s+{re.escape(target)}\s*=\s*\{{([\s\S]*?)\}}\s*;",
        txt
    )
    if m:
        obj_body = m.group(1)
        taps = _extract_first_taps_array("taps: [" + obj_body.split("taps:", 1)[1].split("]", 1)[0] + "]")
        return taps

    # 2) Try legacy patterns people often used:
    #    __MNE_FIR_0P4_30_FS100__ Float64Array([ ... ])
    m = re.search(r"__MNE_FIR_0P4_30_FS100__\s*=\s*new\s+Float64Array\s*\(\s*\[([\s\S]*?)\]\s*\)", txt)
    if m:
        nums = re.findall(_FLOAT_RE, m.group(1))
        if not nums:
            raise RuntimeError("Matched Float64Array([...]) but no floats parsed.")
        return np.array([float(x) for x in nums], dtype=np.float64)

    # 3) Fallback: first taps array anywhere
    return _extract_first_taps_array(txt)


# ------------------------- UTIL: JS-style DSP -------------------------

def decimate_by_5_take_every_5th(x: np.ndarray) -> np.ndarray:
    n = (x.size // 5)
    return x[: n * 5 : 5].copy()

def fir_convolve_same_zero(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    """
    Match JS firConvolve():
      y[i] = sum_k h[k] * x[i + k - half], with x out-of-bounds treated as 0.
    This is equivalent to 'same' convolution with zero padding.
    """
    x = np.asarray(x, dtype=np.float64)
    h = np.asarray(h, dtype=np.float64)
    m = h.size
    half = (m - 1) // 2

    # zero-pad
    xp = np.pad(x, (half, half), mode="constant", constant_values=0.0)
    y = np.convolve(xp, h, mode="valid")  # length == len(x)
    return y.astype(np.float64, copy=False)

def filtfilt_fir_zero_pad(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    """
    Match JS filtfiltFIR_zeroPad():
      y1 = firConvolve(x, h)
      y2 = firConvolve(reverse(y1), h)
      return reverse(y2)
    """
    y1 = fir_convolve_same_zero(x, h)
    y2 = fir_convolve_same_zero(y1[::-1], h)
    return y2[::-1]


# ------------------------- IO helpers -------------------------

@dataclass
class JsEpoch:
    signal_uv: np.ndarray
    fs: float

def load_js_epoch(path: str) -> JsEpoch:
    with open(path, "r", encoding="utf-8") as f:
        j = json.load(f)
    sig = np.asarray(j["signal"], dtype=np.float64)
    fs = float(j["fs"])
    return JsEpoch(signal_uv=sig, fs=fs)

def read_edf_channel_uv(edf_path: str, ch_name: str) -> tuple[np.ndarray, float]:
    raw = mne.io.read_raw_edf(edf_path, preload=True, verbose="ERROR").pick([ch_name])
    fs_in = float(raw.info["sfreq"])
    x_v = raw.get_data()[0]        # volts
    x_uv = x_v * 1e6               # microvolts
    return np.asarray(x_uv, dtype=np.float64), fs_in


# ------------------------- Compare metrics -------------------------

def corr(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.size != b.size:
        raise ValueError("corr(): lengths differ")
    if a.size < 2:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1])

def rmse(a: np.ndarray, b: np.ndarray) -> float:
    d = np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    return float(np.sqrt(np.mean(d * d)))

def max_abs(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.max(np.abs(np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64))))

def summarize_epoch(tag: str, epoch_py: np.ndarray, epoch_js: np.ndarray) -> None:
    print(f"\n=== Compare: {tag} (PY) vs JS epoch ===")
    print("len py/js", len(epoch_py), len(epoch_js))
    print("var py/js", float(np.var(epoch_py, ddof=0)), float(np.var(epoch_js, ddof=0)))
    print("signal corr:", corr(epoch_py, epoch_js))
    print("signal rmse:", rmse(epoch_py, epoch_js))
    print("signal max abs diff:", max_abs(epoch_py, epoch_js))
    print("first16 py:", epoch_py[:16])
    print("first16 js:", epoch_js[:16])

def summarize_psd(tag: str, epoch_py: np.ndarray, epoch_js: np.ndarray, fs: float, out_json: str) -> None:
    freqs, psd_py = welch(
        epoch_py,
        fs=fs,
        window="hamming",
        nperseg=N_PER_SEG,
        noverlap=OVERLAP,
        detrend="constant",
        return_onesided=True,
        scaling="density",
        average="median",
    )
    freqs2, psd_js = welch(
        epoch_js,
        fs=fs,
        window="hamming",
        nperseg=N_PER_SEG,
        noverlap=OVERLAP,
        detrend="constant",
        return_onesided=True,
        scaling="density",
        average="median",
    )

    dx = float(freqs[1] - freqs[0])
    psd_int_py = float(np.sum(psd_py) * dx)
    psd_int_js = float(np.sum(psd_js) * dx)

    print(f"\n--- PSD stage: {tag} ---")
    print("df", dx)
    print("freqs[:10]", freqs[:10])
    print("PSD_int py", psd_int_py)
    print("PSD_int js", psd_int_js)
    print("ratio py", psd_int_py / (float(np.var(epoch_py, ddof=0)) or 1.0))
    print("ratio js", psd_int_js / (float(np.var(epoch_js, ddof=0)) or 1.0))
    print("psd first10 py:", psd_py[:10])
    print("psd first10 js:", psd_js[:10])
    print("psd max abs diff:", float(np.max(np.abs(psd_py - psd_js))))

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(
            {
                "fs": fs,
                "nperseg": N_PER_SEG,
                "noverlap": OVERLAP,
                "freqs": freqs.tolist(),
                "psd_py": psd_py.tolist(),
                "psd_js": psd_js.tolist(),
            },
            f,
        )
    print(f"Wrote {out_json}")


# ------------------------- MAIN -------------------------

def main() -> None:
    t0 = time.time()

    taps = load_mne_fir_taps_from_js(YASA_DSP_JS_PATH)
    print(f"Loaded taps: {len(taps)} first5:", taps[:5])

    js = load_js_epoch(JS_EPOCH_PATH)
    print(f"Loaded JS epoch: len={len(js.signal_uv)} fs={js.fs}")

    print("Reading EDF (this can take a moment)...")
    t_read = time.time()
    x_uv_500, fs_in = read_edf_channel_uv(EDF_PATH, EEG_CH)
    print(f"EDF loaded: fs_in={fs_in}, samples={len(x_uv_500)}, elapsed={time.time() - t_read:.2f}s")

    if abs(fs_in - 500.0) > 1e-6:
        raise RuntimeError(f"Expected EDF fs=500 Hz to match JS diagnostic path, got {fs_in}")

    # epoch length @ target fs
    n_epoch = int(FS_TARGET * EPOCH_SEC)

    # --- Stage A: JS-style downsample only (take every 5th) ---
    print(f"Downsampling to {FS_TARGET} Hz (integer /5)...")
    t_ds = time.time()
    x_ds = decimate_by_5_take_every_5th(x_uv_500)
    print(f"Downsample done: samples={len(x_ds)}, fs={FS_TARGET}, elapsed={time.time() - t_ds:.2f}s")

    epoch_ds = x_ds[:n_epoch].copy()
    epoch_js = js.signal_uv[:n_epoch].copy()

    summarize_epoch("resample-only", epoch_ds, epoch_js)

    # --- Stage B: JS-style FIR filtfilt (zero-pad) using JS taps ---
    print("Bandpass 0.4–30 using JS taps via filtfilt...")
    t_bp = time.time()
    x_bp = filtfilt_fir_zero_pad(x_ds, taps)
    print(f"Filter done: samples={len(x_bp)}, elapsed={time.time() - t_bp:.2f}s")

    epoch_bp = x_bp[:n_epoch].copy()

    summarize_epoch("resample+FIR bandpass", epoch_bp, epoch_js)

    summarize_psd("resample-only", epoch_ds, epoch_js, fs=FS_TARGET, out_json="py_vs_js_psd_resample_only.json")
    summarize_psd("resample+bandpass", epoch_bp, epoch_js, fs=FS_TARGET, out_json="py_vs_js_psd_resample_bandpass.json")

    print(f"\nTOTAL elapsed: {time.time() - t0:.2f}s")


if __name__ == "__main__":
    main()