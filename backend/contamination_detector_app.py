"""
Water Contamination Detector - Flask Web Application
======================================================
Serves your trained YOLOv11 checkpoint (bare state_dict .pth exported from
the notebook) behind a simple web UI + JSON API for image upload and object
detection.

If the extra artifacts produced by the notebook are also present next to
the model (contamination_feature_extractor.onnx, contamination_ood_config.json,
contamination_ood_precisions.npz), the app will automatically enable
Mahalanobis-based Out-of-Distribution (OOD) scoring on every uploaded image.
If those files are missing, the app still runs fine - it just skips the OOD step.

--------------------------------------------------------------------------
SETUP
--------------------------------------------------------------------------
1) Install dependencies:
       pip install flask flask-cors ultralytics opencv-python-headless numpy \
                   onnxruntime werkzeug torch

2) Expected files inside ./model_export/ (relative to this file):
       contamination_best_state_dict.pth   (required - bare state_dict)
       contamination_label.json            (optional - class id -> name mapping)
       contamination_feature_extractor.onnx (optional - enables OOD detection)
       contamination_ood_config.json       (optional - enables OOD detection)
       contamination_ood_precisions.npz    (optional - enables OOD detection)

3) Run:
       python contamination_detector_app.py

4) Open http://localhost:5000 in your browser, or POST an image to
       http://localhost:5000/api/predict   (multipart/form-data, field "image")
--------------------------------------------------------------------------
"""

import os
import json
import base64
import logging
from pathlib import Path

import cv2
import numpy as np
import torch
from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS
from werkzeug.utils import secure_filename

from ultralytics import YOLO
from ultralytics.nn.tasks import DetectionModel

try:
    import onnxruntime as ort
except ImportError:
    ort = None  # OOD detection will simply be disabled if this isn't installed


# ==========================================================================
# Quiet down Ultralytics' internal logging (keeps our own [app] logs visible)
# ==========================================================================
logging.getLogger("ultralytics").setLevel(logging.ERROR)


# ==========================================================================
# Configuration
# ==========================================================================
BASE_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = Path(os.environ.get("ARTIFACT_DIR", BASE_DIR / "model_export"))
MODEL_PATH = Path(os.environ.get("MODEL_PATH", ARTIFACT_DIR / "contamination_best_state_dict.pth"))

LABEL_JSON_PATH = Path(os.environ.get("LABEL_JSON_PATH", ARTIFACT_DIR / "contamination_label.json"))
FEATURE_EXTRACTOR_PATH = Path(os.environ.get("FEATURE_EXTRACTOR_PATH", ARTIFACT_DIR / "contamination_feature_extractor.onnx"))
OOD_CONFIG_PATH = Path(os.environ.get("OOD_CONFIG_PATH", ARTIFACT_DIR / "contamination_ood_config.json"))
OOD_PRECISIONS_PATH = Path(os.environ.get("OOD_PRECISIONS_PATH", ARTIFACT_DIR / "contamination_ood_precisions.npz"))

# Base architecture used during training (n/s/m/l/x). Override via env var
# if this ever needs to change without editing code.
YOLO_ARCH_YAML = os.environ.get("YOLO_ARCH_YAML", "yolo11m.yaml")

# Frontend origin(s) allowed to call this API (CRA/Vite dev servers etc.)
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "bmp", "webp"}
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", 0.25))
IOU_THRESHOLD = float(os.environ.get("IOU_THRESHOLD", 0.45))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", 16))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

CORS(app, resources={
    r"/api/*": {"origins": CORS_ORIGINS},
    r"/health": {"origins": CORS_ORIGINS},
})


# ==========================================================================
# Load the detection model from the bare state_dict checkpoint
# ==========================================================================
def _unwrap_state_dict(raw) -> dict:
    """Handles a few common ways a state_dict can be wrapped when saved."""
    if isinstance(raw, dict) and "state_dict" in raw:
        return raw["state_dict"]
    if isinstance(raw, dict) and "model" in raw and not any(
        k.startswith("model.") for k in raw.keys()
    ):
        return raw["model"]
    return raw


def _infer_num_classes(state_dict: dict) -> int:
    """Reads the detection head's output channel count directly from the
    checkpoint, so we don't have to hardcode or guess the class count."""
    for key in (
        "model.23.cv3.0.2.weight",
        "model.23.cv3.1.2.weight",
        "model.23.cv3.2.2.weight",
    ):
        if key in state_dict:
            return state_dict[key].shape[0]
    raise RuntimeError(
        "Could not infer num_classes from checkpoint - detection head key "
        "names don't match the expected YOLOv11 layout. Check the checkpoint "
        "or update _infer_num_classes()."
    )


