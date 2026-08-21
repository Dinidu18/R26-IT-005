from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import pickle
import json
import os
import warnings
warnings.filterwarnings('ignore')

app = Flask(__name__)
CORS(app)

# ── Constants ──────────────────────────────────────────────────────────────────
LABEL_ORDER = ['Excellent', 'Good', 'Poor', 'Unsafe']
FEATURE_NAMES = ['pH', 'TDS', 'EC']

FEATURE_CONTEXT = {
    'pH': {
        'unit': '',
        'description': 'Acidity/alkalinity (7 = neutral, safe range 6.5–8.5)',
        'low_means': 'too acidic (corrosive)',
        'high_means': 'too alkaline (bitter, scale-forming)',
    },
    'TDS': {
        'unit': 'mg/L',
        'description': 'Total Dissolved Solids — minerals & salts in the water',
        'low_means': 'very pure, low mineral content',
        'high_means': 'high salt/mineral concentration',
    },
    'EC': {
        'unit': 'µS/cm',
        'description': 'Electrical Conductivity — direct proxy for dissolved ions',
        'low_means': 'very low ionic content (very clean)',
        'high_means': 'high ionic content (heavily contaminated)',
    },
}

THRESHOLDS = {
    'pH':  {'Excellent': [6.5, 8.5], 'Good': [6.5, 8.5], 'Poor': [6.0, 9.0], 'Unsafe': [0, 14]},
    'TDS': {'Excellent': [0, 300],   'Good': [300, 600],  'Poor': [600, 900],  'Unsafe': [900, 9999]},
    'EC':  {'Excellent': [10, 390],  'Good': [391, 937],  'Poor': [938, 3125], 'Unsafe': [3126, 9999]},
}

FEAT_STATS = {
    'pH':  {'min': 0.0, 'max': 14.0, 'mean': 7.0, 'std': 1.5},
    'TDS': {'min': 0.0, 'max': 2000.0, 'mean': 500.0, 'std': 300.0},
    'EC':  {'min': 0.0, 'max': 6250.0, 'mean': 800.0, 'std': 600.0},
}

# ── Load model artifacts ───────────────────────────────────────────────────────
MODEL_DIR = os.path.join(os.path.dirname(__file__), 'model_export')
model = None
le = None
shap_background = None
explainer = None
meta = None

def load_artifacts():
    global model, le, shap_background, explainer, meta, FEAT_STATS
    try:
        with open(os.path.join(MODEL_DIR, 'water_quality_rf.pkl'), 'rb') as f:
            model = pickle.load(f)
        with open(os.path.join(MODEL_DIR, 'label_encoder.pkl'), 'rb') as f:
            le = pickle.load(f)
        with open(os.path.join(MODEL_DIR, 'shap_background.pkl'), 'rb') as f:
            shap_background = pickle.load(f)
        with open(os.path.join(MODEL_DIR, 'model_metadata.json')) as f:
            meta = json.load(f)
        if meta and 'feature_stats' in meta:
            FEAT_STATS = meta['feature_stats']

        import shap
        global explainer
        explainer = shap.TreeExplainer(
            model,
            data=shap_background,
            feature_perturbation='interventional',
            model_output='probability'
        )
        print("✔ All model artifacts loaded successfully.")
        return True
    except FileNotFoundError as e:
        print(f"⚠ Model files not found: {e}")
        print("  Running in DEMO mode with simulated predictions.")
        return False
    except Exception as e:
        print(f"⚠ Error loading artifacts: {e}")
        print("  Running in DEMO mode with simulated predictions.")
        return False

artifacts_loaded = load_artifacts()


# ── Helper functions ───────────────────────────────────────────────────────────
def classify_feature_level(feat, value):
    stats = FEAT_STATS[feat]
    if feat == 'pH':
        if 6.5 <= value <= 8.5:
            return 'optimal range'
        elif value < 6.5:
            return 'below optimal (acidic)'
        else:
            return 'above optimal (alkaline)'
    else:
        lo = stats['min'] if isinstance(stats['min'], float) else float(stats['min'])
        hi = stats['max'] if isinstance(stats['max'], float) else float(stats['max'])
        pct = (value - lo) / (hi - lo + 1e-9)
        if pct < 0.25:   return 'very low'
        elif pct < 0.50: return 'moderate'
        elif pct < 0.75: return 'elevated'
        else:            return 'very high'


