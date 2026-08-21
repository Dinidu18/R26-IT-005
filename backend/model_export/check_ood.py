"""
check_ood.py — Validates that your OOD artifacts are structurally consistent
before plugging them into the Flask app.

Checks:
  1. contamination_ood_config.json loads and has required keys
  2. All class_means vectors are the same length
  3. contamination_ood_precisions.npz loads and has a class_N entry
     for every class in class_means
  4. Each precision matrix is square and its dimension matches the
     corresponding class_means vector length
  5. No NaN/Inf values in means or precision matrices
  6. threshold = val_mean + 3*val_std sanity check (if those fields exist)

Usage:
    python check_ood.py
    python check_ood.py --config path/to/contamination_ood_config.json --precisions path/to/contamination_ood_precisions.npz
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config",
        default="model_export/contamination_ood_config.json",
        help="Path to contamination_ood_config.json",
    )
    parser.add_argument(
        "--precisions",
        default="model_export/contamination_ood_precisions.npz",
        help="Path to contamination_ood_precisions.npz",
    )
    args = parser.parse_args()

    config_path = Path(args.config)
    precisions_path = Path(args.precisions)

    errors = []
    warnings = []

    # ---- 1. Load config ----------------------------------------------
    if not config_path.exists():
        print(f"[FAIL] Config file not found: {config_path}")
        sys.exit(1)

    with open(config_path) as f:
        cfg = json.load(f)
    print(f"[OK] Loaded config: {config_path}")

    for key in ("threshold", "class_means"):
        if key not in cfg:
            errors.append(f"Missing required key in config: '{key}'")

    if errors:
        _report(errors, warnings)
        sys.exit(1)

    class_means = cfg["class_means"]
    print(f"[OK] Found {len(class_means)} classes in class_means: {sorted(class_means.keys())}")

    # ---- 2. Check class_means vector lengths are consistent -----------
    lengths = {k: len(v) for k, v in class_means.items()}
    unique_lengths = set(lengths.values())
    print(f"[INFO] class_means vector lengths: {lengths}")

    if len(unique_lengths) > 1:
        errors.append(
            f"class_means vectors have inconsistent lengths across classes: {lengths}"
        )
    else:
        feat_dim = unique_lengths.pop()
        print(f"[OK] All class_means vectors have consistent length: {feat_dim}")

    # ---- 3. Check for NaN/Inf in class_means ---------------------------
    for k, v in class_means.items():
        arr = np.array(v, dtype=np.float64)
        if not np.all(np.isfinite(arr)):
            errors.append(f"class_means['{k}'] contains NaN/Inf values")

    # ---- 4. Load precisions npz ----------------------------------------
    if not precisions_path.exists():
        print(f"[FAIL] Precisions file not found: {precisions_path}")
        _report(errors, warnings)
        sys.exit(1)

    npz = np.load(precisions_path)
    print(f"[OK] Loaded precisions: {precisions_path}")
    print(f"[INFO] Keys in npz: {list(npz.files)}")

    npz_class_ids = set()
    for key in npz.files:
        if key.startswith("class_"):
            npz_class_ids.add(key.replace("class_", ""))

    config_class_ids = set(class_means.keys())

    missing_in_npz = config_class_ids - npz_class_ids
    extra_in_npz = npz_class_ids - config_class_ids

    if missing_in_npz:
        errors.append(f"Classes in config but missing from npz: {missing_in_npz}")
    if extra_in_npz:
        warnings.append(f"Classes in npz but not in config: {extra_in_npz}")

    # ---- 5. Check each precision matrix shape ---------------------------
    for k, mean_vec in class_means.items():
        npz_key = f"class_{k}"
        if npz_key not in npz.files:
            continue  # already flagged above

        prec = npz[npz_key]
        expected_dim = len(mean_vec)

        print(f"[INFO] {npz_key}: shape={prec.shape}, expected=({expected_dim}, {expected_dim})")

        if prec.ndim != 2 or prec.shape[0] != prec.shape[1]:
            errors.append(f"{npz_key} is not a square matrix: shape={prec.shape}")
        elif prec.shape[0] != expected_dim:
            errors.append(
                f"{npz_key} dimension {prec.shape[0]} does not match "
                f"class_means['{k}'] length {expected_dim}"
            )

        if not np.all(np.isfinite(prec)):
            errors.append(f"{npz_key} contains NaN/Inf values")

        # Precision matrices should be symmetric (inverse of a covariance matrix)
        if prec.ndim == 2 and prec.shape[0] == prec.shape[1]:
            if not np.allclose(prec, prec.T, atol=1e-3):
                warnings.append(f"{npz_key} is not symmetric — may not be a valid precision matrix")

    # ---- 6. Threshold sanity check ---------------------------------------
    if all(k in cfg for k in ("val_mean", "val_std", "threshold")):
        expected_threshold = cfg["val_mean"] + 3 * cfg["val_std"]
        actual_threshold = cfg["threshold"]
        diff = abs(expected_threshold - actual_threshold)
        print(
            f"[INFO] threshold check: val_mean + 3*val_std = {expected_threshold:.6f}, "
            f"config threshold = {actual_threshold:.6f}, diff = {diff:.6f}"
        )
        if diff > 1e-3:
            warnings.append(
                f"threshold does not match val_mean + 3*val_std (diff={diff:.6f}) — "
                f"double check threshold_rule if it's supposed to be something else"
            )

    if cfg.get("num_val_samples", 0) and cfg["num_val_samples"] < 200:
        warnings.append(
            f"num_val_samples is only {cfg.get('num_val_samples')} — with high-dimensional "
            f"feature vectors this can make the threshold/covariance estimates noisy"
        )

    _report(errors, warnings)
    sys.exit(1 if errors else 0)


def _report(errors, warnings):
    print("\n" + "=" * 60)
    if warnings:
        print(f"WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"  ⚠ {w}")
    if errors:
        print(f"\nERRORS ({len(errors)}):")
        for e in errors:
            print(f"  ✗ {e}")
        print("\nResult: OOD artifacts are NOT structurally valid.")
    else:
        print("\nResult: OOD artifacts look structurally valid ✅")
    print("=" * 60)


if __name__ == "__main__":
    main()