def load_detector(model_path: Path) -> YOLO:
    """
    Loads a bare state_dict checkpoint (e.g. contamination_best_state_dict.pth,
    saved via torch.save(model.state_dict())) into a freshly-built YOLO model
    of the same architecture and class count used during training.
    """
    if not model_path.exists():
        raise FileNotFoundError(
            f"Model file not found at '{model_path}'.\n"
            f"Set the MODEL_PATH environment variable to point at your .pth "
            f"checkpoint, or place it at {model_path}."
        )
    print(f"[app] Loading detection model (state_dict) from: {model_path}")

    raw = torch.load(model_path, map_location="cpu")
    state_dict = _unwrap_state_dict(raw)

    num_classes = _infer_num_classes(state_dict)
    print(f"[app] Detected {num_classes} classes from checkpoint head shape")

    # Build the architecture fresh with the CORRECT number of classes,
    # instead of loading a .pt (which comes pretrained for 80 COCO classes).
    base = YOLO(YOLO_ARCH_YAML)
    base.model = DetectionModel(YOLO_ARCH_YAML, nc=num_classes, verbose=False)
    base.model.load_state_dict(state_dict)
    base.model.eval()

    print(f"[app] Model loaded successfully ({YOLO_ARCH_YAML}, nc={num_classes})")
    return base


detector = load_detector(MODEL_PATH)
CLASS_NAMES = dict(detector.names)  # {id: name}, from the model config

# Prefer label.json if available - keeps names 100% consistent with the
# training pipeline (drops/merges applied in the notebook).
if LABEL_JSON_PATH.exists():
    try:
        with open(LABEL_JSON_PATH) as f:
            label_data = json.load(f)
        CLASS_NAMES = {int(k): v for k, v in label_data["id2name"].items()}
        print(f"[app] Loaded class names from {LABEL_JSON_PATH}")
    except Exception as e:
        print(f"[app] Could not read label.json, falling back to model.names: {e}")

print(f"[app] Classes ({len(CLASS_NAMES)}): {CLASS_NAMES}")


# ==========================================================================
# Optional: Mahalanobis OOD detector (only enabled if all artifacts exist)
# ==========================================================================
OOD_ENABLED = False
feat_session = None
ood_threshold = None
ood_img_size = 640
class_means, class_covs = {}, {}

def _try_init_ood():
    global OOD_ENABLED, feat_session, ood_threshold, ood_img_size, class_means, class_covs

    if ort is None:
        print("[app] onnxruntime not installed - OOD detection disabled.")
        return
    if not (FEATURE_EXTRACTOR_PATH.exists() and OOD_CONFIG_PATH.exists() and OOD_PRECISIONS_PATH.exists()):
        print("[app] OOD artifact files not found - OOD detection disabled.")
        return

    try:
        with open(OOD_CONFIG_PATH) as f:
            ood_cfg = json.load(f)
        ood_threshold = float(ood_cfg["threshold"])
        ood_img_size = int(ood_cfg.get("img_size", 640))
        class_means = {int(k): np.array(v, dtype=np.float32) for k, v in ood_cfg["class_means"].items()}

        prec_npz = np.load(OOD_PRECISIONS_PATH)
        class_covs = {
            int(k.replace("class_", "")): prec_npz[k]
            for k in prec_npz.files if k.startswith("class_")
        }

        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        feat_session = ort.InferenceSession(str(FEATURE_EXTRACTOR_PATH), providers=providers)
        OOD_ENABLED = True
        print(f"[app] OOD detection enabled (threshold={ood_threshold:.4f}).")
    except Exception as e:
        print(f"[app] Failed to initialize OOD detector - continuing without it: {e}")


_try_init_ood()


def mahalanobis_score(feat: np.ndarray, mu: np.ndarray, prec: np.ndarray) -> float:
    diff = feat - mu
    return float(np.sqrt(np.clip(diff @ prec @ diff, 0, None)))


def min_class_mahalanobis(feat: np.ndarray) -> float:
    return min(mahalanobis_score(feat, class_means[c], class_covs[c]) for c in class_means)


def compute_ood(image_bgr: np.ndarray) -> dict:
    if not OOD_ENABLED:
        return {"ood_enabled": False}

    img = cv2.resize(image_bgr, (ood_img_size, ood_img_size))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    tensor = (img.astype(np.float32) / 255.0).transpose(2, 0, 1)[np.newaxis]

    input_name = feat_session.get_inputs()[0].name
    feat = feat_session.run(None, {input_name: tensor})[0][0]
    maha = min_class_mahalanobis(feat)
    is_ood = maha > ood_threshold

    return {
        "ood_enabled": True,
        "mahalanobis_dist": round(maha, 4),
        "ood_threshold": round(ood_threshold, 4),
        "is_ood": bool(is_ood),
        "ood_status": "OUT-OF-DISTRIBUTION" if is_ood else "IN-DISTRIBUTION",
    }


