//---ParseSleepEDFHypnogramFromArrayBuffer---------------------------------------------------------
function parseSleepEdfHypnogramFromArrayBuffer(arrayBuffer, opts = {}) {
  const epochSec = opts.epochSec ?? 30;
  const mapToAasm = opts.mapToAasm ?? true;
  const totalDurationSecOpt = opts.totalDurationSec ?? null;

  const u8 = new Uint8Array(arrayBuffer);

  function readAscii(off, len) {
    // EDF headers are ASCII, space-padded
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i] || 0);
    return s.trim();
  }
  function readIntField(off, len) {
    const s = readAscii(off, len);
    const v = parseInt(s, 10);
    return Number.isFinite(v) ? v : 0;
  }
  function readFloatField(off, len) {
    const s = readAscii(off, len);
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  }

  // EDF fixed header
  const headerBytes = readIntField(184, 8);
  const nRecords = readIntField(236, 8);
  const recDurSec = readFloatField(244, 8);
  const nSignals = readIntField(252, 4);

  if (!headerBytes || !nSignals) throw new Error("Bad EDF header (headerBytes/nSignals).");

  // EDF signal header arrays are column-wise
  const offLabel = 256;
  const offTrans = offLabel + 16 * nSignals;
  const offPhysDim = offTrans + 80 * nSignals;
  const offPhysMin = offPhysDim + 8 * nSignals;
  const offPhysMax = offPhysMin + 8 * nSignals;
  const offDigMin = offPhysMax + 8 * nSignals;
  const offDigMax = offDigMin + 8 * nSignals;
  const offPrefilt = offDigMax + 8 * nSignals;
  const offSampPR = offPrefilt + 80 * nSignals;

  // Find annotations channel
  let annSig = -1;
  for (let i = 0; i < nSignals; i++) {
    const lab = readAscii(offLabel + i * 16, 16).toLowerCase();
    if (lab.includes("edf annotations")) { annSig = i; break; }
  }
  if (annSig < 0) annSig = 0;

  // Samples-per-record for each signal
  const sampPR = new Array(nSignals);
  for (let i = 0; i < nSignals; i++) sampPR[i] = readIntField(offSampPR + i * 8, 8);

  // --- TAL parsing helpers ---
  function mapStageToken(txt) {
    // matches: "Sleep stage W", "Sleep stage 1", "Sleep stage R", "Sleep stage 4", etc.
    const m = /sleep\s*stage\s*([WR1234M?])/i.exec(txt);
    if (!m) return null;
    const s = m[1].toUpperCase();

    if (s === "W") return "W";
    if (s === "R") return "REM";
    if (s === "1") return "N1";
    if (s === "2") return "N2";
    if (s === "3" || s === "4") return mapToAasm ? "N3" : (s === "3" ? "N3" : "N4");
    // Movement/Unknown: exclude
    return null;
  }

  function parseTalBlock(block, onStage) {
    // EDF+ record: onset [\x15 duration] \x14 annotation \x14 ... \x14
    // Example: "+30630\x1530\x14Sleep stage W\x14"
    const parts = block.split("\x14").filter(p => p.length > 0);
    if (!parts.length) return;

    const first = parts[0];
    let onsetStr = first;
    let durStr = null;

    const i15 = first.indexOf("\x15");
    if (i15 >= 0) {
      onsetStr = first.slice(0, i15);
      durStr = first.slice(i15 + 1);
    }

    const onsetSec = parseFloat(onsetStr);
    if (!Number.isFinite(onsetSec)) return;

    // duration is optional in EDF+; for sleep stages it should be present
    const durSec = (durStr && durStr.length) ? parseFloat(durStr) : null;

    for (let i = 1; i < parts.length; i++) {
      const st = mapStageToken(parts[i]);
      if (!st) continue;
      onStage(onsetSec, durSec, st);
    }
  }

  // Determine stage array length:
  // Prefer the PSG’s duration if you pass it in; otherwise derive from max onset/duration.
  const totalDurationSec = (Number.isFinite(totalDurationSecOpt) && totalDurationSecOpt > 0)
    ? totalDurationSecOpt
    : null;

  const nEpochs = totalDurationSec ? Math.ceil(totalDurationSec / epochSec) : null;
  let stages = nEpochs ? new Array(nEpochs).fill(null) : null;
  let maxEpochSeen = 0;

  function setStage(onsetSec, durSec, stageStr) {
    const startEpoch = Math.floor((onsetSec + 1e-6) / epochSec);
    if (!Number.isFinite(durSec) || durSec <= 0) return;
    const count = Math.round(durSec / epochSec);
    const endEpoch = startEpoch + count;

    if (!stages) {
      maxEpochSeen = Math.max(maxEpochSeen, endEpoch);
    } else {
      maxEpochSeen = Math.max(maxEpochSeen, endEpoch);
      for (let e = startEpoch; e < endEpoch && e < stages.length; e++) stages[e] = stageStr;
    }
  }

  // If we didn’t know length up front, we’ll collect segments then allocate
  const segments = stages ? null : [];
  function collectStage(onsetSec, durSec, stageStr) {
    const startEpoch = Math.floor((onsetSec + 1e-6) / epochSec);
    if (!Number.isFinite(durSec) || durSec <= 0) return;
    const count = Math.round(durSec / epochSec);
    const endEpoch = startEpoch + count;
    maxEpochSeen = Math.max(maxEpochSeen, endEpoch);
    segments.push({ startEpoch, endEpoch, stageStr });
  }

  const onStage = stages ? setStage : collectStage;

  // Data records
  let dataOff = headerBytes;

  // We need the raw bytes of the annotations signal, not int16->char.
  // So we slice bytes for that signal and decode as latin1.
  const decoder = new TextDecoder("latin1");

  for (let r = 0; r < Math.max(1, nRecords); r++) {
    for (let s = 0; s < nSignals; s++) {
      const nSamp = sampPR[s] | 0;
      const nBytes = nSamp * 2; // EDF samples are 2 bytes each

      if (s === annSig) {
        const bytes = new Uint8Array(arrayBuffer, dataOff, nBytes);
        const txt = decoder.decode(bytes);

        // TAL blocks are NUL-separated
        const blocks = txt.split("\x00");
        for (const b of blocks) {
          if (b) parseTalBlock(b, onStage);
        }
      }

      dataOff += nBytes;
    }
  }

