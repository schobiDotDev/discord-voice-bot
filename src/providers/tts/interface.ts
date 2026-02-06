/**
 * TTS provider interface
 */
export interface TTSProvider {
  /**
   * Provider name for logging and identification
   */
  readonly name: string;

  /**
   * Convert text to speech audio
   * @param text Text to synthesize
   * @returns Audio buffer (typically MP3 or WAV format)
   */
  synthesize(text: string): Promise<Buffer>;

  /**
   * Check if the provider is properly configured and available
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Common TTS configuration options
 */
export interface TTSConfig {
  apiUrl: string;
  apiKey?: string;
  model?: string;
  voice: string;
  speed?: number;
}

/**
 * TTS audio format
 */
export type AudioFormat = 'mp3' | 'wav' | 'ogg' | 'opus';
