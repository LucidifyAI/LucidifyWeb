// sleep_stage_model.js
export async function loadSleepStageModel(modelUrl) {
  const model = await (await fetch(modelUrl)).json();

  if (model.format !== "sleep_stage_lr_v1") {
    throw new Error(`Unexpected model format: ${model.format}`);
  }

  const labels = model.labels;                 // ["W","N1","N2","N3","REM"]
  const featureOrder = model.feature_order;    // 12 features
  const means = model.means;
  const stds = model.stds;
  const W = model.W;                           // [5][12]
  const b = model.b;                           // [5]

  if (labels.length !== 5) throw new Error("Expected 5 labels");
  if (featureOrder.length !== means.length || means.length !== stds.length) {
    throw new Error("Model arrays length mismatch");
  }

  function softmaxStable(logits) {
    let max = logits[0];
    for (let i = 1; i < logits.length; i++) if (logits[i] > max) max = logits[i];
    const exps = new Array(logits.length);
    let sum = 0;
    for (let i = 0; i < logits.length; i++) {
      const e = Math.exp(logits[i] - max);
      exps[i] = e;
      sum += e;
    }
    if (sum <= 0) sum = 1;
    for (let i = 0; i < exps.length; i++) exps[i] /= sum;
    return exps;
  }

  function predictFromFeatures(featuresByName) {
    // Pack features in model.feature_order
    const x = new Array(featureOrder.length);
    for (let i = 0; i < featureOrder.length; i++) {
      const k = featureOrder[i];
      const v = featuresByName[k];
      if (!Number.isFinite(v)) {
        throw new Error(`Missing or non-finite feature: ${k}=${v}`);
      }
      x[i] = (v - means[i]) / (stds[i] || 1);
    }

    // logits = W*x + b
    const logits = new Array(labels.length);
    for (let c = 0; c < labels.length; c++) {
      let s = b[c];
      const row = W[c];
      for (let j = 0; j < x.length; j++) s += row[j] * x[j];
      logits[c] = s;
    }

    const probs = softmaxStable(logits);
    let best = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;

    return {
      predId: best,
      predLabel: labels[best],
      probs,
      logits,
    };
  }

  return { model, predictFromFeatures };
}