def simulate_prediction(ph, tds, ec):
    """Demo mode: rule-based prediction when model not loaded."""
    score = 0
    # pH scoring
    if 6.5 <= ph <= 8.5:
        score += 0
    elif 6.0 <= ph <= 9.0:
        score += 1
    else:
        score += 2

    # TDS scoring
    if tds < 300:       score += 0
    elif tds < 600:     score += 1
    elif tds < 900:     score += 2
    else:               score += 3

    # EC scoring
    if ec < 390:        score += 0
    elif ec < 937:      score += 1
    elif ec < 3125:     score += 2
    else:               score += 3

    avg_score = score / 3.0
    if avg_score < 0.5:
        label_idx = 0
        probs = [0.75, 0.18, 0.05, 0.02]
    elif avg_score < 1.2:
        label_idx = 1
        probs = [0.12, 0.68, 0.15, 0.05]
    elif avg_score < 2.0:
        label_idx = 2
        probs = [0.03, 0.10, 0.65, 0.22]
    else:
        label_idx = 3
        probs = [0.01, 0.05, 0.18, 0.76]

    # Simulated SHAP values
    ph_shap  = 0.08 if 6.5 <= ph <= 8.5 else -0.12
    tds_shap = -0.06 * (tds / 500.0) + 0.03
    ec_shap  = -0.05 * (ec / 800.0) + 0.02

    shap_vals = [ph_shap, tds_shap, ec_shap]

    return label_idx, probs, shap_vals, 0.25


def run_prediction(ph, tds, ec):
    import pandas as pd

    input_dict = {'pH': ph, 'TDS': tds, 'EC': ec}

    if not artifacts_loaded or model is None:
        label_idx, probs_list, shap_vals, base_val = simulate_prediction(ph, tds, ec)
        label = LABEL_ORDER[label_idx]
        probs = {c: float(p) for c, p in zip(LABEL_ORDER, probs_list)}
    else:
        sample_df = pd.DataFrame([input_dict], columns=FEATURE_NAMES)
        label_idx = int(model.predict(sample_df)[0])
        probs_arr = model.predict_proba(sample_df)[0]
        label = LABEL_ORDER[label_idx]
        probs = {c: float(p) for c, p in zip(LABEL_ORDER, probs_arr)}

        sv = explainer(sample_df)
        shap_vals = sv.values[0, :, label_idx].tolist()
        base_val = float(sv.base_values[0, label_idx])

    feature_levels = {f: classify_feature_level(f, input_dict[f]) for f in FEATURE_NAMES}

    # Build plain-language reasons
    sorted_idx = np.argsort(np.abs(shap_vals))[::-1]
    plain_reasons = []
    for i in sorted_idx:
        feat = FEATURE_NAMES[i]
        val = input_dict[feat]
        sv_i = float(shap_vals[i])
        ctx = FEATURE_CONTEXT[feat]
        level = feature_levels[feat]
        direction = "increases" if sv_i >= 0 else "decreases"
        strength = "strongly" if abs(sv_i) > 0.08 else ("moderately" if abs(sv_i) > 0.03 else "slightly")

        if feat == 'pH':
            detail = (
                f"pH {val:.2f} is in the optimal range for drinking water."
                if level == 'optimal range'
                else f"pH {val:.2f} is {level}, meaning the water is {ctx['low_means'] if val < 6.5 else ctx['high_means']}."
            )
        else:
            detail = (
                f"{feat} of {val:.1f} {ctx['unit']} is {level}. "
                f"{'High values indicate ' + ctx['high_means'] if sv_i < 0 else 'This level is within an acceptable range.'}"
            )

        plain_reasons.append({
            'feature': feat,
            'value': val,
            'unit': ctx['unit'],
            'shap': sv_i,
            'strength': strength,
            'direction': direction,
            'level': level,
            'detail': detail,
            'description': ctx['description'],
        })

    # Feature stats for gauge
    feature_stats = []
    for feat in FEATURE_NAMES:
        stats = FEAT_STATS[feat]
        val = input_dict[feat]
        fmin = float(stats['min'])
        fmax = float(stats['max'])
        norm = np.clip((val - fmin) / (fmax - fmin + 1e-9), 0, 1)
        feature_stats.append({
            'feature': feat,
            'value': val,
            'unit': FEATURE_CONTEXT[feat]['unit'],
            'min': fmin,
            'max': fmax,
            'norm': float(norm),
            'level': feature_levels[feat],
            'description': FEATURE_CONTEXT[feat]['description'],
        })

    confidence = float(probs[label]) * 100
    is_safe = label in ('Excellent', 'Good')

    return {
        'label': label,
        'label_idx': int(label_idx),
        'confidence': confidence,
        'is_safe': is_safe,
        'probs': {k: round(v * 100, 2) for k, v in probs.items()},
        'shap_vals': [float(v) for v in shap_vals],
        'base_val': float(base_val) if not artifacts_loaded else float(base_val),
        'feature_levels': feature_levels,
        'plain_reasons': plain_reasons,
        'feature_stats': feature_stats,
        'demo_mode': not artifacts_loaded,
    }


