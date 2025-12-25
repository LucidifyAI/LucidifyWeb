/*  yasa_lgbm.js
    Minimal LightGBM (dump_model JSON) inference in pure JS.

    Intended for YASA SleepStaging model exports produced via:
      booster = clf.booster_
      dump = booster.dump_model()
      json.dump(dump, open("yasa_model_dump.json","w"))

    License note:
      This file is an original implementation for compatibility.
*/

(function () {
  "use strict";

  function softmaxRow(scores) {
    let maxv = -Infinity;
    for (let i = 0; i < scores.length; i++) maxv = Math.max(maxv, scores[i]);
    let sum = 0;
    const exps = new Float64Array(scores.length);
    for (let i = 0; i < scores.length; i++) {
      const e = Math.exp(scores[i] - maxv);
      exps[i] = e;
      sum += e;
    }
    for (let i = 0; i < scores.length; i++) exps[i] /= sum || 1;
    return exps;
  }

  function evalTreeNode(node, x) {
    // Leaf
    if (node.leaf_value !== undefined) return node.leaf_value;

    const fidx = node.split_feature;
    const thr = node.threshold;
    const decision = node.decision_type || "<=";
    const defaultLeft = node.default_left !== undefined ? node.default_left : true;

    const v = x[fidx];
    const isMissing = Number.isNaN(v);

    let goLeft;
    if (isMissing) {
      goLeft = defaultLeft;
    } else if (decision === "<=") {
      goLeft = (v <= thr);
    } else if (decision === "<") {
      goLeft = (v < thr);
    } else if (decision === ">") {
      goLeft = (v > thr);
    } else if (decision === ">=") {
      goLeft = (v >= thr);
    } else if (decision === "==") {
      goLeft = (v === thr);
    } else {
      // Fallback to <=
      goLeft = (v <= thr);
    }

    const child = goLeft ? node.left_child : node.right_child;
    return evalTreeNode(child, x);
  }

  function detectNumClass(modelDump) {
    // LightGBM dump_model sometimes has num_class in different places.
    if (modelDump.num_class) return modelDump.num_class;
    if (modelDump.objective && modelDump.objective.num_class) return modelDump.objective.num_class;
    if (modelDump.train_set && modelDump.train_set.num_class) return modelDump.train_set.num_class;
    // Heuristic: infer from tree_info count patterns (multiclass = trees grouped by class)
    // If it’s binary, num_class=1 is typical in LightGBM, but staging is multiclass.
    return null;
  }

  class LGBMDumpModel {
    constructor(modelDump, options = {}) {
      if (!modelDump || !modelDump.tree_info) throw new Error("Invalid LightGBM dump_model JSON: missing tree_info");

      this.modelDump = modelDump;
      this.treeInfo = modelDump.tree_info;
      this.featureNames = options.featureNames || modelDump.feature_names || null;

      const nc = detectNumClass(modelDump);
      this.numClass = options.numClass || nc || 5; // YASA staging uses 5 classes
      this.classNames = options.classNames || ["W", "N1", "N2", "N3", "R"];

      // Optional raw score bias
      this.initScore = options.initScore || new Float64Array(this.numClass); // zeros
    }

    predictProba(X /* array of feature rows (Float64Array or Array) */) {
      const n = X.length;
      const out = new Array(n);

      // Multiclass in LightGBM: trees are typically ordered by class (mod numClass).
      for (let i = 0; i < n; i++) {
        const row = X[i];
        const scores = new Float64Array(this.numClass);
        for (let c = 0; c < this.numClass; c++) scores[c] = this.initScore[c] || 0;

        for (let t = 0; t < this.treeInfo.length; t++) {
          const tree = this.treeInfo[t];
          const cls = t % this.numClass;
          const val = evalTreeNode(tree.tree_structure, row);
          scores[cls] += val;
        }

        out[i] = softmaxRow(scores);
      }
      return out;
    }

    predict(X) {
      const prob = this.predictProba(X);
      const pred = new Array(prob.length);
      for (let i = 0; i < prob.length; i++) {
        let best = 0;
        let bestv = prob[i][0];
        for (let k = 1; k < prob[i].length; k++) {
          if (prob[i][k] > bestv) { bestv = prob[i][k]; best = k; }
        }
        pred[i] = this.classNames[best] || best;
      }
      return pred;
    }
  }

  window.YASA_LGBM = { LGBMDumpModel };
})();
