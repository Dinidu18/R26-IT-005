"""
============================================================================
 Microscopic Aquatic Organisms — Detection + OOD Web Application
============================================================================
Flask web app that serves the YOLOv11 model trained in
`microscopic-aquatic-organisms-final.ipynb`.

It reproduces, in a deployable single file, EXACTLY what the notebook does
at inference time:

  1. Object detection            -> loaded from the exported ".pth" checkpoint
                                     (aquatic_best_full_checkpoint.pth), via
                                     ultralytics.YOLO
  2. Feature extraction for OOD  -> backbone sliced up to (and including) the
                                     SPPF layer + global average pool
                                     (same BackboneWithPool class as Cell 11)
  3. Out-of-Distribution check   -> per-class Mahalanobis distance vs. the
                                     class means/precision matrices fitted in
                                     Cell 12/13, compared to the threshold
                                     (val_mean + 3*val_std) computed in Cell 13

============================================================================
 REQUIRED ARTIFACTS
============================================================================
Place these files in MODEL_DIR (default: ./model_export next to this
script):

    aquatic_best_full_checkpoint.pth
    aquatic_label.json
    aquatic_ood_config.json
    aquatic_ood_precisions.npz

============================================================================
 INSTALL
============================================================================
    pip install flask ultralytics opencv-python-headless numpy torch

============================================================================
 RUN
============================================================================
    python aquatic.py
    # then open http://localhost:5002  (or whatever PORT you set)
============================================================================
"""

import os
import json
import base64
import shutil
import tempfile
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
from flask import Flask, request, render_template_string, jsonify

from ultralytics import YOLO

# ----------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------
BASE_DIR  = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("MODEL_DIR", BASE_DIR / "model_export"))

PTH_MODEL_PATH  = Path(os.environ.get("PTH_MODEL_PATH", MODEL_DIR / "aquatic_best_full_checkpoint.pth"))
LABEL_JSON_PATH = MODEL_DIR / "aquatic_label.json"
OOD_CONFIG_PATH = MODEL_DIR / "aquatic_ood_config.json"
OOD_PREC_PATH   = MODEL_DIR / "aquatic_ood_precisions.npz"

CONF_THRESH = float(os.environ.get("CONF_THRESH", 0.25))
IOU_THRESH  = float(os.environ.get("IOU_THRESH", 0.45))
DEVICE      = 0 if torch.cuda.is_available() else "cpu"

for required_path in [PTH_MODEL_PATH, LABEL_JSON_PATH, OOD_CONFIG_PATH, OOD_PREC_PATH]:
    if not required_path.exists():
        raise FileNotFoundError(
            f"Required model artifact not found: {required_path}\n"
            f"Copy the notebook's exported files into {MODEL_DIR} "
            f"(or set MODEL_DIR / PTH_MODEL_PATH env vars)."
        )

