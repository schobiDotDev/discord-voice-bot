/**
 * Wake word detection provider interface
 *
 * Wake word providers analyze raw PCM audio data and determine
 * whether a specific keyword/phrase was spoken.
 */
export interface WakeWordProvider {
  /**
   * Provider name for logging and identification
   */
  readonly name: string;

  /**
   * Initialize the provider (load models, etc.)
   * Must be called before detect()
   */
  initialize(): Promise<void>;

  /**
   * Detect wake word in a PCM audio buffer.
   *
   * @param pcmData - Raw PCM audio data (signed 16-bit LE, mono)
   * @param sampleRate - Sample rate of the audio (e.g. 48000)
   * @returns Detection result with confidence score
   */
  detect(pcmData: Buffer, sampleRate: number): Promise<WakeWordResult>;

  /**
   * Release resources held by the provider
   */
  dispose(): Promise<void>;

  /**
   * Check if the provider is properly configured and available
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Result from wake word detection
 */
export interface WakeWordResult {
  /** Whether the wake word was detected */
  detected: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Which keyword was detected (if multiple are configured) */
  keyword?: string;
}

/**
 * Common wake word configuration options
 */
export interface WakeWordConfig {
  /** Keywords/models to listen for */
  keywords: string[];
  /** Detection sensitivity (0-1, higher = more sensitive) */
  sensitivity: number;
  /** Path to model files directory */
  modelPath: string;
}
