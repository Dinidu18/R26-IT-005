"""
================================================================================
 WATER QUALITY MULTI-AGENT CONFIRMATION REPORT SYSTEM
================================================================================
Pipeline component 4/4 — web-app-ready version.

Consumes the outputs of three upstream model pipelines:
    Level 1 - Surface contamination classifier
              -> "Acid Pollution" | "Dead Animals Pollution" | "Oil Pollution"
                 | "Plastic Pollution" | "No Contamination"
    Level 2 - Microscopic aquatic organism detector
              -> one of 10 organism names | "No microscopic aquatic organisms"
    Level 3 - Drinking water quality classifier (pH, TDS, EC)
              -> "Excellent" | "Good" | "Poor" | "Unsafe" + raw values + which
                 values are in a dangerous range

And produces a single comprehensive markdown report that:
    1. Explains WHY the water is polluted / unsafe, separately for every
       issue detected at every level (grounded in a PDF knowledge base via
       RAG on Pinecone).
    2. Explains step-by-step HOW to purify the water, separately for every
       issue detected, ending each method with exact chemical dosing for
       1 L of water wherever a chemical is recommended.
    3. Rolls everything into one final, readable report.

Architecture (multi-agent):
    - IngestionAgent          : builds/refreshes the Pinecone knowledge base
                                 from PDFs (run once, or whenever the KB
                                 folder changes).
    - RetrieverAgent          : wraps Pinecone query() as a RAG retriever.
    - PollutionExplainerAgent : "why is this bad" agent (one call per issue).
    - PurificationAgent       : "how to fix this + dosages" agent (one call
                                 per issue).
    - ParameterAgent          : explains pH / TDS / EC danger status.
    - ReportCompilerAgent     : merges everything into the final report.
    - Orchestrator (generate_comprehensive_report) : coordinates all agents.

--------------------------------------------------------------------------------
CONFIGURATION
--------------------------------------------------------------------------------
This module reads all secrets/config from environment variables (loaded from
a local .env file via python-dotenv if present). Never hardcode API keys.

Required env vars:
    OPENROUTER_API_KEY
    PINECONE_API_KEY
    PINECONE_HOST
    PINECONE_INDEX_NAME   (default: water-quality-detection)
    PINECONE_NAMESPACE    (default: water-kb)
    KB_PATH               (folder containing your knowledge-base PDFs)
    LLM_MODEL             (default: meta-llama/llama-3.3-70b-instruct)
    EMBED_MODEL_NAME       (default: mixedbread-ai/mxbai-embed-large-v1)
================================================================================
"""

import os
import re
import glob
import json
import time
from datetime import datetime
from typing import List, Dict, Any, Optional

from dotenv import load_dotenv

load_dotenv()  # loads variables from a local .env file, if present

from pypdf import PdfReader
from sentence_transformers import SentenceTransformer
from pinecone import Pinecone
from openai import OpenAI
from tqdm import tqdm


# =============================================================================
# 0. CONFIG
# =============================================================================

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY", "")

PINECONE_HOST = os.environ.get("PINECONE_HOST", "")
PINECONE_INDEX_NAME = os.environ.get("PINECONE_INDEX_NAME", "water-quality-detection")
PINECONE_NAMESPACE = os.environ.get("PINECONE_NAMESPACE", "water-kb")

KB_PATH = os.environ.get("KB_PATH", "./knowledge_base")

LLM_MODEL = os.environ.get("LLM_MODEL", "meta-llama/llama-3.3-70b-instruct")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# IMPORTANT: the embedding model dimension MUST match the dimension your
# Pinecone index was created with.
EMBED_MODEL_NAME = os.environ.get("EMBED_MODEL_NAME", "mixedbread-ai/mxbai-embed-large-v1")


def _warn_missing_config():
    missing = []
    if not OPENROUTER_API_KEY:
        missing.append("OPENROUTER_API_KEY")
    if not PINECONE_API_KEY:
        missing.append("PINECONE_API_KEY")
    if not PINECONE_HOST:
        missing.append("PINECONE_HOST")
    if missing:
        print(f"WARNING: missing env vars: {', '.join(missing)}. "
              f"Set them in your .env file before running the pipeline.")


_warn_missing_config()


# =============================================================================
# 1. CLIENTS
# =============================================================================

_embedder = None
def get_embedder():
    global _embedder
    if _embedder is None:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading embedding model on device: {device}")
        _embedder = SentenceTransformer(EMBED_MODEL_NAME, device=device)
    return _embedder


