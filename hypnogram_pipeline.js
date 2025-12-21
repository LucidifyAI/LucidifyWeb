// hypnogram_pipeline.js
import { computeFeatures } from "./sleep_stage_features.js";
import { loadSleepStageModel } from "./sleep_stage_model.js";

export function predictHypnogram(samples, fs, predictFromFeatures, epochLenSec = 30) {
  const samplesPerEpoch = Math.floor(fs * epochLenSec);
  const nEpochs = Math.floor(samples.length / samplesPerEpoch);
  const stages = new Array(nEpochs);
  const probs = new Array(nEpochs);

  for (let e = 0; e < nEpochs; e++) {
    const start = e * samplesPerEpoch;
    const stop = start + samplesPerEpoch;

    const epoch = samples.slice(start, stop);
    const feats = computeFeatures(epoch, fs);
    const out = predictFromFeatures(feats);

    stages[e] = out.predLabel;
    probs[e] = out.probs;
  }
  return { stages, probs };
}

// NEW: this matches what sleep_stage.js expects
export async function runHypnogram({
  recording,
  epochSec = 30,
  channelIndex = 0,
  modelUrl = "model.json",
}) {
  if (!recording || !Array.isArray(recording.channels) || recording.channels.length === 0) {
    throw new Error("Invalid recording");
  }
  const ch = recording.channels[channelIndex] || recording.channels[0];
  if (!ch || !ch.samples || !ch.samples.length) {
    throw new Error("Selected channel has no samples");
  }

  const fs = ch.fs || 256;
  const { predictFromFeatures } = await loadSleepStageModel(modelUrl);

  return predictHypnogram(ch.samples, fs, predictFromFeatures, epochSec);
}