// If we didn’t know length up front, allocate now from what we saw.
	if (!stages) {
	  stages = new Array(maxEpochSeen + 1).fill(null);
	  for (const seg of segments) {
		for (let e = seg.startEpoch; e < seg.endEpoch && e < stages.length; e++) {
		  stages[e] = seg.stageStr;
		}
	  }
	}

	// If caller provided a target duration, ensure array is that length (pad with nulls).
	if (Number.isFinite(totalDurationSecOpt) && totalDurationSecOpt > 0) {
	  const wantEpochs = Math.ceil(totalDurationSecOpt / epochSec);
	  if (stages.length < wantEpochs) {
		stages.length = wantEpochs;          // extends with undefined
		for (let i = 0; i < wantEpochs; i++) // normalize undefined -> null
		  if (stages[i] === undefined) stages[i] = null;
	  }
	  // If stages is longer than wantEpochs, you may truncate; usually safe:
	  if (stages.length > wantEpochs) stages = stages.slice(0, wantEpochs);
	}

	return { epochSec, stages, sourceName: "" };

}
//---------------------------------------------------------------------------
//-----ParseBidsEventsTsvToHypnogram-----------------------------------------
function parseBidsEventsTsvToHypnogram(tsvText, opts = {}) {
  const epochSec = opts.epochSec ?? 30;
  const totalDurationSecOpt = Number.isFinite(opts.totalDurationSec) ? opts.totalDurationSec : null;
  const fs = Number.isFinite(opts.fs) ? opts.fs : null; // optional
  const preferSamples = !!opts.preferSamples; // if true and begsample exists, use begsample/fs
  const sourceName = opts.sourceName || "";

  // --- TSV parse (tab-separated, header row) ---
  const lines = String(tsvText || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter(l => l.trim().length);

  if (lines.length < 2) return { epochSec, stages: [], sourceName };

  const header = lines[0].split("\t").map(h => h.trim());
  const col = (name) => header.indexOf(name);

  // Pick a stage column
  const stageCandidates = [opts.stageColumn, "stage_hum", "stage_ai", "stage", "sleep_stage"].filter(Boolean);
  let stageCol = -1;
  let stageColName = "";
  for (const c of stageCandidates) {
    const i = col(c);
    if (i >= 0) { stageCol = i; stageColName = c; break; }
  }
  if (stageCol < 0) throw new Error("No stage column found in events.tsv");

  const onsetCol    = col("onset");
  const durCol      = col("duration");
  const begSampCol  = col("begsample");
  const endSampCol  = col("endsample");

  const toNum = (s) => {
    const v = parseFloat(String(s).trim());
    return Number.isFinite(v) ? v : null;
  };

  const normalizeStage = (raw) => {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s || s === "n/a" || s === "NA") return null;

    // string labels
    const up = s.toUpperCase();
    if (up === "W" || up === "WAKE") return "W";
    if (up === "R" || up === "REM") return "REM";
    if (up === "N1" || up === "1") return "N1";
    if (up === "N2" || up === "2") return "N2";
    if (up === "N3" || up === "3" || up === "N4" || up === "4") return "N3";

    // numeric codes (common: 0=W,1=N1,2=N2,3=N3,4=REM)
    const n = parseInt(s, 10);
    if (Number.isFinite(n)) {
      if (n === 0) return "W";
      if (n === 1) return "N1";
      if (n === 2) return "N2";
      if (n === 3) return "N3";
      if (n === 4) return "REM";
      return null;
    }
    return null;
  };

  // Collect segments then allocate
  let maxEpoch = -1;
  const segs = [];

  for (let li = 1; li < lines.length; li++) {
    const row = lines[li].split("\t");
    if (row.length < header.length) continue;

    const st = normalizeStage(row[stageCol]);
    if (!st) continue;

    // Determine onsetSec and durSec
    let onsetSec = null;
    let durSec = null;

    const onset = (onsetCol >= 0) ? toNum(row[onsetCol]) : null;
    const dur   = (durCol   >= 0) ? toNum(row[durCol])   : null;

    const begS  = (begSampCol >= 0) ? toNum(row[begSampCol]) : null;
    const endS  = (endSampCol >= 0) ? toNum(row[endSampCol]) : null;

    if (preferSamples && fs && begS != null) {
      // BIDS begsample is often 1-based; align epoching by using (begsample-1)/fs
      onsetSec = Math.max(0, (begS - 1) / fs);

      if (endS != null) {
        // inclusive endsample in many exports
        const nSamp = Math.max(0, (endS - begS + 1));
        durSec = nSamp / fs;
      } else if (dur != null) {
        durSec = dur;
      } else {
        durSec = epochSec;
      }
    } else if (onset != null) {
      onsetSec = onset;
      durSec = (dur != null) ? dur : epochSec;
    } else {
      continue;
    }

    if (!Number.isFinite(onsetSec) || !Number.isFinite(durSec) || durSec <= 0) continue;

    const startEpoch = Math.floor((onsetSec + 1e-6) / epochSec);
    const count = Math.max(1, Math.round(durSec / epochSec));
    const endEpoch = startEpoch + count;

    maxEpoch = Math.max(maxEpoch, endEpoch);
    segs.push({ startEpoch, endEpoch, st });
  }

  const nEpochs = (totalDurationSecOpt && totalDurationSecOpt > 0)
    ? Math.ceil(totalDurationSecOpt / epochSec)
    : Math.max(0, maxEpoch);

  const stages = new Array(nEpochs).fill(null);

  for (const seg of segs) {
    const a = Math.max(0, seg.startEpoch);
    const b = Math.min(stages.length, seg.endEpoch);
    for (let e = a; e < b; e++) stages[e] = seg.st;
  }

  // Optional debug
  // console.log(`Ref TSV (${sourceName}) using ${stageColName}: epochs=${stages.length}`);

  return { epochSec, stages, sourceName };
}
  function compareStages(pred, ref) {
    const labels = ["W", "N1", "N2", "N3", "REM"];
    const idx = new Map(labels.map((l, i) => [l, i]));
    const K = labels.length;
  
    let N = 0, agree = 0;
    const cm = Array.from({ length: K }, () => new Array(K).fill(0));
  
    for (let i = 0; i < Math.min(pred.length, ref.length); i++) {
      const a = pred[i], b = ref[i];
      if (!idx.has(a) || !idx.has(b)) continue; // skip null/unknown/movement
      const ia = idx.get(a), ib = idx.get(b);
      cm[ia][ib] += 1;
      N++;
      if (ia === ib) agree++;
    }
  
    const acc = N ? (agree / N) : 0;
  
    // Cohen’s kappa
    let pe = 0;
    if (N) {
      const row = cm.map(r => r.reduce((s, v) => s + v, 0));
      const col = Array.from({ length: K }, (_, j) => cm.reduce((s, r) => s + r[j], 0));
      for (let k = 0; k < K; k++) pe += (row[k] / N) * (col[k] / N);
    }
    const kappa = (N && (1 - pe) > 1e-12) ? ((acc - pe) / (1 - pe)) : 0;
  
    return { N, acc, kappa, cm, labels };
  }
window.HYPNO_REF = {
  parseSleepEdfHypnogramFromArrayBuffer,
  parseBidsEventsTsvToHypnogram,
  compareStages
};