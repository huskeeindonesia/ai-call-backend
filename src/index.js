import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { TwilioOpenAIBridge } from './realtime/bridge.js';
import { callRepository } from './repositories/call-repository.js';

// Allow self-signed / expired certs on self-hosted Supabase
if (process.env.SUPABASE_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  logger.warn('TLS certificate verification disabled (SUPABASE_IGNORE_SSL=true)');
}

const app = buildApp();
const server = createServer(app);

// WebSocket server — handles Twilio Media Stream upgrades only
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname.startsWith('/twilio/media-stream/')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  const callId = pathname.split('/').pop();

  logger.info({ callId }, 'Twilio Media Stream WS connected');

  // Use the pre-warmed bridge if it was started during ring time.
  const prewarmed = callRepository.getBridge(callId);
  callRepository.deleteBridge(callId);

  let bridge;
  if (prewarmed) {
    prewarmed.twilioWs = ws;  // attach the live Twilio WebSocket
    bridge = prewarmed;
  } else {
    // Fallback: cold-start (inbound call or pre-warm not available)
    const call = callRepository.get(callId);
    const aiInfo = call?.ai_session_info ?? {};
    bridge = new TwilioOpenAIBridge(ws, callId, {
      systemPrompt: aiInfo.system_prompt,
      firstMessage: aiInfo.first_message,
      language: aiInfo.language || call?.language || 'id',
    });
  }

  ws.on('message', (data) => bridge.handleTwilioMessage(data));
  ws.on('close', () => {
    logger.info({ callId }, 'Twilio Media Stream WS closed');
    bridge.close();
  });
  ws.on('error', (err) => {
    logger.error({ callId, err }, 'Twilio Media Stream WS error');
    bridge.close();
  });
});

server.listen(env.port, () => {
  logger.info({ port: env.port, publicUrl: env.publicUrl }, 'ai-call-backend listening');
});