app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    """Minimal CORS support so a React dev server on a different origin/port
    (e.g. Vite on :5173) can call this API directly without extra deps."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/api/predict", methods=["OPTIONS"])
def api_predict_options():
    return "", 204


# ----------------------------------------------------------------------------
# Load class labels (Cell 15 output)
# ----------------------------------------------------------------------------
with open(LABEL_JSON_PATH) as f:
    label_data = json.load(f)

CLASSES     = label_data["classes"]
ID2NAME     = {int(k): v for k, v in label_data["id2name"].items()}
NUM_CLASSES = label_data["num_classes"]

# ----------------------------------------------------------------------------
# Load OOD config + precision matrices (Cell 16 output)
# ----------------------------------------------------------------------------
with open(OOD_CONFIG_PATH) as f:
    ood_cfg = json.load(f)

OOD_THRESHOLD = float(ood_cfg["threshold"])
IMG_SIZE      = int(ood_cfg["img_size"])
CLASS_MEANS   = {int(k): np.array(v, dtype=np.float32) for k, v in ood_cfg["class_means"].items()}

prec_npz = np.load(OOD_PREC_PATH)
CLASS_PRECISIONS = {
    int(k.replace("class_", "")): prec_npz[k]
    for k in prec_npz.files if k.startswith("class_")
}
# 'global' precision matrix is also saved by the notebook but the notebook's
# own inference cell (Cell 18) only ever uses the per-class min-Mahalanobis
# score, so we mirror that behaviour here rather than using the global one.

# ----------------------------------------------------------------------------
# Load the detection model FROM THE .pth CHECKPOINT
# ----------------------------------------------------------------------------
# IMPORTANT: Ultralytics' YOLO() loader branches on FILE EXTENSION, not file
# content, when deciding whether to actually parse a checkpoint. It only
# auto-loads suffixes it recognizes (".pt", ".yaml", etc). A ".pth" file is
# byte-for-byte the same pickle format as ".pt", but since the suffix isn't
# on its recognized list, YOLO() silently stores the STRING PATH in
# `self.model` instead of loading it — which is exactly what caused:
#     AttributeError: 'str' object has no attribute 'model'
# The fix: copy the checkpoint to a ".pt"-suffixed temp path once at startup
# and load THAT, so Ultralytics actually parses it. No retraining, no
# re-export needed — this only changes how the existing checkpoint is loaded.
if PTH_MODEL_PATH.suffix.lower() != ".pt":
    _tmp_pt_path = Path(tempfile.gettempdir()) / (PTH_MODEL_PATH.stem + ".pt")
    shutil.copy2(PTH_MODEL_PATH, _tmp_pt_path)
    _yolo_load_path = _tmp_pt_path
    print(f"[startup] Copied '{PTH_MODEL_PATH.name}' -> '{_tmp_pt_path}' "
          f"(Ultralytics only auto-loads .pt by extension).")
else:
    _yolo_load_path = PTH_MODEL_PATH

detector = YOLO(str(_yolo_load_path))

# ----------------------------------------------------------------------------
# Backbone feature extractor for Mahalanobis OOD (mirrors notebook Cell 11)
# ----------------------------------------------------------------------------
def find_sppf_index(yolo_model) -> int:
    for i, layer in enumerate(yolo_model.model.model):
        if layer.__class__.__name__ == "SPPF":
            return i
    raise RuntimeError(
        "SPPF layer not found in the loaded checkpoint's backbone — "
        "inspect yolo_model.model.model to find the correct backbone cutoff."
    )


class BackboneWithPool(nn.Module):
    """Slices the YOLO backbone up to (and including) SPPF, then applies
    global average pooling to produce a fixed-size feature vector.
    Used ONLY for OOD scoring, never for detection itself — identical to
    the notebook's Cell 11 class of the same name."""

    def __init__(self, yolo_model, cutoff: int):
        super().__init__()
        self.backbone = yolo_model.model.model[:cutoff]
        self.pool = nn.AdaptiveAvgPool2d((1, 1))

    def forward(self, x):
        for layer in self.backbone:
            x = layer(x)
        x = self.pool(x)
        return x.flatten(1)  # (B, C)


_sppf_idx = find_sppf_index(detector)
feature_extractor = BackboneWithPool(detector, _sppf_idx + 1).eval()
if torch.cuda.is_available():
    feature_extractor = feature_extractor.cuda()

print(f"[startup] SPPF layer found at index {_sppf_idx} -> "
      f"using layers [0:{_sppf_idx + 1}] as the OOD feature backbone.")

# ----------------------------------------------------------------------------
# Pre-processing (mirrors notebook Cell 18's `preprocess`)
# ----------------------------------------------------------------------------
def preprocess_bgr(image_bgr: np.ndarray, size: int) -> torch.Tensor:
    img = cv2.resize(image_bgr, (size, size))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    tensor = img.astype(np.float32) / 255.0
    tensor = np.transpose(tensor, (2, 0, 1))[np.newaxis]
    t = torch.from_numpy(tensor)
    if torch.cuda.is_available():
        t = t.cuda()
    return t


# ----------------------------------------------------------------------------
# Mahalanobis OOD scoring (mirrors notebook Cells 12-14/18)
# ----------------------------------------------------------------------------
def mahalanobis_score(feat: np.ndarray, mu: np.ndarray, prec: np.ndarray) -> float:
    diff = feat - mu
    return float(np.sqrt(np.clip(diff @ prec @ diff, 0, None)))


