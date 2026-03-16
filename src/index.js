import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { TwilioOpenAIBridge } from './realtime/bridge.js';
import { callRepository } from './repositories/call-repository.js';

const app = buildApp();
const server = createServer(app);

// WebSocket server — handles Twilio Media Stream connections
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

  logger.info({ callId }, 'Twilio Media Stream WebSocket connected');

  const call = callRepository.get(callId);
  const aiInfo = call?.ai_session_info ?? {};

  const bridge = new TwilioOpenAIBridge(ws, callId, {
    systemPrompt: aiInfo.system_prompt,
    firstMessage: aiInfo.first_message
  });

  ws.on('message', (data) => bridge.handleTwilioMessage(data));

  ws.on('close', () => {
    logger.info({ callId }, 'Twilio Media Stream WebSocket closed');
    bridge.close();
  });

  ws.on('error', (err) => {
    logger.error({ callId, err }, 'Twilio Media Stream WebSocket error');
    bridge.close();
  });
});

server.listen(env.port, () => {
  logger.info({ port: env.port, publicUrl: env.publicUrl }, 'ai-call-backend listening');
});