_pc_index = None
def get_pinecone_index():
    global _pc_index
    if _pc_index is None:
        pc = Pinecone(api_key=PINECONE_API_KEY)
        _pc_index = pc.Index(name=PINECONE_INDEX_NAME, host=PINECONE_HOST)
    return _pc_index


_llm_client = None
def get_llm_client():
    global _llm_client
    if _llm_client is None:
        _llm_client = OpenAI(base_url=OPENROUTER_BASE_URL, api_key=OPENROUTER_API_KEY)
    return _llm_client


def check_index_dimension_matches():
    """Run this once to confirm your embedding model matches the Pinecone index."""
    idx = get_pinecone_index()
    stats = idx.describe_index_stats()
    index_dim = stats.get("dimension")
    model_dim = get_embedder().get_sentence_embedding_dimension()
    print(f"Pinecone index dimension : {index_dim}")
    print(f"Embedding model dimension: {model_dim}")
    if index_dim and index_dim != model_dim:
        print("!! MISMATCH — queries/upserts will fail. Change EMBED_MODEL_NAME "
              "to a model whose output dimension equals the index dimension, "
              "or recreate the Pinecone index with dimension =", model_dim)
    else:
        print("OK — dimensions match.")
    return stats


# =============================================================================
# 2. INGESTION AGENT — builds the knowledge base in Pinecone from PDFs
# =============================================================================

def extract_text_from_pdf(path: str) -> str:
    try:
        reader = PdfReader(path)
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        return text
    except Exception as e:
        print(f"  ! Failed to read {path}: {e}")
        return ""