def min_class_mahalanobis(feat: np.ndarray) -> float:
    return min(
        mahalanobis_score(feat, CLASS_MEANS[c], CLASS_PRECISIONS[c])
        for c in CLASS_MEANS
    )


@torch.no_grad()
def extract_feature(image_bgr: np.ndarray) -> np.ndarray:
    tensor = preprocess_bgr(image_bgr, IMG_SIZE)
    feat = feature_extractor(tensor)
    return feat.cpu().numpy()[0]


# ----------------------------------------------------------------------------
# Full inference: detection + OOD (mirrors notebook Cell 18's `run_inference`)
# ----------------------------------------------------------------------------
def run_inference(image_bgr: np.ndarray) -> dict:
    orig_h, orig_w = image_bgr.shape[:2]

    # --- detection, run directly through the loaded .pth model ---
    results = detector.predict(
        image_bgr, conf=CONF_THRESH, iou=IOU_THRESH, verbose=False, device=DEVICE
    )[0]

    detections = []
    if results.boxes is not None and len(results.boxes):
        boxes   = results.boxes.xyxy.cpu().numpy()
        scores  = results.boxes.conf.cpu().numpy()
        cls_ids = results.boxes.cls.cpu().numpy().astype(int)
        for box, score, cid in zip(boxes, scores, cls_ids):
            detections.append({
                "class_id":   int(cid),
                "class_name": ID2NAME.get(int(cid), "unknown"),
                "confidence": float(score),
                "bbox_xyxy":  [float(v) for v in box],
            })

    # --- OOD scoring via Mahalanobis distance on backbone features ---
    feat      = extract_feature(image_bgr)
    maha_dist = min_class_mahalanobis(feat)
    is_ood    = maha_dist > OOD_THRESHOLD

    return {
        "image_size":       (orig_w, orig_h),
        "detections":       detections,
        "num_detections":   len(detections),
        "mahalanobis_dist": round(maha_dist, 4),
        "ood_threshold":    round(OOD_THRESHOLD, 4),
        "is_ood":           bool(is_ood),
        "ood_status":       "OUT-OF-DISTRIBUTION" if is_ood else "IN-DISTRIBUTION",
        "ood_enabled":      True,
    }


# ----------------------------------------------------------------------------
# Draw bounding boxes + OOD banner on the image (for display in the browser)
# ----------------------------------------------------------------------------
_PALETTE_BGR = [
    (71, 99, 255), (255, 144, 30), (113, 179, 60), (238, 130, 238),
    (0, 215, 255), (209, 206, 0), (180, 105, 255), (50, 205, 154),
]


