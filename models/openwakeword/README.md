# OpenWakeWord Models

This directory contains ONNX models for local wake word detection.

## Required Models

Download these from the [OpenWakeWord releases](https://github.com/dscripka/openWakeWord/releases):

### Core models (always required):
- `melspectrogram.onnx` - Audio preprocessing
- `embedding_model.onnx` - Speech feature extraction
- `silero_vad.onnx` - Voice activity detection

### Keyword models (at least one required):
- `alexa_v0.1.onnx` - Detects "Alexa"
- `hey_jarvis_v0.1.onnx` - Detects "Hey Jarvis"
- `hey_mycroft_v0.1.onnx` - Detects "Hey Mycroft"
- `hey_rhasspy_v0.1.onnx` - Detects "Hey Rhasspy"
- `timer_v0.1.onnx` - Detects timer-related phrases
- `weather_v0.1.onnx` - Detects weather-related phrases

## Quick Download

Run the download script:

```bash
./models/openwakeword/download.sh
```

## Custom Wake Words

You can train custom wake word models using the
[OpenWakeWord training notebook](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb).

Place your custom `.onnx` model file in this directory and reference it in
`WAKEWORD_KEYWORDS` in your `.env` file.