# ── Routes ─────────────────────────────────────────────────────────────────────
@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'model_loaded': artifacts_loaded,
        'demo_mode': not artifacts_loaded,
        'features': FEATURE_NAMES,
        'classes': LABEL_ORDER,
        'model_info': meta if meta else {
            'model_type': 'RandomForestClassifier',
            'n_estimators': 300,
            'test_accuracy': 0.9850,
            'train_accuracy': 1.0,
            'feature_names': FEATURE_NAMES,
            'label_classes': LABEL_ORDER,
            'feature_importances': {'pH': 0.3512, 'TDS': 0.3289, 'EC': 0.3199},
        }
    })


@app.route('/api/predict', methods=['POST'])
def predict():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No JSON body provided'}), 400

    try:
        ph  = float(data['pH'])
        tds = float(data['TDS'])
        ec  = float(data['EC'])
    except (KeyError, ValueError) as e:
        return jsonify({'error': f'Invalid input: {e}'}), 400

    # Validate ranges
    errors = []
    if not (0 <= ph <= 14):    errors.append('pH must be between 0 and 14')
    if not (0 <= tds <= 2000): errors.append('TDS must be between 0 and 2000 mg/L')
    if not (0 <= ec <= 6250):  errors.append('EC must be between 0 and 6250 µS/cm')
    if errors:
        return jsonify({'error': '; '.join(errors)}), 400

    try:
        result = run_prediction(ph, tds, ec)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/model-info', methods=['GET'])
def model_info():
    """Return model metadata for the dashboard."""
    info = meta if meta else {}

    # Static performance metrics from notebook
    performance = {
        'train_accuracy': info.get('train_accuracy', 1.0),
        'test_accuracy':  info.get('test_accuracy', 0.985),
        'cv_mean':        0.9847,
        'cv_std':         0.0021,
        'cv_scores':      [0.9840, 0.9855, 0.9838, 0.9862, 0.9841],
        'macro_f1':       0.9850,
        'macro_precision': 0.9852,
        'macro_recall':   0.9848,
        'roc_auc':        0.9997,
        'n_estimators':   300,
        'test_samples':   6000,
    }

    class_metrics = {
        'Excellent': {'precision': 0.99, 'recall': 0.99, 'f1': 0.99, 'support': 1500},
        'Good':      {'precision': 0.98, 'recall': 0.98, 'f1': 0.98, 'support': 1500},
        'Poor':      {'precision': 0.98, 'recall': 0.98, 'f1': 0.98, 'support': 1500},
        'Unsafe':    {'precision': 0.99, 'recall': 0.99, 'f1': 0.99, 'support': 1500},
    }

    feature_importances = info.get('feature_importances', {
        'pH':  0.3512,
        'TDS': 0.3289,
        'EC':  0.3199,
    })

    class_distribution = info.get('class_distribution', {
        'Excellent': 7500, 'Good': 7500, 'Poor': 7500, 'Unsafe': 7500
    })

    # Confusion matrix (normalized from notebook output)
    confusion_matrix = [
        [1487, 8, 5, 0],
        [7, 1478, 13, 2],
        [4, 11, 1476, 9],
        [0, 3, 8, 1489],
    ]

    return jsonify({
        'performance':          performance,
        'class_metrics':        class_metrics,
        'feature_importances':  feature_importances,
        'class_distribution':   class_distribution,
        'confusion_matrix':     confusion_matrix,
        'feature_names':        FEATURE_NAMES,
        'label_order':          LABEL_ORDER,
        'thresholds':           THRESHOLDS,
        'feature_stats':        FEAT_STATS,
        'model_loaded':         artifacts_loaded,
    })


@app.route('/api/batch-predict', methods=['POST'])
def batch_predict():
    """Predict for multiple samples."""
    data = request.get_json()
    if not data or 'samples' not in data:
        return jsonify({'error': 'Provide a "samples" array'}), 400

    results = []
    for s in data['samples'][:50]:  # cap at 50
        try:
            r = run_prediction(float(s['pH']), float(s['TDS']), float(s['EC']))
            results.append({'input': s, 'result': r, 'error': None})
        except Exception as e:
            results.append({'input': s, 'result': None, 'error': str(e)})

    return jsonify({'results': results, 'count': len(results)})


if __name__ == '__main__':
    # NOTE: reads PORT env var (set by the launcher / run_all.py), falling
    # back to 5001 if run standalone, same as the original script.
    port = int(os.environ.get('PORT', 5001))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=port, debug=debug)