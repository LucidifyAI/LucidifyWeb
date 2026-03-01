import pandas as pd
import numpy as np

js = pd.read_csv("recording_js_features_packed (4).csv")
py = pd.read_csv("recording_py_features_VOLTS.csv")

# align columns
common = sorted(set(js.columns) & set(py.columns))
js = js[common]
py = py[common]

diff = (js - py).abs()

summary = pd.DataFrame({
    "max_abs_diff": diff.max(),
    "mean_abs_diff": diff.mean(),
})

summary = summary.sort_values("max_abs_diff", ascending=False)

print(summary.head(20))