# ==========================================================================
# Detection + drawing helpers
# ==========================================================================
def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


_PALETTE = [
    (231, 76, 60), (52, 152, 219), (46, 204, 113), (241, 196, 15),
    (155, 89, 182), (26, 188, 156), (230, 126, 34), (149, 165, 166),
    (52, 73, 94), (211, 84, 0),
]


def class_color(class_id: int):
    return _PALETTE[class_id % len(_PALETTE)]


def run_detection(image_bgr: np.ndarray) -> list:
    results = detector.predict(
        image_bgr, conf=CONF_THRESHOLD, iou=IOU_THRESHOLD, verbose=False
    )[0]

    detections = []
    if results.boxes is not None and len(results.boxes) > 0:
        boxes = results.boxes.xyxy.cpu().numpy()
        confs = results.boxes.conf.cpu().numpy()
        cls_ids = results.boxes.cls.cpu().numpy().astype(int)
        for box, conf, cid in zip(boxes, confs, cls_ids):
            detections.append({
                "class_id": int(cid),
                "class_name": CLASS_NAMES.get(int(cid), str(cid)),
                "confidence": round(float(conf), 4),
                "bbox_xyxy": [round(float(v), 2) for v in box],
            })
    return detections


def draw_detections(image_bgr: np.ndarray, detections: list) -> np.ndarray:
    out = image_bgr.copy()
    for d in detections:
        x1, y1, x2, y2 = [int(round(v)) for v in d["bbox_xyxy"]]
        color = class_color(d["class_id"])
        label = f"{d['class_name']} {d['confidence']:.2f}"

        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        ty = max(0, y1 - th - 8)
        cv2.rectangle(out, (x1, ty), (x1 + tw + 6, ty + th + 8), color, -1)
        cv2.putText(out, label, (x1 + 3, ty + th + 2),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def encode_image_base64(image_bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".jpg", image_bgr)
    if not ok:
        raise RuntimeError("Failed to encode annotated image")
    return base64.b64encode(buf).decode("utf-8")


def decode_upload(file_storage) -> np.ndarray:
    file_bytes = np.frombuffer(file_storage.read(), np.uint8)
    image_bgr = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    return image_bgr


# ==========================================================================
# Web UI (single page, no external template files needed)
# ==========================================================================
INDEX_HTML = """
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Water Contamination Detector</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    max-width: 960px; margin: 0 auto; padding: 24px 16px 64px;
    background: #0f1720; color: #e6edf3;
  }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  p.sub { color: #9fb0c0; margin-top: 0; }
  .card {
    background: #161f2c; border: 1px solid #24313f; border-radius: 12px;
    padding: 20px; margin-top: 20px;
  }
  #dropzone {
    border: 2px dashed #35485c; border-radius: 12px; padding: 40px 20px;
    text-align: center; cursor: pointer; transition: border-color .15s;
  }
  #dropzone.hover { border-color: #4da3ff; }
  #dropzone p { margin: 6px 0; color: #9fb0c0; }
  input[type=file] { display: none; }
  button {
    background: #2f81f7; color: white; border: none; border-radius: 8px;
    padding: 10px 18px; font-size: 0.95rem; cursor: pointer; margin-top: 12px;
  }
  button:disabled { background: #3a4a5a; cursor: not-allowed; }
  #preview { max-width: 100%; border-radius: 8px; margin-top: 12px; display: none; }
  #result-img { max-width: 100%; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.9rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #24313f; }
  th { color: #9fb0c0; font-weight: 600; }
  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    font-size: 0.8rem; font-weight: 600;
  }
  .badge.ood { background: #4a1f1f; color: #ff8a80; }
  .badge.ind { background: #1f3a25; color: #7be08a; }
  .badge.off { background: #2a2f36; color: #9fb0c0; }
  #status { color: #9fb0c0; margin-top: 10px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
</style>
</head>
<body>
  <h1>🌊 Water Contamination Detector</h1>
  <p class="sub">Upload an image to run the trained YOLOv11 model{{ ' + Mahalanobis OOD check' if ood_enabled else '' }}.</p>

  <div class="card">
    <div id="dropzone">
      <p><strong>Click to choose an image</strong> or drag &amp; drop it here</p>
      <p>JPG, PNG, BMP, WEBP - up to {{ max_upload_mb }} MB</p>
      <input type="file" id="fileInput" accept="image/*">
    </div>
    <img id="preview" alt="preview">
    <div>
      <button id="predictBtn" disabled>Run Detection</button>
    </div>
    <div id="status"></div>
  </div>

  <div class="card" id="resultCard" style="display:none;">
    <h3 style="margin-top:0;">Result</h3>
    <div id="oodBadgeWrap"></div>
    <img id="result-img" alt="result">
    <table id="detTable">
      <thead><tr><th>#</th><th>Class</th><th>Confidence</th><th>BBox (x1, y1, x2, y2)</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

<script>
const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('fileInput');
const preview    = document.getElementById('preview');
const predictBtn = document.getElementById('predictBtn');
const statusEl   = document.getElementById('status');
const resultCard = document.getElementById('resultCard');
const resultImg  = document.getElementById('result-img');
const detTableBody = document.querySelector('#detTable tbody');
const oodBadgeWrap  = document.getElementById('oodBadgeWrap');

let selectedFile = null;

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('hover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('hover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('hover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

function handleFile(file) {
  selectedFile = file;
  const url = URL.createObjectURL(file);
  preview.src = url;
  preview.style.display = 'block';
  predictBtn.disabled = false;
  statusEl.textContent = '';
  resultCard.style.display = 'none';
}

predictBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  predictBtn.disabled = true;
  statusEl.textContent = 'Running inference...';

  const formData = new FormData();
  formData.append('image', selectedFile);

  try {
    const res = await fetch('/api/predict', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Prediction failed');

    resultImg.src = 'data:image/jpeg;base64,' + data.annotated_image_base64;
    detTableBody.innerHTML = '';
    data.detections.forEach((d, i) => {
      const tr = document.createElement('tr');
      const bbox = d.bbox_xyxy.map(v => v.toFixed(1)).join(', ');
      tr.innerHTML = `<td>${i+1}</td><td>${d.class_name}</td><td>${d.confidence.toFixed(3)}</td><td>${bbox}</td>`;
      detTableBody.appendChild(tr);
    });

    oodBadgeWrap.innerHTML = '';
    if (data.ood_enabled) {
      const span = document.createElement('span');
      span.className = 'badge ' + (data.is_ood ? 'ood' : 'ind');
      span.textContent = (data.is_ood ? 'OUT-OF-DISTRIBUTION' : 'IN-DISTRIBUTION') +
                          `  |  Mahalanobis=${data.mahalanobis_dist}  (threshold=${data.ood_threshold})`;
      oodBadgeWrap.appendChild(span);
    } else {
      const span = document.createElement('span');
      span.className = 'badge off';
      span.textContent = 'OOD detection not configured';
      oodBadgeWrap.appendChild(span);
    }

    resultCard.style.display = 'block';
    statusEl.textContent = `Found ${data.num_detections} detection(s).`;
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  } finally {
    predictBtn.disabled = false;
  }
});
</script>
</body>
</html>
"""


# ==========================================================================
# Routes
# ==========================================================================
@app.route("/", methods=["GET"])
def index():
    return render_template_string(
        INDEX_HTML, ood_enabled=OOD_ENABLED, max_upload_mb=MAX_UPLOAD_MB
    )


@app.route("/api/predict", methods=["POST"])
def api_predict():
    if "image" not in request.files:
        return jsonify({"error": "No 'image' file part in request"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": f"Unsupported file type. Allowed: {sorted(ALLOWED_EXTENSIONS)}"}), 400

    filename = secure_filename(file.filename)

    try:
        image_bgr = decode_upload(file)
    except Exception as e:
        return jsonify({"error": f"Could not read image: {e}"}), 400

    if image_bgr is None:
        return jsonify({"error": "Could not decode image (unsupported/corrupt file)"}), 400

    detections = run_detection(image_bgr)
    ood_result = compute_ood(image_bgr)

    annotated = draw_detections(image_bgr, detections)
    annotated_b64 = encode_image_base64(annotated)

    response = {
        "filename": filename,
        "image_size": {"width": int(image_bgr.shape[1]), "height": int(image_bgr.shape[0])},
        "num_detections": len(detections),
        "detections": detections,
        "annotated_image_base64": annotated_b64,
    }
    response.update(ood_result)
    return jsonify(response)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model_path": str(MODEL_PATH),
        "num_classes": len(CLASS_NAMES),
        "classes": CLASS_NAMES,
        "ood_enabled": OOD_ENABLED,
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)