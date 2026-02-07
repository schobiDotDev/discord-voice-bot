import * as ort from 'onnxruntime-node';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { logger } from '../../utils/logger.js';
import type { WakeWordProvider, WakeWordResult, WakeWordConfig } from './interface.js';

/**
 * Known keyword model files for OpenWakeWord
 */
const KEYWORD_MODEL_MAP: Record<string, string> = {
  alexa: 'alexa_v0.1.onnx',
  hey_jarvis: 'hey_jarvis_v0.1.onnx',
  hey_mycroft: 'hey_mycroft_v0.1.onnx',
  hey_rhasspy: 'hey_rhasspy_v0.1.onnx',
  timer: 'timer_v0.1.onnx',
  weather: 'weather_v0.1.onnx',
};

/** Audio frame size expected by OpenWakeWord (80ms at 16kHz) */
const FRAME_SIZE = 1280;
/** Target sample rate for OpenWakeWord models */
const TARGET_SAMPLE_RATE = 16000;
/** Number of mel frames per audio chunk */
const MEL_FRAMES_PER_CHUNK = 5;
/** Mel band count */
const MEL_BANDS = 32;
/** Mel window size for embedding model */
const MEL_WINDOW = 76;
/** Mel step size between inference windows */
const MEL_STEP = 8;
/** Embedding vector size */
const EMBEDDING_SIZE = 96;
/** Default embedding window size for keyword models */
const DEFAULT_EMBEDDING_WINDOW = 16;
/** VAD hidden state size */
const VAD_HIDDEN_SIZE = 128;
/** VAD hidden state shape */
const VAD_HIDDEN_SHAPE = [2, 1, 64];

interface KeywordModelState {
  session: ort.InferenceSession;
  scores: number[];
  windowSize: number;
  history: Float32Array[];
}

/**
 * OpenWakeWord provider using ONNX Runtime for local wake word detection.
 *
 * Architecture:
 * 1. Audio → melspectrogram ONNX model → mel features
 * 2. Mel features → embedding ONNX model → speech embeddings
 * 3. Speech embeddings → keyword ONNX model(s) → detection scores
 * 4. Silero VAD model → voice activity detection (reduces false positives)
 */
export class OpenWakeWordProvider implements WakeWordProvider {
  readonly name = 'openwakeword';

  private config: WakeWordConfig;
  private melspecModel: ort.InferenceSession | null = null;
  private embeddingModel: ort.InferenceSession | null = null;
  private vadModel: ort.InferenceSession | null = null;
  private keywordModels: Map<string, KeywordModelState> = new Map();

  // Processing state
  private melBuffer: Float32Array[] = [];
  private vadH: ort.Tensor | null = null;
  private vadC: ort.Tensor | null = null;
  private initialized = false;

  constructor(config: WakeWordConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const modelDir = this.config.modelPath;
    logger.info(`Loading OpenWakeWord models from ${modelDir}`);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
    };

    // Load core models
    this.melspecModel = await ort.InferenceSession.create(
      path.join(modelDir, 'melspectrogram.onnx'),
      sessionOptions
    );
    logger.debug('Loaded melspectrogram model');

    this.embeddingModel = await ort.InferenceSession.create(
      path.join(modelDir, 'embedding_model.onnx'),
      sessionOptions
    );
    logger.debug('Loaded embedding model');

    this.vadModel = await ort.InferenceSession.create(
      path.join(modelDir, 'silero_vad.onnx'),
      sessionOptions
    );
    logger.debug('Loaded VAD model');

    // Load keyword models
    for (const keyword of this.config.keywords) {
      const modelFile = this.resolveKeywordModel(keyword);
      const modelPath = path.join(modelDir, modelFile);

      try {
        await fs.access(modelPath);
      } catch {
        throw new Error(
          `Keyword model not found: ${modelPath}. ` +
            `Available built-in keywords: ${Object.keys(KEYWORD_MODEL_MAP).join(', ')}`
        );
      }

      const session = await ort.InferenceSession.create(modelPath, sessionOptions);
      const windowSize = this.inferKeywordWindowSize(session) ?? DEFAULT_EMBEDDING_WINDOW;

      const history: Float32Array[] = [];
      for (let i = 0; i < windowSize; i++) {
        history.push(new Float32Array(EMBEDDING_SIZE).fill(0));
      }

      this.keywordModels.set(keyword, {
        session,
        scores: new Array(50).fill(0) as number[],
        windowSize,
        history,
      });

      logger.debug(`Loaded keyword model: ${keyword}`, { modelFile, windowSize });
    }

