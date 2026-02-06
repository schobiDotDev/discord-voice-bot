/**
 * Speech-to-Text provider interface
 */
export interface STTProvider {
  /**
   * Provider name for logging and identification
   */
  readonly name: string;

  /**
   * Transcribe audio file to text
   * @param audioPath Path to the audio file (MP3 format)
   * @returns Transcribed text
   */
  transcribe(audioPath: string): Promise<string>;

  /**
   * Check if the provider is properly configured and available
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Transcription result with metadata
 */
export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  confidence?: number;
}

/**
 * Common STT configuration options
 */
export interface STTConfig {
  apiUrl: string;
  apiKey?: string;
  model: string;
  language?: string;
}
