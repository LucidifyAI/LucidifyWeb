import json
import re
import numpy as np
import mne
from scipy.signal import welch, filtfilt

# ----------------------------
# Config
# ----------------------------
EDF_PATH = r"C:\Users\ryan\Downloads\Patientcode_Firstname_1_2_26_18_6_57_to_2_2_26_2_8_44.edf"
EEG_CH = "Fp1"

# Point this at your JS file that contains the embedded MNE FIR taps
# (the one with "__MNE_FIR_0P4_30_FS100__" and "taps: [ ... ]")
YASA_DSP_JS_PATH = r"yasa_dsp.js"

# Optional: your JS-exported epoch JSON (for diffing)
JS_EPOCH_JSON = r"js_epoch0_signal.json"

TARGET_FS = 100.0
BANDPASS_NAME = "__MNE_FIR_0P4_30_FS100__"
EPOCH_SEC = 30
NPERSEG = 500  # 5 sec @ 100 Hz


# ----------------------------
# Helpers
# ----------------------------
def load_mne_fir_taps_from_js(js_path: str, block_name: str = BANDPASS_NAME) -> np.ndarray:
    """
    Extracts the FIR taps array from yasa_dsp.js (or similar), matching:
      const __MNE_FIR_0P4_30_FS100__ = { ..., taps: [ ... ] }
    Returns float64 numpy array.
    """
    with open(js_path, "r", encoding="utf-8") as f:
        s = f.read()

    # Grab the object block
    m = re.search(rf"const\s+{re.escape(block_name)}\s*=\s*\{{(.*?)\n\}}\s*;", s, flags=re.S)
    if not m:
        # fallback: looser match if your file format differs slightly
        m = re.search(rf"{re.escape(block_name)}\s*=\s*\{{(.*?)\}}\s*;", s, flags=re.S)
    if not m:
        raise RuntimeError(f"Could not find JS FIR block named {block_name} in {js_path}")

    block = m.group(1)

    # Extract taps: [ ... ]
    m2 = re.search(r"taps\s*:\s*\[(.*?)\]", block, flags=re.S)
    if not m2:
        raise RuntimeError(f"Could not find 'taps: [ ... ]' inside {block_name}")

    taps_txt = m2.group(1)

    # Parse numbers (handles negatives, decimals, exponent notation)
    nums = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", taps_txt)
    if not nums:
        raise RuntimeError("Parsed 0 tap coefficients from JS. Regex failed or taps not numeric.")

    taps = np.array([float(x) for x in nums], dtype=np.float64)
    return taps


def decimate_by_integer_pick(x: np.ndarray, fs_in: float, fs_out: float) -> np.ndarray:
    """
    Matches your JS behavior: pure decimation by picking every Kth sample (no anti-alias filter).
    """
    k = int(round(fs_in / fs_out))
    if not np.isclose(fs_in / k, fs_out, atol=1e-6):
        raise ValueError(f"Non-integer decimation: fs_in={fs_in}, fs_out={fs_out}, fs_in/fs_out={fs_in/fs_out}")
    return x[::k].astype(np.float64, copy=False)


def filtfilt_fir_reflectish(x: np.ndarray, taps: np.ndarray) -> np.ndarray:
    """
    Zero-phase FIR using scipy.signal.filtfilt. padtype='odd' is closest to reflect-style padding.
    """
    b = taps.astype(np.float64, copy=False)
    a = np.array([1.0], dtype=np.float64)

    # Make sure padlen is valid
    default_padlen = 3 * (max(len(a), len(b)) - 1)
    if x.size <= default_padlen:
        # if your epoch is too short, reduce padlen rather than exploding
        padlen = max(0, x.size - 1)
    else:
        padlen = default_padlen

    return filtfilt(b, a, x, method="pad", padtype="odd", padlen=padlen)


# ----------------------------
# Main: Python pipeline that matches JS
# ----------------------------
# 1) Read EDF (no filtering here)
raw = mne.io.read_raw_edf(EDF_PATH, preload=True, verbose="ERROR").pick([EEG_CH])

fs_in = float(raw.info["sfreq"])
x_v = raw.get_data()[0]                 # Volts (MNE)
x_uv = x_v * 1e6                        # microvolts (match JS)

# 2) Pure decimation to 100 Hz (JS does pick-every-5 for 500->100)
x100 = decimate_by_integer_pick(x_uv, fs_in=fs_in, fs_out=TARGET_FS)

# 3) Apply *exact* MNE FIR taps (from JS) in zero-phase mode
taps = load_mne_fir_taps_from_js(YASA_DSP_JS_PATH, BANDPASS_NAME)
x100_f = filtfilt_fir_reflectish(x100, taps)

# 4) Take epoch0
fs = TARGET_FS
n_epoch = int(fs * EPOCH_SEC)  # 3000
epoch_py = x100_f[:n_epoch].copy()

# 5) Welch (match your params)
freqs_py, psd_py = welch(
    epoch_py,
    fs=fs,
    window="hamming",
    nperseg=NPERSEG,
    noverlap=NPERSEG // 2,
    detrend="constant",
    return_onesided=True,
    scaling="density",
    average="median",
)

dx = freqs_py[1] - freqs_py[0]
print("PY freqs[0:6]:", freqs_py[:6])
print("PY psd[0:6]:", psd_py[:6])
print("PY df:", dx)
print("PY PSD_int (0..Nyq):", float(np.sum(psd_py) * dx))
print("PY var(epoch0):", float(np.var(epoch_py, ddof=0)))
print("PY ratio PSD_int/var:", float((np.sum(psd_py) * dx) / (np.var(epoch_py, ddof=0) or 1.0)))

# Optional: save Python PSD for exact diffing
with open("py_epoch0_psd.json", "w", encoding="utf-8") as f:
    json.dump({"fs": fs, "nperseg": NPERSEG, "freqs": freqs_py.tolist(), "psd": psd_py.tolist()}, f)
print("Wrote py_epoch0_psd.json")

# ----------------------------
# Optional: Compare vs JS epoch JSON (if you have it)
# ----------------------------
try:
    with open(JS_EPOCH_JSON, "r", encoding="utf-8") as f:
        j = json.load(f)

    epoch_js = np.array(j["signal"], dtype=np.float64)
    fs_js = float(j["fs"])

    # sanity
    print("len py/js", len(epoch_py), len(epoch_js))
    print("var py/js", float(np.var(epoch_py, ddof=0)), float(np.var(epoch_js, ddof=0)))

    # signal similarity
    corr = float(np.corrcoef(epoch_py, epoch_js)[0, 1])
    print("signal corr:", corr)

    # Welch on JS epoch
    freqs_js, psd_js = welch(
        epoch_js,
        fs=fs_js,
        window="hamming",
        nperseg=NPERSEG,
        noverlap=NPERSEG // 2,
        detrend="constant",
        return_onesided=True,
        scaling="density",
        average="median",
    )

    print("psd first10 py:", psd_py[:10])
    print("psd first10 js:", psd_js[:10])
    print("psd max abs diff:", float(np.max(np.abs(psd_py - psd_js))))

except FileNotFoundError:
    print(f"(No JS epoch JSON found at {JS_EPOCH_JSON}; skipping diff.)")