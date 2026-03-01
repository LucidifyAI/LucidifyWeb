import numpy as np
import pandas as pd
import mne
import inspect
import yasa
from scipy import signal
from mne.filter import filter_data

print("YASA version:", yasa.__version__)
print("YASA module file:", yasa.__file__)

print("\n=== SleepStaging.fit source head ===")
src = inspect.getsource(yasa.SleepStaging.fit)
print("\n".join(src.splitlines()[:220]))

EDF_PATH = r"C:\Users\ryan\Downloads\Patientcode_Firstname_1_2_26_18_6_57_to_2_2_26_2_8_44.edf"
EEG_CH   = "Fp1"

raw = mne.io.read_raw_edf(EDF_PATH, preload=True, verbose="ERROR").pick([EEG_CH])

# KEEP IN VOLTS (no *1e6)
x_v = raw.get_data()[0]

info = mne.create_info([EEG_CH], sfreq=raw.info["sfreq"], ch_types=["eeg"])
raw_v = mne.io.RawArray(x_v[np.newaxis, :], info, verbose="ERROR")

sl = yasa.SleepStaging(raw_v, eeg_name=EEG_CH)
df = sl.get_features()

print("Feature shape:", df.shape)  # (962, 65)

df.insert(0, "epoch", np.arange(len(df), dtype=int))
df.to_csv("recording_py_features_VOLTS.csv", index=False, float_format="%.17g")
print("Wrote recording_py_features_VOLTS.csv")

sf = raw_v.info["sfreq"]  # should be 500 here

# 1) Bandpass like YASA: 0.4–30 on the continuous data (VOLTS)
x = raw_v.get_data()[0]
x_filt = filter_data(x, sf, l_freq=0.4, h_freq=30, verbose=False)

# 2) Take epoch0 = first 30 seconds of the filtered signal
epoch0 = x_filt[:int(30 * sf)]

# 3) Welch like YASA (note: sf here is 500 because in YASA it uses self.sf)
win_sec = 5
win = int(win_sec * sf)  # 5 * sf
freqs, psd = signal.welch(
    epoch0,
    fs=sf,
    window="hamming",
    nperseg=win,
    average="median",
)

dx = freqs[1] - freqs[0]

# 4) Parseval-ish check: integral of PSD vs variance of epoch0
print("PY variance:", np.var(epoch0, ddof=0))
print("PY integral PSD:", np.sum(psd) * dx)

# Optional: match YASA abspow integration range exactly (0.4–30 inclusive)
idx = (freqs >= 0.4) & (freqs <= 30)
print("PY abspow epoch0:", np.trapz(psd[idx], dx=dx))
