import { nanoid } from 'nanoid';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { supabaseRepository } from '../repositories/supabase-repository.js';

const execFileAsync = promisify(execFile);
const MULAW_SILENCE = 0xff; // G.711 μ-law silence byte
const SAMPLE_RATE = 8000;   // G.711 μ-law = 8 kHz, 1 byte per sample

// ─── Raw μ-law buffer helpers ──────────────────────────────────────────────────

/**
 * Concatenate base64-encoded μ-law chunks into a single continuous raw buffer.
 * (inbound direction — chunks are sequential, no gaps)
 */
function buildInboundBuffer(base64Chunks) {
  return Buffer.concat(base64Chunks.map((b) => Buffer.from(b, 'base64')));
}

/**
 * Build a time-aligned raw μ-law buffer from outbound turns.
 *
 * Each turn: { ms: number, chunks: string[] }
 *   ms     = wall-clock offset from call start (milliseconds)
 *   chunks = ordered base64 μ-law delta payloads for this AI response turn
 *
 * Within a turn chunks are placed sequentially (they arrive in network bursts,
 * not real-time).  Between turns the silence gap is preserved via the ms offset.
 */
function buildOutboundBuffer(timedTurns, totalBytes) {
  const buf = Buffer.alloc(totalBytes, MULAW_SILENCE);
  for (const { ms, chunks } of timedTurns) {
    let pos = Math.max(0, Math.round((ms / 1000) * SAMPLE_RATE));
    for (const data of chunks) {
      const raw = Buffer.from(data, 'base64');
      const copyLen = Math.min(raw.length, totalBytes - pos);
      if (copyLen > 0) raw.copy(buf, pos, 0, copyLen);
      pos += raw.length;
    }
  }
  return buf;
}

// ─── Service ───────────────────────────────────────────────────────────────────

class RecordingService {
  /**
   * Transcribe an audio buffer using OpenAI Whisper.
   */
  async transcribe(audioBuffer, language = 'id') {
    if (!env.openAiApiKey) return null;
    try {
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([audioBuffer], { type: 'audio/mpeg' }),
        'recording.mp3',
      );
      formData.append('model', 'whisper-1');
      formData.append('language', language);
      formData.append('response_format', 'text');

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.openAiApiKey}` },
        body: formData,
      });

      if (!res.ok) {
        logger.warn({ status: res.status, body: await res.text() }, 'Whisper transcription failed');
        return null;
      }

      return (await res.text()).trim() || null;
    } catch (err) {
      logger.error({ err }, 'Whisper transcription error');
      return null;
    }
  }

  /**
   * Full pipeline: μ-law chunks → ffmpeg mix → MP3 → Supabase Storage + Whisper.
   *
   * ffmpeg handles:
   *   • correct G.711 μ-law → PCM decoding (no manual lookup table)
   *   • proper mixing of caller + AI audio
   *   • high-quality MP3 encoding (smaller file, better playback)
   */
  async processRecording(callId, inboundChunks, language = 'id', outboundChunks = []) {
    if (!inboundChunks || inboundChunks.length === 0) {
      logger.warn({ callId }, 'No audio chunks — skipping recording');
      return { recordingUrl: null, transcriptSummary: null };
    }

    logger.info(
      { callId, inbound: inboundChunks.length, outbound: outboundChunks.length },
      'Processing call recording',
    );

    const tmpDir = path.join(os.tmpdir(), `rec-${callId}-${nanoid(6)}`);
    await mkdir(tmpDir, { recursive: true });

    const inFile  = path.join(tmpDir, 'in.raw');
    const outFile = path.join(tmpDir, 'out.raw');
    const mp3File = path.join(tmpDir, 'mixed.mp3');

    try {
      // 1. Build continuous raw μ-law buffers
      const inBuf = buildInboundBuffer(inboundChunks);

      let ffmpegArgs;
      if (outboundChunks.length > 0) {
        const outBuf = buildOutboundBuffer(outboundChunks, inBuf.length);
        await Promise.all([writeFile(inFile, inBuf), writeFile(outFile, outBuf)]);

        // Two raw μ-law inputs → mix → MP3
        ffmpegArgs = [
          '-loglevel', 'error',
          '-f', 'mulaw', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', inFile,
          '-f', 'mulaw', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', outFile,
          '-filter_complex', 'amix=inputs=2:duration=longest',
          '-ar', '16000', '-ac', '1', '-b:a', '64k',
          '-y', mp3File,
        ];
      } else {
        await writeFile(inFile, inBuf);

        // Single raw μ-law input → MP3
        ffmpegArgs = [
          '-loglevel', 'error',
          '-f', 'mulaw', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', inFile,
          '-ar', '16000', '-ac', '1', '-b:a', '64k',
          '-y', mp3File,
        ];
      }

      // 2. Run ffmpeg
      await execFileAsync('ffmpeg', ffmpegArgs);

      // 3. Read the encoded MP3
      const mp3Buffer = await readFile(mp3File);

      // 4. Upload to Supabase Storage (bucket: robocall)
      const filename = `${callId}-${Date.now()}-${nanoid(8)}.mp3`;
      const storagePath = `recording/${filename}`;
      const recordingUrl = await supabaseRepository.uploadFile(
        'robocall',
        storagePath,
        mp3Buffer,
        'audio/mpeg',
      );

      if (recordingUrl) {
        logger.info({ callId, recordingUrl }, 'Recording uploaded to Supabase');
      }

      // 5. Transcribe with Whisper
      const transcriptSummary = await this.transcribe(mp3Buffer, language);
      if (transcriptSummary) {
        logger.info({ callId, chars: transcriptSummary.length }, 'Transcription complete');
      }

      return { recordingUrl, transcriptSummary };
    } catch (err) {
      logger.error({ callId, err }, 'Recording processing failed');
      return { recordingUrl: null, transcriptSummary: null };
    } finally {
      // Clean up temp files
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export const recordingService = new RecordingService();