def annotate_image(image_bgr: np.ndarray, result: dict) -> np.ndarray:
    img = image_bgr.copy()
    for d in result["detections"]:
        x1, y1, x2, y2 = [int(v) for v in d["bbox_xyxy"]]
        color = _PALETTE_BGR[d["class_id"] % len(_PALETTE_BGR)]
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)

        label = f"{d['class_name']} {d['confidence']:.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(img, (x1, max(0, y1 - th - 8)), (x1 + tw + 4, y1), color, -1)
        cv2.putText(img, label, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, (255, 255, 255), 1, cv2.LINE_AA)

    banner_color = (60, 60, 231) if result["is_ood"] else (113, 179, 60)  # BGR
    banner_text = (f"{result['ood_status']} | Mahalanobis={result['mahalanobis_dist']} "
                   f"(threshold={result['ood_threshold']})")
    cv2.rectangle(img, (0, 0), (img.shape[1], 30), banner_color, -1)
    cv2.putText(img, banner_text, (8, 20), cv2.FONT_HERSHEY_SIMPLEX,
                0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def image_to_base64_png(image_bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image_bgr)
    if not ok:
        raise RuntimeError("Failed to encode result image.")
    return base64.b64encode(buf.tobytes()).decode("utf-8")


# ----------------------------------------------------------------------------
# HTML template (single-file app — no separate templates/ folder needed)
# ----------------------------------------------------------------------------
PAGE_TEMPLATE = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Microscopic Aquatic Organisms Detector</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #222; }
    h1 { color: #1a3c6e; }
    .upload-box { border: 2px dashed #90a4bd; padding: 24px; border-radius: 8px; text-align: center; }
    .result-img { max-width: 100%; margin-top: 20px; border: 1px solid #ddd; border-radius: 6px; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #1a3c6e; color: white; }
    .ood-badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-weight: bold; color: white; }
    .ood-yes { background: #e74c3c; }
    .ood-no  { background: #27ae60; }
    button { background: #1a3c6e; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
    button:hover { background: #274d85; }
  </style>
</head>
<body>
  <h1>Microscopic Aquatic Organisms Detector</h1>
  <p>Upload a microscope image to detect organisms and check whether the image
     is in-distribution for the trained model (Mahalanobis-distance OOD check).</p>

  <div class="upload-box">
    <form method="POST" action="/predict" enctype="multipart/form-data">
      <input type="file" name="image" accept="image/*" required>
      <br><br>
      <button type="submit">Run Detection</button>
    </form>
  </div>

  {% if result %}
    <h2>Result</h2>
    <p>
      OOD status:
      <span class="ood-badge {{ 'ood-yes' if result.is_ood else 'ood-no' }}">
        {{ result.ood_status }}
      </span>
      &nbsp; Mahalanobis distance: {{ result.mahalanobis_dist }}
      (threshold: {{ result.ood_threshold }})
    </p>
    <img class="result-img" src="data:image/png;base64,{{ img_b64 }}">

    <table>
      <tr><th>#</th><th>Class</th><th>Confidence</th><th>BBox (x1, y1, x2, y2)</th></tr>
      {% for d in result.detections %}
      <tr>
        <td>{{ loop.index }}</td>
        <td>{{ d.class_name }}</td>
        <td>{{ "%.3f"|format(d.confidence) }}</td>
        <td>{{ d.bbox_xyxy|join(', ') }}</td>
      </tr>
      {% endfor %}
    </table>
    {% if result.num_detections == 0 %}
      <p><em>No detections above the confidence threshold.</em></p>
    {% endif %}
  {% endif %}
</body>
</html>
"""


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------
@app.route("/", methods=["GET"])
def index():
    return render_template_string(PAGE_TEMPLATE, result=None)


@app.route("/predict", methods=["POST"])
def predict():
    """HTML form endpoint — renders the annotated image + detection table."""
    if "image" not in request.files:
        return jsonify({"error": "No image file uploaded."}), 400

    file = request.files["image"]
    file_bytes = np.frombuffer(file.read(), dtype=np.uint8)
    image_bgr = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    if image_bgr is None:
        return jsonify({"error": "Could not decode uploaded image."}), 400

    result = run_inference(image_bgr)
    annotated = annotate_image(image_bgr, result)
    img_b64 = image_to_base64_png(annotated)

    return render_template_string(PAGE_TEMPLATE, result=result, img_b64=img_b64)


@app.route("/api/predict", methods=["POST"])
def api_predict():
    """Pure JSON API endpoint (no HTML) for programmatic / React clients.
    Includes the annotated (boxes + OOD banner) image as base64 PNG so the
    frontend can render it directly without re-implementing the drawing
    logic in JS."""
    if "image" not in request.files:
        return jsonify({"error": "No image file uploaded."}), 400

    file = request.files["image"]
    file_bytes = np.frombuffer(file.read(), dtype=np.uint8)
    image_bgr = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    if image_bgr is None:
        return jsonify({"error": "Could not decode uploaded image."}), 400

    result = run_inference(image_bgr)
    annotated = annotate_image(image_bgr, result)
    result["annotated_image_base64"] = image_to_base64_png(annotated)
    return jsonify(result)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "num_classes": NUM_CLASSES,
        "img_size": IMG_SIZE,
        "ood_threshold": OOD_THRESHOLD,
        "device": str(DEVICE),
    })


if __name__ == "__main__":
    print(f"[startup] Loaded {NUM_CLASSES} classes: {CLASSES}")
    print(f"[startup] OOD threshold: {OOD_THRESHOLD:.4f}  (img_size={IMG_SIZE})")
    print(f"[startup] Detection model: {PTH_MODEL_PATH}")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5002)), debug=False)