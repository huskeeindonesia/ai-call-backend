import { nanoid } from 'nanoid';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { supabaseRepository } from '../repositories/supabase-repository.js';

// ─── G.711 μ-law → PCM16 lookup table (built once at startup) ─────────────────
// Reference: ITU-T G.711, Section 4.2.2
const ULAW_TO_PCM16 = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;             // invert all bits (μ-law encoding inverts)
    const sign = u & 0x80;           // bit 7 = sign
    const exp  = (u >> 4) & 0x07;   // bits 4-6 = exponent
    const mant = u & 0x0f;           // bits 0-3 = mantissa
    const magnitude = ((mant | 0x10) << (exp + 3)) - 132; // ITU-T correct formula
    table[i] = sign ? -magnitude : magnitude;
  }
  return table;
})();

/** Decode an array of base64-encoded G.711 μ-law chunks to a PCM16 Int16Array. */
function ulawChunksToPcm(base64Chunks) {
  if (!base64Chunks || base64Chunks.length === 0) return new Int16Array(0);
  const decoded = base64Chunks.map((b) => Buffer.from(b, 'base64'));
  const totalBytes = decoded.reduce((n, b) => n + b.length, 0);
  const pcm = new Int16Array(totalBytes);
  let off = 0;
  for (const chunk of decoded) {
    for (let i = 0; i < chunk.length; i++) pcm[off++] = ULAW_TO_PCM16[chunk[i]];
  }
  return pcm;
}

/**
 * Mix two PCM16 streams (caller + AI) into one by summing with clamp.
 * Handles streams of different lengths by zero-padding the shorter one.
 */
function mixPcm(pcmA, pcmB) {
  const len = Math.max(pcmA.length, pcmB.length);
  const mixed = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const a = i < pcmA.length ? pcmA[i] : 0;
    const b = i < pcmB.length ? pcmB[i] : 0;
    mixed[i] = Math.max(-32768, Math.min(32767, a + b));
  }
  return mixed;
}

/** Convert mixed PCM16 Int16Array → WAV Buffer (8 kHz, mono, 16-bit). */
function pcmToWav(pcm) {

  const pcmBuf = Buffer.from(pcm.buffer);

  // WAV header (44 bytes): 8 kHz, mono, 16-bit PCM
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // PCM subchunk size
  header.writeUInt16LE(1, 20);             // AudioFormat = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuf.length, 40);

  return Buffer.concat([header, pcmBuf]);
}

/**
 * Build a time-aligned PCM16 array from outbound recording turns.
 * Each turn is { ms: number, chunks: string[] } where:
 *   - ms   = wall-clock offset from call start when this AI turn began
 *   - chunks = ordered array of base64 μ-law delta payloads for this turn
 *
 * Within a turn, chunks are placed SEQUENTIALLY (no wall-clock timestamps per
 * delta — they arrived in network bursts, not real-time, so per-chunk timestamps
 * would cause massive PCM overlap and crackling).
 * Between turns, the silence gap is preserved by the ms offset.
 */
function timedUlawChunksToPcm(timedTurns, totalSamples) {
  const pcm = new Int16Array(totalSamples); // zero-filled = silence
  for (const { ms, chunks } of timedTurns) {
    let samplePos = Math.round((ms / 1000) * 8000);
    for (const data of chunks) {
      const raw = Buffer.from(data, 'base64');
      for (let i = 0; i < raw.length; i++) {
        const pos = samplePos + i;
        if (pos < totalSamples) pcm[pos] = ULAW_TO_PCM16[raw[i]];
      }
      samplePos += raw.length; // advance sequentially — next chunk follows immediately
    }
  }
  return pcm;
}

/** Full pipeline util used by processRecording. */
function ulawChunksToWav(inboundChunks, outboundChunks) {
  const inPcm = ulawChunksToPcm(inboundChunks);
  if (!outboundChunks || outboundChunks.length === 0) return pcmToWav(inPcm);
  // outboundChunks is [{ ms, data }] — time-aligned placement
  const outPcm = timedUlawChunksToPcm(outboundChunks, inPcm.length);
  return pcmToWav(mixPcm(inPcm, outPcm));
}

class RecordingService {
  /**
   * Transcribe a WAV buffer using OpenAI Whisper (whisper-1 — cheapest STT model).
   * Returns the transcript string, or null on failure.
   */
  async transcribe(wavBuffer, language = 'id') {
    if (!env.openAiApiKey) return null;
    try {
      const formData = new FormData();
      formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'recording.wav');
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
   * Full pipeline: ulaw chunks → WAV → Supabase Storage → Whisper transcript.
   * Returns { recordingUrl, transcriptSummary }.
   */
  async processRecording(callId, inboundChunks, language = 'id', outboundChunks = []) {
    if (!inboundChunks || inboundChunks.length === 0) {
      logger.warn({ callId }, 'No audio chunks — skipping recording');
      return { recordingUrl: null, transcriptSummary: null };
    }

    logger.info({ callId, inbound: inboundChunks.length, outbound: outboundChunks.length }, 'Processing call recording');

    // 1. Convert + mix caller and AI audio to WAV
    const wavBuffer = ulawChunksToWav(inboundChunks, outboundChunks);

    // 2. Unique filename: call_id + unix-ms + random suffix
    const filename = `${callId}-${Date.now()}-${nanoid(8)}.wav`;
    const storagePath = `recording/${filename}`;

    // 3. Upload to Supabase Storage (bucket: robocall)
    const recordingUrl = await supabaseRepository.uploadFile(
      'robocall',
      storagePath,
      wavBuffer,
      'audio/wav',
    );

    if (recordingUrl) {
      logger.info({ callId, recordingUrl }, 'Recording uploaded to Supabase');
    }

    // 4. Transcribe with Whisper
    const transcriptSummary = await this.transcribe(wavBuffer, language);
    if (transcriptSummary) {
      logger.info({ callId, chars: transcriptSummary.length }, 'Transcription complete');
    }

    return { recordingUrl, transcriptSummary };
  }
}

export const recordingService = new RecordingService();
