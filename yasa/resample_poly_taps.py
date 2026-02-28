import json
import numpy as np
from scipy import signal

up = 1
down = 5
window = ("kaiser", 5.0)   # SciPy default-ish; we'll export whatever you choose
numtaps = 10 * max(up, down) + 1  # common default used in docs/examples

h = signal.firwin(numtaps, 1.0/max(up, down), window=window)
# IMPORTANT: resample_poly internally multiplies h by up
h = h * up

out = {
  "up": up,
  "down": down,
  "numtaps": int(h.size),
  "window": ["kaiser", 5.0],
  "taps": h.astype(np.float64).tolist(),
}
with open("resample_poly_1_5_taps.json", "w") as f:
  json.dump(out, f, indent=2)

print("Wrote resample_poly_1_5_taps.json", "numtaps=", h.size)