    // Initialize VAD state
    this.resetState();
    this.initialized = true;
    logger.info(`OpenWakeWord initialized with keywords: ${this.config.keywords.join(', ')}`);
  }

  async detect(pcmData: Buffer, sampleRate: number): Promise<WakeWordResult> {
    if (!this.initialized) {
      throw new Error('OpenWakeWord not initialized. Call initialize() first.');
    }

    // Convert PCM buffer to float32 samples and resample to 16kHz
    const float32Samples = this.pcmToFloat32(pcmData);
    const resampled =
      sampleRate !== TARGET_SAMPLE_RATE
        ? this.resample(float32Samples, sampleRate, TARGET_SAMPLE_RATE)
        : float32Samples;

    // Process in chunks of FRAME_SIZE
    let bestResult: WakeWordResult = { detected: false, confidence: 0 };

    for (let offset = 0; offset + FRAME_SIZE <= resampled.length; offset += FRAME_SIZE) {
      const chunk = resampled.subarray(offset, offset + FRAME_SIZE);
      const result = await this.processChunk(chunk);

      if (result.confidence > bestResult.confidence) {
        bestResult = result;
      }
    }

    return bestResult;
  }

  async dispose(): Promise<void> {
    if (this.melspecModel) {
      await this.melspecModel.release();
      this.melspecModel = null;
    }
    if (this.embeddingModel) {
      await this.embeddingModel.release();
      this.embeddingModel = null;
    }
    if (this.vadModel) {
      await this.vadModel.release();
      this.vadModel = null;
    }
    for (const [, state] of this.keywordModels) {
      await state.session.release();
    }
    this.keywordModels.clear();
    this.initialized = false;
    logger.info('OpenWakeWord disposed');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const modelDir = this.config.modelPath;
      const requiredFiles = ['melspectrogram.onnx', 'embedding_model.onnx', 'silero_vad.onnx'];

      for (const file of requiredFiles) {
        await fs.access(path.join(modelDir, file));
      }

      // Check at least one keyword model exists
      for (const keyword of this.config.keywords) {
        const modelFile = this.resolveKeywordModel(keyword);
        await fs.access(path.join(modelDir, modelFile));
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Process a single audio chunk (1280 samples at 16kHz = 80ms)
   */
  private async processChunk(chunk: Float32Array): Promise<WakeWordResult> {
    // Run VAD
    const vadActive = await this.runVad(chunk);

    // Run melspectrogram
    const melspecTensor = new ort.Tensor('float32', chunk, [1, FRAME_SIZE]);
    const melspecResults = await this.melspecModel!.run({
      [this.melspecModel!.inputNames[0]]: melspecTensor,
    });
    const newMelData = new Float32Array(
      melspecResults[this.melspecModel!.outputNames[0]].data as Float32Array
    );

    // Normalize mel features (same as reference implementation)
    for (let j = 0; j < newMelData.length; j++) {
      newMelData[j] = newMelData[j] / 10.0 + 2.0;
    }

    // Split mel output into frames (5 frames of 32 bands each per chunk)
    for (let j = 0; j < MEL_FRAMES_PER_CHUNK; j++) {
      this.melBuffer.push(new Float32Array(newMelData.subarray(j * MEL_BANDS, (j + 1) * MEL_BANDS)));
    }

    // Need at least MEL_WINDOW frames to run embedding
    let bestResult: WakeWordResult = { detected: false, confidence: 0 };

    while (this.melBuffer.length >= MEL_WINDOW) {
      const windowFrames = this.melBuffer.slice(0, MEL_WINDOW);
      const flattenedMel = new Float32Array(MEL_WINDOW * MEL_BANDS);
      for (let j = 0; j < windowFrames.length; j++) {
        flattenedMel.set(windowFrames[j], j * MEL_BANDS);
      }

      // Run embedding model
      const embeddingInput = new ort.Tensor('float32', flattenedMel, [1, MEL_WINDOW, MEL_BANDS, 1]);
      const embeddingOut = await this.embeddingModel!.run({
        [this.embeddingModel!.inputNames[0]]: embeddingInput,
      });
      const newEmbedding = new Float32Array(
        embeddingOut[this.embeddingModel!.outputNames[0]].data as Float32Array
      );

      // Run each keyword model
      for (const [keyword, state] of this.keywordModels) {
        state.history.shift();
        state.history.push(newEmbedding);

        const flattenedEmbeddings = new Float32Array(state.windowSize * EMBEDDING_SIZE);
        for (let j = 0; j < state.history.length; j++) {
          flattenedEmbeddings.set(state.history[j], j * EMBEDDING_SIZE);
        }

        const finalInput = new ort.Tensor('float32', flattenedEmbeddings, [
          1,
          state.windowSize,
          EMBEDDING_SIZE,
        ]);
        const results = await state.session.run({
          [state.session.inputNames[0]]: finalInput,
        });
        const score = (results[state.session.outputNames[0]].data as Float32Array)[0];

        state.scores.shift();
        state.scores.push(score);

        // Use sensitivity as threshold (inverted: higher sensitivity = lower threshold)
        const threshold = 1 - this.config.sensitivity;

        if (score > threshold && vadActive && score > bestResult.confidence) {
          bestResult = {
            detected: true,
            confidence: score,
            keyword,
          };
        }
      }

      // Advance mel buffer by MEL_STEP frames
      this.melBuffer.splice(0, MEL_STEP);
    }

    return bestResult;
  }

  /**
   * Run Silero VAD on audio chunk
   */
  private async runVad(chunk: Float32Array): Promise<boolean> {
    try {
      const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
      const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(TARGET_SAMPLE_RATE)]), []);

      const result = await this.vadModel!.run({
        input: tensor,
        sr,
        h: this.vadH!,
        c: this.vadC!,
      });

      this.vadH = result.hn as ort.Tensor;
      this.vadC = result.cn as ort.Tensor;

      const confidence = (result.output.data as Float32Array)[0];
      return confidence > 0.5;
    } catch (err) {
      logger.debug(`VAD error: ${err}`);
      return true; // Default to active if VAD fails
    }
  }

  /**
   * Reset all internal state buffers
   */
  private resetState(): void {
    this.melBuffer = [];

    this.vadH = new ort.Tensor(
      'float32',
      new Float32Array(VAD_HIDDEN_SIZE).fill(0),
      VAD_HIDDEN_SHAPE
    );
    this.vadC = new ort.Tensor(
      'float32',
      new Float32Array(VAD_HIDDEN_SIZE).fill(0),
      VAD_HIDDEN_SHAPE
    );

    for (const [, state] of this.keywordModels) {
      state.scores.fill(0);
      for (let i = 0; i < state.history.length; i++) {
        state.history[i].fill(0);
      }
    }
  }

  /**
   * Convert signed 16-bit LE PCM buffer to float32 array (-1 to 1)
   */
  private pcmToFloat32(pcmData: Buffer): Float32Array {
    const numSamples = pcmData.length / 2;
    const float32 = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const sample = pcmData.readInt16LE(i * 2);
      float32[i] = sample / 32768.0;
    }

    return float32;
  }

  /**
   * Simple linear interpolation resampling
   */
  private resample(
    samples: Float32Array,
    fromRate: number,
    toRate: number
  ): Float32Array {
    const ratio = fromRate / toRate;
    const outputLength = Math.floor(samples.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
      const frac = srcIndex - srcIndexFloor;

      output[i] = samples[srcIndexFloor] * (1 - frac) + samples[srcIndexCeil] * frac;
    }

    return output;
  }

  /**
   * Resolve keyword name to model filename.
   * If the keyword contains a path separator or ends in .onnx, treat as a file path.
   * Otherwise, look up in the built-in keyword map.
   */
  private resolveKeywordModel(keyword: string): string {
    // Direct file path
    if (keyword.includes('/') || keyword.includes('\\') || keyword.endsWith('.onnx')) {
      return keyword;
    }

    // Built-in keyword
    const modelFile = KEYWORD_MODEL_MAP[keyword.toLowerCase()];
    if (modelFile) {
      return modelFile;
    }

    // Try as filename
    return `${keyword}.onnx`;
  }

  /**
   * Try to infer the expected window size from the keyword model's input shape
   */
  private inferKeywordWindowSize(session: ort.InferenceSession): number | undefined {
    try {
      const inputName = session.inputNames[0];
      if (!inputName) return undefined;

      // The input shape should be [1, windowSize, 96]
      // onnxruntime-node doesn't expose input metadata the same way as web
      // We'll use default window size
      return undefined;
    } catch {
      return undefined;
    }
  }
}