def chunk_text(text: str, chunk_size: int = 900, overlap: int = 150) -> List[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start = end - overlap
        if start < 0:
            break
    return [c.strip() for c in chunks if len(c.strip()) > 40]


def build_knowledge_base(kb_path: str = KB_PATH,
                          namespace: str = PINECONE_NAMESPACE,
                          batch_size: int = 64,
                          rebuild: bool = False) -> int:
    """
    Reads every PDF in kb_path, chunks it, embeds each chunk, and upserts
    into the Pinecone index. Safe to re-run; set rebuild=True to wipe the
    namespace first.
    """
    idx = get_pinecone_index()
    embedder = get_embedder()

    if rebuild:
        try:
            idx.delete(delete_all=True, namespace=namespace)
            print(f"Cleared namespace '{namespace}'.")
        except Exception as e:
            print(f"  (nothing to clear or delete failed harmlessly: {e})")

    pdf_files = glob.glob(os.path.join(kb_path, "**", "*.pdf"), recursive=True)
    print(f"Found {len(pdf_files)} PDF(s) in knowledge base.")

    all_chunks = []
    for path in pdf_files:
        raw_text = extract_text_from_pdf(path)
        chunks = chunk_text(raw_text)
        fname = os.path.basename(path)
        for i, chunk in enumerate(chunks):
            all_chunks.append({
                "id": f"{fname}-{i}",
                "text": chunk,
                "source": fname,
            })

    print(f"Total chunks to embed & upsert: {len(all_chunks)}")

    for i in tqdm(range(0, len(all_chunks), batch_size), desc="Upserting to Pinecone"):
        batch = all_chunks[i:i + batch_size]
        texts = [b["text"] for b in batch]
        vectors = embedder.encode(texts, show_progress_bar=False).tolist()
        upsert_payload = [
            {
                "id": b["id"],
                "values": vec,
                "metadata": {"text": b["text"], "source": b["source"]},
            }
            for b, vec in zip(batch, vectors)
        ]
        idx.upsert(vectors=upsert_payload, namespace=namespace)

    print("Knowledge base build complete.")
    return len(all_chunks)


# =============================================================================
# 3. RETRIEVER AGENT
# =============================================================================

def retrieve_context(query: str, top_k: int = 5, namespace: str = PINECONE_NAMESPACE) -> str:
    embedder = get_embedder()
    idx = get_pinecone_index()
    vec = embedder.encode(query).tolist()
    res = idx.query(vector=vec, top_k=top_k, include_metadata=True, namespace=namespace)
    matches = res.get("matches", [])
    if not matches:
        return "(No matching knowledge base content found for this topic.)"
    parts = []
    for m in matches:
        meta = m.get("metadata", {})
        parts.append(f"[Source: {meta.get('source', 'unknown')}]\n{meta.get('text', '')}")
    return "\n\n---\n\n".join(parts)


# =============================================================================
# 4. LLM CALL HELPER (OpenRouter, OpenAI-compatible)
# =============================================================================

def call_llm(system_prompt: str, user_prompt: str,
             temperature: float = 0.3, max_tokens: int = 1200,
             retries: int = 3) -> str:
    client = get_llm_client()
    last_err = None
    for attempt in range(retries):
        try:
            resp = client.chat.completions.create(
                model=LLM_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            last_err = e
            wait = 2 ** attempt
            print(f"  LLM call failed (attempt {attempt+1}/{retries}): {e}. Retrying in {wait}s...")
            time.sleep(wait)
    raise RuntimeError(f"LLM call failed after {retries} attempts: {last_err}")


# =============================================================================
# 5. DOMAIN REFERENCE DATA
# =============================================================================

CONTAMINATION_TYPES = [
    "Acid Pollution", "Dead Animals Pollution", "Oil Pollution", "Plastic Pollution",
]

ORGANISM_TYPES = [
    "Anabaenopsis", "Ceratium", "Coelosphaerium", "Euglena", "Gomphosphaeria",
    "Merismopedia", "Microcystis", "Oscillatoria", "Phormidium", "Raphidiopsis",
]

PARAMETER_REFERENCE = {
    "pH": {"safe_range": (6.5, 8.5)},
    "TDS": {"safe_range": (0, 500), "unit": "mg/L"},
    "EC": {"safe_range": (0, 800), "unit": "µS/cm"},
}


# =============================================================================
# 6. AGENTS
# =============================================================================

class PollutionExplainerAgent:
    """Explains WHY a specific detected issue makes the water polluted/unsafe."""

    SYSTEM_PROMPT = (
        "You are a senior water quality scientist writing a section of a formal "
        "drinking-water safety report. You explain, in clear technical-but-"
        "readable language, why a specific detected contaminant, organism, or "
        "parameter makes water unsafe or undesirable for drinking. Base your "
        "explanation strictly on the provided reference context when it is "
        "relevant; you may supplement with well-established water science "
        "knowledge if the context is incomplete, but do not invent statistics. "
        "Do not discuss purification steps here — that is handled elsewhere. "
        "Write 2-4 focused paragraphs. Do not use markdown headers of any kind "
        "(no '#', '##', or '###') — plain paragraphs only."
    )

    def explain(self, issue_type: str, issue_name: str, extra: Optional[str] = None) -> str:
        query = f"{issue_name} {issue_type} in drinking water health risks and causes"
        context = retrieve_context(query, top_k=5)
        user_prompt = (
            f"Detected issue type: {issue_type}\n"
            f"Detected issue: {issue_name}\n"
            f"Additional detail: {extra or 'N/A'}\n\n"
            f"Reference context from knowledge base:\n{context}\n\n"
            f"Task: Explain specifically why the presence of '{issue_name}' "
            f"({issue_type}) makes this water sample polluted and unsuitable "
            f"for drinking. Cover the likely source/cause of this contamination "
            f"and the specific health or safety risks it poses to a person "
            f"who drinks it."
        )
        return call_llm(self.SYSTEM_PROMPT, user_prompt, temperature=0.25, max_tokens=700)


class PurificationAgent:
    """Produces a step-by-step purification method for one detected issue,
    ending with exact chemical dosage for 1 L of water if chemicals are used."""

    SYSTEM_PROMPT = (
        "You are a water treatment engineer writing a practical, step-by-step "
        "purification procedure for a household/small-scale water sample. "
        "Ground your method in the provided reference context wherever "
        "possible. Your output MUST be formatted as:\n"
        "1. A numbered list of clear, sequential purification steps.\n"
        "2. If ANY step involves adding a chemical (e.g. chlorine, alum, "
        "activated carbon dosing, lime, potassium permanganate, etc.), you "
        "MUST end the response with a section titled exactly:\n"
        "'Chemical Dosage (per 1 L of water):' followed by a bullet list, "
        "one bullet per chemical, giving an exact, safe, commonly-recommended "
        "dose scaled to 1 liter (e.g. '- Household bleach (5% NaOCl): 2 drops "
        "(~0.1 mL) per 1 L, mix and wait 30 minutes before use.'). "
        "If no chemical is required for this specific method, end with "
        "'Chemical Dosage (per 1 L of water): Not applicable — this method "
        "uses no added chemicals.' "
        "Do not use markdown headers of any kind (no '#', '##', or '###') "
        "other than the exact chemical dosage title above. Be concrete and "
        "practical, not vague."
    )

    def plan(self, issue_type: str, issue_name: str, extra: Optional[str] = None) -> str:
        query = f"how to purify or remove {issue_name} {issue_type} from water treatment method chemical dose"
        context = retrieve_context(query, top_k=5)
        user_prompt = (
            f"Detected issue type: {issue_type}\n"
            f"Detected issue: {issue_name}\n"
            f"Additional detail: {extra or 'N/A'}\n\n"
            f"Reference context from knowledge base:\n{context}\n\n"
            f"Task: Provide a step-by-step purification procedure specifically "
            f"targeting '{issue_name}' ({issue_type}) contamination, suitable "
            f"for a 1 liter sample, ending with the required Chemical Dosage "
            f"section as instructed."
        )
        return call_llm(self.SYSTEM_PROMPT, user_prompt, temperature=0.25, max_tokens=800)


class ParameterAgent:
    """Explains pH / TDS / EC status from the Level 3 classifier output."""

    SYSTEM_PROMPT = (
        "You are a water chemistry analyst. You are given measured pH, TDS, "
        "and EC values plus which ones are flagged as dangerous, and the "
        "overall quality label. Explain, in plain language, what each value "
        "means, whether it is within a safe drinking-water range, and if not, "
        "what specifically is wrong and why it matters for drinking safety. "
        "Use the reference context if relevant. Write concise paragraphs, one "
        "per parameter, then a one-paragraph overall summary tying it to the "
        "quality label. Do not include purification steps. Do not use markdown "
        "headers of any kind (no '#', '##', or '###')."
    )

    def analyze(self, ph: float, tds: float, ec: float, quality_label: str,
                danger_flags: List[str]) -> str:
        context = retrieve_context(
            "safe pH TDS electrical conductivity range drinking water standards", top_k=4
        )
        user_prompt = (
            f"Measured values:\n"
            f"- pH: {ph}\n"
            f"- TDS: {tds} mg/L\n"
            f"- EC: {ec} µS/cm\n"
            f"Overall Level-3 quality classification: {quality_label}\n"
            f"Flagged as dangerous: {', '.join(danger_flags) if danger_flags else 'None'}\n\n"
            f"Reference context:\n{context}\n\n"
            f"Task: Explain each parameter's status and what it means for "
            f"drinking safety, then summarize overall."
        )
        return call_llm(self.SYSTEM_PROMPT, user_prompt, temperature=0.2, max_tokens=700)


class ReportCompilerAgent:
    """Assembles all agent outputs into one final, well-formatted report."""

    SYSTEM_PROMPT = (
        "You are the lead author finalizing a formal Water Quality Confirmation "
        "Report. You will be given fully-written sections from specialist "
        "agents. Combine them into a single, polished, well-structured "
        "markdown report with a short executive summary at the top and a "
        "clear final verdict/recommendation at the bottom. Do NOT alter the "
        "technical content, dosages, or numbers given to you — only add "
        "structure, headers, and light connective wording. Do not shorten "
        "the purification or explanation sections; include them in full.\n\n"
        "STRICT HEADING RULES:\n"
        "- Use '#' ONLY once, for the report title.\n"
        "- Use '##' ONLY for the six numbered section headers listed in the "
        "structure you are given (## 1. Executive Summary, ## 2. Pipeline "
        "Results Overview, etc.) — nothing else may use '##'.\n"
        "- NEVER use '###' or any heading level deeper than '##'. For "
        "sub-points, issue names, or chemical names within a section, use "
        "bold text (e.g. '**Plastic Pollution**') or a bullet list instead "
        "of a heading.\n"
        "- Do not invent additional headers beyond the six listed."
    )

    def compile(self, sections: Dict[str, Any]) -> str:
        user_prompt = (
            "Assemble the following into one final markdown report using this "
            "structure exactly:\n"
            "# Water Quality Confirmation Report\n"
            "## 1. Executive Summary\n"
            "## 2. Pipeline Results Overview\n"
            "## 3. Contamination & Safety Analysis (per detected issue)\n"
            "## 4. Recommended Purification Procedures (per detected issue)\n"
            "## 5. Water Chemistry Parameter Analysis\n"
            "## 6. Final Verdict & Recommendation\n\n"
            "Remember: no '###' or deeper headings anywhere in the output — "
            "use bold text for issue names and sub-points within sections 3 "
            "and 4 instead.\n\n"
            f"RAW SECTION DATA (JSON):\n{json.dumps(sections, indent=2)}\n\n"
            "Write the full report now."
        )
        report = call_llm(self.SYSTEM_PROMPT, user_prompt, temperature=0.3, max_tokens=3000)
        # Defensive post-process: in case the model still emits '###' (or
        # deeper) headings despite instructions, demote them to bold text
        # rather than letting stray heading markers reach the frontend.
        report = re.sub(
            r"^#{3,}\s*(.+)$",
            lambda m: f"**{m.group(1).strip()}**",
            report,
            flags=re.MULTILINE,
        )
        return report


# =============================================================================
# 7. ORCHESTRATOR
# =============================================================================

def generate_comprehensive_report(
    level1_output: str,
    level2_output: str,
    level3_output: Dict[str, Any],
    save_path: Optional[str] = None,
) -> str:
    """
    Runs the full multi-agent pipeline and returns the final markdown report.

    Parameters
    ----------
    level1_output : str
        e.g. "Plastic Pollution" or "No Contamination"
    level2_output : str
        e.g. "Anabaenopsis" or "No microscopic aquatic organisms"
    level3_output : dict, e.g.
        {
            "quality": "Poor",
            "pH": 9.4,
            "TDS": 620,
            "EC": 1450,
            "danger_flags": ["pH", "EC"]   # which measured values are dangerous
        }
    save_path : optional str
        If given, writes the report to this file path.
    """
    print("=== Water Quality Multi-Agent Report Generation ===")

    quality_label = level3_output.get("quality", "Unknown")
    ph = level3_output.get("pH")
    tds = level3_output.get("TDS")
    ec = level3_output.get("EC")
    danger_flags = level3_output.get("danger_flags", [])

    # ---- collect detected issues across levels ----
    detected_issues = []
    if level1_output and level1_output != "No Contamination":
        detected_issues.append(("Surface Contamination (Level 1)", level1_output))
    if level2_output and level2_output != "No microscopic aquatic organisms":
        detected_issues.append(("Microscopic Organism (Level 2)", level2_output))
    for flag in danger_flags:
        value = {"pH": ph, "TDS": tds, "EC": ec}.get(flag)
        detected_issues.append(("Water Parameter (Level 3)", f"{flag} = {value}"))

    explainer = PollutionExplainerAgent()
    purifier = PurificationAgent()
    param_agent = ParameterAgent()
    compiler = ReportCompilerAgent()

    explanations = []
    purification_plans = []

    if detected_issues:
        print(f"Detected {len(detected_issues)} issue(s): "
              f"{[name for _, name in detected_issues]}")
        for issue_type, issue_name in detected_issues:
            print(f"  -> Explaining: {issue_name}")
            explanations.append({
                "issue_type": issue_type,
                "issue_name": issue_name,
                "explanation": explainer.explain(issue_type, issue_name),
            })
            print(f"  -> Building purification plan: {issue_name}")
            purification_plans.append({
                "issue_type": issue_type,
                "issue_name": issue_name,
                "plan": purifier.plan(issue_type, issue_name),
            })
    else:
        print("No issues detected at Level 1 or Level 2, and no dangerous parameters at Level 3.")
        explanations.append({
            "issue_type": "N/A",
            "issue_name": "No contamination detected",
            "explanation": (
                "No surface contamination, no harmful microscopic organisms, and "
                "no dangerous chemical parameters were detected in this sample. "
                "Based on all three pipeline stages, this water appears free of "
                "the pollution categories this system screens for."
            ),
        })
        purification_plans.append({
            "issue_type": "N/A",
            "issue_name": "No contamination detected",
            "plan": "No purification is required based on the detected results. "
                    "Standard routine monitoring is still recommended.\n\n"
                    "Chemical Dosage (per 1 L of water): Not applicable — this "
                    "method uses no added chemicals.",
        })

    print("  -> Analyzing pH / TDS / EC parameters")
    parameter_analysis = param_agent.analyze(ph, tds, ec, quality_label, danger_flags)

    sections = {
        "level_1_surface_contamination_result": level1_output,
        "level_2_microorganism_result": level2_output,
        "level_3_quality_classification": quality_label,
        "level_3_measured_values": {"pH": ph, "TDS": tds, "EC": ec},
        "level_3_danger_flags": danger_flags,
        "detected_issues_count": len(detected_issues),
        "contamination_explanations": explanations,
        "purification_plans": purification_plans,
        "parameter_analysis": parameter_analysis,
        "report_generated_at": datetime.now().isoformat(),
    }

    print("  -> Compiling final report")
    final_report = compiler.compile(sections)

    if save_path:
        with open(save_path, "w", encoding="utf-8") as f:
            f.write(final_report)
        print(f"Report saved to: {save_path}")

    print("=== Done ===")
    return final_report


# =============================================================================
# 8. FLASK WEB APPLICATION
# =============================================================================
#
# Endpoints
# ---------
# GET  /                     Simple HTML form to try the pipeline manually.
# POST /generate-report      Form submission target -> renders the report page.
# POST /api/generate-report  JSON API for integrating with your Level 1/2/3
#                             model pipelines.
#                             Request body:
#                             {
#                               "level1_output": "No Contamination",
#                               "level2_output": "Raphidiopsis",
#                               "level3_output": {
#                                   "quality": "Excellent",
#                                   "pH": 7,
#                                   "TDS": 610,
#                                   "EC": 500,
#                                   "danger_flags": []
#                               }
#                             }
#                             Response body:
#                             { "report_markdown": "..." }
#
# Run locally
# -----------
# 1. pip install -r requirements.txt
# 2. Copy .env.example to .env and fill in your (rotated) API keys.
# 3. python app.py
# 4. Visit http://localhost:5000
# =============================================================================

import traceback
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS

app = Flask(__name__)

# Allow the Vite dev server (and any other configured origins) to call the
# JSON API from the browser. Without this, the browser blocks the response
# to a cross-origin fetch/XHR before your code ever sees it (CORS preflight).
#
# Configure allowed origins via CORS_ALLOWED_ORIGINS in .env, comma-separated,
# e.g. "http://localhost:5173,https://your-frontend.example.com".
# Defaults to the common local Vite/CRA dev ports if unset.
_default_origins = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"
_allowed_origins = [
    o.strip()
    for o in os.environ.get("CORS_ALLOWED_ORIGINS", _default_origins).split(",")
    if o.strip()
]
CORS(app, resources={r"/api/*": {"origins": _allowed_origins}}, supports_credentials=False)


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@app.route("/", methods=["GET"])
def index():
    return render_template("index.html", report=None, error=None, form=None)


@app.route("/generate-report", methods=["POST"])
def generate_report_form():
    """Handles the HTML form submission and renders the report inline."""
    form = request.form
    try:
        level1_output = form.get("level1_output", "No Contamination")
        level2_output = form.get("level2_output", "No microscopic aquatic organisms")

        level3_output = {
            "quality": form.get("quality", "Unknown"),
            "pH": _to_float(form.get("pH")),
            "TDS": _to_float(form.get("TDS")),
            "EC": _to_float(form.get("EC")),
            "danger_flags": [f.strip() for f in form.get("danger_flags", "").split(",") if f.strip()],
        }

        report = generate_comprehensive_report(
            level1_output=level1_output,
            level2_output=level2_output,
            level3_output=level3_output,
        )
        return render_template("index.html", report=report, error=None, form=form)
    except Exception as e:
        traceback.print_exc()
        return render_template("index.html", report=None, error=str(e), form=form)


@app.route("/api/generate-report", methods=["POST"])
def generate_report_api():
    """JSON API endpoint for programmatic integration (e.g. from your ML pipeline)."""
    data = request.get_json(silent=True) or {}

    level1_output = data.get("level1_output")
    level2_output = data.get("level2_output")
    level3_output = data.get("level3_output")

    if not level1_output or not level2_output or not isinstance(level3_output, dict):
        return jsonify({
            "error": "Request must include level1_output (str), level2_output (str), "
                     "and level3_output (dict with quality/pH/TDS/EC/danger_flags)."
        }), 400

    try:
        report = generate_comprehensive_report(
            level1_output=level1_output,
            level2_output=level2_output,
            level3_output=level3_output,
        )
        return jsonify({"report_markdown": report})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # Default matches the "Water Quality Report Generator" entry in main.py's
    # launcher (port 5003). Override with the PORT env var if needed.
    port = int(os.environ.get("PORT", 5003))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)