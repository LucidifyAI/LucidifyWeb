# YASA JS port (sleep staging)

This folder contains an independent JavaScript port of the YASA sleep staging pipeline
(feature definitions + model inference), intended to run fully in-browser.

Attribution / License:
- Inspired by YASA ("yasa" Python project, BSD-3-Clause).
- See LICENSE in this folder.

Notes:
- This port must be validated against the reference Python implementation.
- Model file: yasa_model_dump.json (LightGBM booster dump exported from Python).