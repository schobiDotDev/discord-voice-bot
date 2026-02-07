#!/usr/bin/env bash
# Download OpenWakeWord ONNX models
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OWW_VERSION="v0.5.1"
OWW_BASE="https://github.com/dscripka/openWakeWord/releases/download/${OWW_VERSION}"
# Silero VAD v4 (compatible with OpenWakeWord pipeline - uses h/c state inputs)
VAD_URL="https://github.com/IntendedConsequence/vadc/raw/master/silero_vad_v4.onnx"

echo "Downloading OpenWakeWord models to ${SCRIPT_DIR}..."

# Core models
echo "  → melspectrogram.onnx"
curl -fLo melspectrogram.onnx "${OWW_BASE}/melspectrogram.onnx"

echo "  → embedding_model.onnx"
curl -fLo embedding_model.onnx "${OWW_BASE}/embedding_model.onnx"

echo "  → silero_vad.onnx (v4)"
curl -fLo silero_vad.onnx "${VAD_URL}"

# Keyword models
echo "  → alexa_v0.1.onnx"
curl -fLo alexa_v0.1.onnx "${OWW_BASE}/alexa_v0.1.onnx"

echo "  → hey_jarvis_v0.1.onnx"
curl -fLo hey_jarvis_v0.1.onnx "${OWW_BASE}/hey_jarvis_v0.1.onnx"

echo ""
echo "Done! Models downloaded successfully."
echo "Set WAKEWORD_PROVIDER=openwakeword in your .env to enable wake word detection."
