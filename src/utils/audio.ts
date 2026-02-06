import ffmpeg from 'fluent-ffmpeg';
import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { logger } from './logger.js';

const RECORDINGS_DIR = './recordings';
const SOUNDS_DIR = './sounds';

/**
 * Ensure required directories exist
 */
export async function ensureDirectories(): Promise<void> {
  await fs.mkdir(RECORDINGS_DIR, { recursive: true });
  await fs.mkdir(SOUNDS_DIR, { recursive: true });
}

/**
 * Convert PCM audio data to MP3 format
 */
export function convertPcmToMp3(inputPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputFormat('s16le')
      .inputOptions(['-ar 48000', '-ac 1'])
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .format('mp3')
      .on('error', (err: Error) => {
        logger.error(`FFmpeg conversion error: ${err.message}`);
        reject(err);
      })
      .on('end', () => {
        logger.debug(`Converted ${inputPath} to ${outputPath}`);
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

/**
 * Convert audio buffer to Opus format for Discord playback
 */
export function convertToOpus(inputPath: string): Readable {
  const stream = ffmpeg(inputPath)
    .audioCodec('libopus')
    .audioBitrate('64k')
    .audioChannels(2)
    .audioFrequency(48000)
    .format('opus')
    .on('error', (err: Error) => {
      logger.error(`FFmpeg Opus conversion error: ${err.message}`);
    });

  return stream.pipe() as Readable;
}

/**
 * Save audio buffer to file
 */
export async function saveAudioBuffer(buffer: Buffer, filename: string): Promise<string> {
  const filePath = path.join(SOUNDS_DIR, filename);
  await fs.writeFile(filePath, buffer);
  logger.debug(`Saved audio buffer to ${filePath}`);
  return filePath;
}

/**
 * Create a PCM file path for a user
 */
export function getPcmPath(userId: string): string {
  return path.join(RECORDINGS_DIR, `${userId}.pcm`);
}

/**
 * Create an MP3 file path for a user
 */
export function getMp3Path(userId: string): string {
  return path.join(RECORDINGS_DIR, `${userId}.mp3`);
}

/**
 * Clean up temporary audio files
 */
export async function cleanupAudioFiles(userId: string): Promise<void> {
  const pcmPath = getPcmPath(userId);
  const mp3Path = getMp3Path(userId);

  try {
    await fs.unlink(pcmPath).catch(() => {});
    await fs.unlink(mp3Path).catch(() => {});
    logger.debug(`Cleaned up audio files for user ${userId}`);
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Clean up all recordings in the directory
 */
export async function cleanupAllRecordings(): Promise<void> {
  try {
    const files = await fs.readdir(RECORDINGS_DIR);
    await Promise.all(files.map((file) => fs.unlink(path.join(RECORDINGS_DIR, file)).catch(() => {})));
    logger.info('Cleaned up all recordings');
  } catch {
    // Directory might not exist yet
  }
}

/**
 * Write PCM data from a stream to a file
 */
export async function writePcmStream(stream: Readable, outputPath: string): Promise<void> {
  const writeStream = createWriteStream(outputPath);
  await pipeline(stream, writeStream);
}

/**
 * Split text into chunks suitable for TTS
 * Splits at sentence boundaries when possible
 */
export function splitTextForTTS(text: string, maxChunkSize = 60): string[] {
  const words = text.split(' ');
  const punctuationMarks = ['.', '!', '?', ';', ':'];
  const chunks: string[] = [];

  let i = 0;
  while (i < words.length) {
    let end = Math.min(i + maxChunkSize, words.length);

    // Try to find a sentence boundary
    if (end < words.length) {
      let lastPunctIndex = -1;
      for (let j = i; j < end; j++) {
        const lastChar = words[j].slice(-1);
        if (punctuationMarks.includes(lastChar)) {
          lastPunctIndex = j;
        }
      }
      if (lastPunctIndex !== -1) {
        end = lastPunctIndex + 1;
      }
    }

    chunks.push(words.slice(i, end).join(' '));
    i = end;
  }

  return chunks;
}

/**
 * Check if a sound file exists
 */
export async function soundExists(soundName: string): Promise<boolean> {
  const soundPath = path.join(SOUNDS_DIR, `${soundName}.mp3`);
  try {
    await fs.access(soundPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the path to a sound file
 */
export function getSoundPath(soundName: string): string {
  return path.join(SOUNDS_DIR, `${soundName}.mp3`);
}
