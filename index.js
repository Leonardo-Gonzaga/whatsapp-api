// Importar módulos necessários
const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
require("dotenv").config(); // Carrega variáveis de ambiente do arquivo .env

// Configurar logger com múltiplos transportes para depuração e logging em arquivo
const logger = pino({
  level: "debug",
  transport: {
    targets: [
      {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:dd-mm-yyyy HH:MM:ss",
          ignore: "hostname,pid",
        },
      },
      {
        target: "pino/file",
        options: {
          destination: "/home/leogonzaga/whatsapp-api/logs/out.log",
          mkdir: true,
        },
      },
    ],
  },
  serializers: {
    payload: (payload) =>
      JSON.stringify(
        payload,
        (key, value) => (value instanceof Buffer ? "<Buffer>" : value),
        2
      ),
  },
});

// Constantes e variáveis globais
const AUTH_DIR = "/home/leogonzaga/whatsapp-api/whatsapp_auth_store";
let DISCONNECTION_WEBHOOK_URL = null;
const DISCONNECTION_WEBHOOK_FILE = path.join(
  AUTH_DIR,
  "disconnection-webhook.json"
);
const app = express();
app.use(bodyParser.json({ limit: "50mb" }));
const sessions = {};
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
const messageCache = new Map();
const MAX_CACHE_SIZE = 1000;
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

// Carregar webhook de desconexão ao iniciar
DISCONNECTION_WEBHOOK_URL = loadDisconnectionWebhookUrl();
if (DISCONNECTION_WEBHOOK_URL) {
  logger.info(`Webhook de desconexão carregado: ${DISCONNECTION_WEBHOOK_URL}`);
}

// =======================
// Funções Utilitárias
// =======================

// Função para gerar QR code em base64 sem prefixo
async function generateQRCodeBase64(qr) {
  try {
    const dataUrl = await QRCode.toDataURL(qr, { type: "image/png" });
    return dataUrl.split(",")[1];
  } catch (error) {
    logger.error(`Erro ao gerar QR code em base64: ${error.stack}`);
    throw error;
  }
}

// Função para extrair dados relevantes de uma mensagem do WhatsApp
async function extractMessageData(message) {
  // Log da mensagem recebida para depuração
  logger.debug("Mensagem recebida:", {
    type: message.type,
    from: message.from,
    to: message.to,
    body: message.body,
    hasMedia: message.hasMedia,
    rawData: message.rawData
      ? { id: message.rawData.id, ack: message.rawData.ack }
      : "null",
    timestamp: message.timestamp,
    fromMe: message.fromMe,
  });

  if (!message) {
    logger.error("Mensagem indefinida");
    return {};
  }

  if (!message.rawData) {
    logger.warn("Mensagem sem rawData - usando fallback");
    return {
      body: message.body || "",
      from: message.from,
      to: message.to,
      type: message.type,
    };
  }

  const data = message.rawData;
  let mediaData = null;
  let additionalData = {};

  if (
    message.hasMedia &&
    ["image", "video", "audio", "document", "sticker", "ptt"].includes(
      message.type
    )
  ) {
    if (message.type === "ptt") {
      logger.debug("Aguardando 2 segundos para mensagem PTT");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    try {
      const media = await message.downloadMedia();
      logger.debug("Mídia baixada:", {
        mimetype: media?.mimetype,
        filename: media?.filename,
        dataLength: media?.data?.length || 0,
      });
      if (media) {
        mediaData = {
          mimetype: media.mimetype,
          data: media.data,
          filename: media.filename || null,
        };
      }
    } catch (err) {
      logger.error(`Erro ao baixar mídia: ${err.stack}`);
    }
  }

  switch (message.type) {
    case "location":
      additionalData = {
        location: {
          lat: message.location?.latitude || null,
          lng: message.location?.longitude || null,
          description: message.location?.description || null,
        },
      };
      break;
    case "contact":
      additionalData = { contact: message.vCards || [] };
      break;
    case "buttons":
      additionalData = {
        buttons: message.dynamicReplyButtons || [],
        selectedButtonId: message.selectedButtonId || null,
      };
      break;
    case "list":
      additionalData = {
        list: message.dynamicReplyButtons || [],
        selectedRowId: message.selectedRowId || null,
      };
      break;
    case "poll":
      additionalData = {
        poll: {
          name: message.pollName || null,
          options: message.pollOptions || [],
          allowMultipleAnswers: message.allowMultipleAnswers || false,
          invalidated: message.pollInvalidated || false,
        },
      };
      break;
  }

  const payload = {
    sessionId: message.client?.authStrategy?.clientId || null,
    id: data.id || null,
    ack: data.ack || null,
    hasMedia: message.hasMedia || false,
    body: message.body || "",
    type: message.type || null,
    timestamp: message.timestamp || null,
    from: message.from || null,
    to: message.to || null,
    deviceType: message.deviceType || null,
    forwardingScore: message.forwardingScore || 0,
    isStatus: message.isStatus || false,
    isStarred: message.isStarred || false,
    fromMe: message.fromMe || false,
    hasQuotedMsg: message.hasQuotedMsg || false,
    hasReaction: message.hasReaction || false,
    vCards: message.vCards || [],
    mentionedIds: message.mentionedIds || [],
    groupMentions: message.groupMentions || [],
    isGif: message.isGif || false,
    links: message.links || [],
    media: mediaData,
    ...additionalData,
  };

  logger.debug("Payload construído:", payload);
  return payload;
}

// Função para limpar mensagens expiradas do cache
function cleanExpiredMessages() {
  const now = Date.now();
  for (const [id, message] of messageCache) {
    if (now - message.timestamp * 1000 > CACHE_EXPIRATION_MS) {
      messageCache.delete(id);
    }
  }
}

// =======================
// Funções de Gerenciamento de Sessões
// =======================

// Função para criar um novo cliente WhatsApp para uma sessão
function createClient(sessionId) {
  const cleanSessionId = sessionId.replace(/^session-/, "");
  return new Client({
    authStrategy: new LocalAuth({
      clientId: cleanSessionId,
      dataPath: AUTH_DIR,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
      ],
      ignoreHTTPSErrors: true,
    },
    restartOnAuthFail: false, // Desabilitar reconexão automática
  });
}

// Função para configurar ouvintes de eventos para o cliente WhatsApp
function configureClientEvents(sessionId) {
  const client = sessions[sessionId].client;

  // Evento de QR code
  client.on("qr", async (qr) => {
    if (sessions[sessionId].status !== "starting") {
      logger.debug(
        `Ignorando QR code para sessão ${sessionId} (não está iniciando)`
      );
      return;
    }
    sessions[sessionId].qrCode = qr;
    sessions[sessionId].status = "qr_required";
    sessions[sessionId].lastUpdate = new Date();
    try {
      sessions[sessionId].qrCodeBase64 = await generateQRCodeBase64(qr);
      logger.info(`QR Code em base64 gerado para sessão ${sessionId}`);
    } catch (error) {
      sessions[sessionId].qrCodeBase64 = null;
      logger.error(
        `Falha ao gerar QR code em base64 para ${sessionId}: ${error.stack}`
      );
    }
    qrcode.generate(qr, { small: true });
    logger.info(`QR Code gerado para sessão ${sessionId}`);
  });

  // Evento de autenticação
  client.on("authenticated", () => {
    sessions[sessionId].status = "authenticated";
    sessions[sessionId].qrCode = null;
    sessions[sessionId].qrCodeBase64 = null;
    sessions[sessionId].lastUpdate = new Date();
    logger.info(`Sessão ${sessionId} autenticada`);
    markSessionAsActive(sessionId);
  });

  // Evento de prontidão
  client.on("ready", () => {
    sessions[sessionId].status = "connected";
    sessions[sessionId].lastUpdate = new Date();
    logger.info(`Sessão ${sessionId} pronta e conectada`);
  });

  // Evento de falha de autenticação
  client.on("auth_failure", (msg) => {
    sessions[sessionId].status = "auth_failed";
    sessions[sessionId].qrCode = null;
    sessions[sessionId].qrCodeBase64 = null;
    sessions[sessionId].lastUpdate = new Date();
    logger.error(`Falha na autenticação da sessão ${sessionId}: ${msg}`);
    sessions[sessionId].client = null;
    markSessionAsDisconnected(sessionId);
  });

  // Evento de desconexão
  client.on("disconnected", async (reason) => {
    sessions[sessionId].isActive = false; // Marca a sessão como inativa
    sessions[sessionId].status = `disconnected: ${reason}`;
    sessions[sessionId].qrCode = null;
    sessions[sessionId].qrCodeBase64 = null;
    sessions[sessionId].lastUpdate = new Date();
    logger.warn(`Sessão ${sessionId} desconectada: ${reason}`);
    if (DISCONNECTION_WEBHOOK_URL) {
      try {
        const payload = {
          event: "disconnection",
          sessionId,
          reason,
          timestamp: Math.floor(Date.now() / 1000),
        };
        await axios.post(DISCONNECTION_WEBHOOK_URL, payload);
        logger.info(
          `Notificação de desconexão enviada para: ${DISCONNECTION_WEBHOOK_URL}`,
          { payload }
        );
      } catch (err) {
        logger.error(`Erro ao enviar notificação de desconexão: ${err.stack}`);
      }
    }
    client.destroy();
    sessions[sessionId].client = null;
    markSessionAsDisconnected(sessionId);
  });

  // Evento de mensagem
  client.on("message", async (message) => {
    try {
      if (!sessions[sessionId].isActive) {
        logger.warn(`Sessão ${sessionId} não está ativa. Ignorando mensagem.`);
        return;
      }
      const chat = await message.getChat();
      if (!chat.isGroup && !message.from.endsWith("@newsletter")) {
        if (messageCache.size >= MAX_CACHE_SIZE) {
          messageCache.clear();
          logger.warn(`Cache de mensagens limpo para sessão ${sessionId}`);
        }
        messageCache.set(message.id.id, message);
        logger.debug(`Mensagem adicionada ao cache: ${message.id.id}`);
        const payload = await extractMessageData(message);
        logger.info(`Mensagem em ${sessionId}: %j`, payload);
        const { webhookUrl } = sessions[sessionId];
        if (webhookUrl) {
          await axios.post(webhookUrl, payload);
          logger.info(`Payload enviado para webhook: ${webhookUrl}`, {
            payload,
          });
        }
      } else {
        logger.debug(
          `Ignorando mensagem de grupo ou newsletter: ${message.from}`
        );
      }
    } catch (err) {
      if (
        err.name === "ProtocolError" &&
        err.message.includes("Target closed")
      ) {
        logger.warn(
          `Sessão ${sessionId} desconectada. Ignorando erro de contexto fechado.`
        );
      } else {
        logger.error(`Erro ao processar mensagem: ${err.stack}`);
      }
    }
  });

  // Evento de reação a mensagem
  client.on("message_reaction", async (reaction) => {
    try {
      if (!reaction || !reaction.msgId || !reaction.senderId) {
        logger.warn("Reação inválida recebida:", reaction);
        return;
      }
      const sessionId = reaction.client.authStrategy.clientId;
      if (reaction.msgId.remote.endsWith("@newsletter")) {
        logger.debug(
          `Ignorando reação de newsletter: ${reaction.msgId.remote}`
        );
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const reactionTime = reaction.timestamp || now;
      const timeThreshold = 24 * 60 * 60;
      if (now - reactionTime > timeThreshold) {
        logger.debug(
          `Ignorando reação antiga: ${reaction.msgId.id} (timestamp: ${reactionTime})`
        );
        return;
      }
      const originalMessage = messageCache.get(reaction.msgId.id);
      if (originalMessage) {
        const chat = await originalMessage.getChat();
        if (chat.isGroup) {
          logger.debug(`Ignorando reação de grupo: ${reaction.msgId.id}`);
          return;
        }
      } else {
        const remote = reaction.msgId.remote;
        if (remote.endsWith("@g.us")) {
          logger.debug(
            `Ignorando reação de grupo (baseado em remote): ${remote}`
          );
          return;
        }
      }
      const reactionPayload = {
        sessionId,
        type: "reaction",
        reactionId: reaction.id || null,
        emoji: reaction.reaction || null,
        senderId: reaction.senderId,
        targetMsgId: reaction.msgId.id,
        timestamp: reactionTime,
        isRemoved: reaction.reaction === "",
        read: reaction.read || false,
        ack: reaction.ack || null,
        orphan: reaction.orphan || 0,
        orphanReason: reaction.orphanReason || null,
      };
      logger.info("Reação de chat privado detectada:", reactionPayload);
      if (originalMessage) {
        reactionPayload.originalMessage = await extractMessageData(
          originalMessage
        );
        logger.debug(
          `Mensagem original encontrada no cache: ${reaction.msgId.id}`
        );
      } else {
        logger.warn(
          `Mensagem original não encontrada no cache: ${reaction.msgId.id}`
        );
      }
      const { webhookUrl } = sessions[sessionId];
      if (webhookUrl) {
        await axios.post(webhookUrl, reactionPayload);
        logger.info(`Reação enviada para webhook: ${webhookUrl}`);
      } else {
        logger.warn(`Nenhum webhook configurado para a sessão ${sessionId}`);
      }
    } catch (err) {
      logger.error(`Erro ao processar reação: ${err.stack}`);
    }
  });
}

// Função para migrar arquivos de sessão antigos para a nova estrutura
function migrateSessionFiles() {
  const files = fs.readdirSync(AUTH_DIR);
  const sessionFolders = files.filter(
    (name) =>
      name.startsWith("session-") &&
      !name.endsWith("-webhook.json") &&
      !name.endsWith("-state.json")
  );
  sessionFolders.forEach((sessionFolder) => {
    const sessionId = sessionFolder.replace(/^session-/, "");
    const oldWebhookFile = path.join(
      AUTH_DIR,
      `session-${sessionId}-webhook.json`
    );
    const oldStateFile = path.join(AUTH_DIR, `session-${sessionId}-state.json`);
    const newWebhookFile = path.join(AUTH_DIR, sessionFolder, `webhook.json`);
    const newStateFile = path.join(AUTH_DIR, sessionFolder, `state.json`);
    if (fs.existsSync(oldWebhookFile)) {
      fs.mkdirSync(path.join(AUTH_DIR, sessionFolder), { recursive: true });
      fs.renameSync(oldWebhookFile, newWebhookFile);
      logger.info(`Migrado: ${oldWebhookFile} -> ${newWebhookFile}`);
    }
    if (fs.existsSync(oldStateFile)) {
      fs.mkdirSync(path.join(AUTH_DIR, sessionFolder), { recursive: true });
      fs.renameSync(oldStateFile, newStateFile);
      logger.info(`Migrado: ${oldStateFile} -> ${newStateFile}`);
    }
  });
}

// Função para verificar se uma sessão está ativa com base no arquivo de estado
function isSessionActive(sessionId) {
  const stateFile = path.join(AUTH_DIR, `session-${sessionId}`, `state.json`);
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile));
    return state.active === true;
  }
  return false;
}

// Função para marcar uma sessão como desconectada no arquivo de estado
function markSessionAsDisconnected(sessionId) {
  const sessionDir = path.join(AUTH_DIR, `session-${sessionId}`);
  const stateFile = path.join(sessionDir, `state.json`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ active: false }, null, 2));
}

// Função para marcar uma sessão como ativa no arquivo de estado
function markSessionAsActive(sessionId) {
  const sessionDir = path.join(AUTH_DIR, `session-${sessionId}`);
  const stateFile = path.join(sessionDir, `state.json`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ active: true }, null, 2));
}

// =======================
// Funções de Gerenciamento de Webhooks
// =======================

// Função para salvar a URL do webhook de desconexão em um arquivo
function saveDisconnectionWebhookUrl(url) {
  fs.writeFileSync(
    DISCONNECTION_WEBHOOK_FILE,
    JSON.stringify({ url }, null, 2)
  );
  logger.info(`Webhook de desconexão salvo: ${url}`);
}

// Função para carregar a URL do webhook de desconexão de um arquivo
function loadDisconnectionWebhookUrl() {
  if (fs.existsSync(DISCONNECTION_WEBHOOK_FILE)) {
    const data = JSON.parse(fs.readFileSync(DISCONNECTION_WEBHOOK_FILE));
    return data.url;
  }
  return null;
}

// Função para salvar a URL do webhook de uma sessão em um arquivo
function saveWebhookUrl(sessionId, webhookUrl) {
  const sessionDir = path.join(AUTH_DIR, `session-${sessionId}`);
  const webhookFile = path.join(sessionDir, `webhook.json`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(webhookFile, JSON.stringify({ webhookUrl }, null, 2));
  logger.info(`Webhook salvo para ${sessionId}: ${webhookUrl}`);
}

// Função para carregar a URL do webhook de uma sessão de um arquivo
function loadWebhookUrl(sessionId) {
  const webhookFile = path.join(
    AUTH_DIR,
    `session-${sessionId}`,
    `webhook.json`
  );
  if (fs.existsSync(webhookFile)) {
    const data = JSON.parse(fs.readFileSync(webhookFile));
    return data.webhookUrl;
  }
  return null;
}

// =======================
// Funções de Manipulação de Mensagens
// =======================

// Função para lidar com o envio de mensagens, imagens ou áudios
const handleMessageSending = async (req, res, type, handler) => {
  try {
    const { sessionId, number } = req.body;
    if (!sessions[sessionId]) {
      return res.status(404).json({ error: "Sessão não encontrada" });
    }
    const client = sessions[sessionId].client;
    const chat = await client.getChatById(`${number}@c.us`);
    const message = await handler(client, chat, req.body);
    if (message && message.id && message.id.id) {
      if (messageCache.size >= MAX_CACHE_SIZE) {
        messageCache.clear();
        logger.warn(`Cache de mensagens limpo para sessão ${sessionId}`);
      }
      messageCache.set(message.id.id, message);
      logger.debug(`Mensagem enviada adicionada ao cache: ${message.id.id}`);
    } else {
      logger.warn(`Mensagem enviada sem ID válido: ${type}`);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    logger.error(`Erro ao enviar ${type}: ${error.stack}`);
    res.status(500).json({ error: error.message });
  }
};

// =======================
// Rotas do Servidor
// =======================

// Middleware para autenticação via API key
const authenticate = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "API key inválida" });
  }
  next();
};

// Rota para iniciar ou reiniciar uma sessão (requer autenticação)
app.post("/start-session", authenticate, async (req, res) => {
  try {
    const { sessionId, webhookUrl } = req.body;
    if (!sessionId)
      return res.status(400).json({ error: "sessionId é obrigatório" });
    if (sessions[sessionId]?.status === "connected")
      return res.status(400).json({ error: "Sessão já está conectada" });
    if (sessions[sessionId]) {
      if (sessions[sessionId].client) sessions[sessionId].client.destroy();
      delete sessions[sessionId];
    }
    const client = createClient(sessionId);
    sessions[sessionId] = {
      client,
      status: "starting",
      qrCode: null,
      qrCodeBase64: null,
      lastUpdate: new Date(),
      webhookUrl: webhookUrl || null,
      isActive: true,
    };
    if (webhookUrl) saveWebhookUrl(sessionId, webhookUrl);
    configureClientEvents(sessionId);
    await client.initialize();
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
      if (sessions[sessionId].qrCodeBase64) {
        return res.status(200).json({
          success: true,
          sessionId,
          data: sessions[sessionId].qrCodeBase64,
        });
      }
      if (sessions[sessionId].status === "connected") {
        return res
          .status(200)
          .json({ success: true, sessionId, message: "Sessão já conectada" });
      }
      if (sessions[sessionId].status === "auth_failed") {
        return res
          .status(500)
          .json({ error: "Falha na autenticação da sessão" });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }
    return res.status(408).json({ error: "Timeout ao aguardar QR code" });
  } catch (error) {
    logger.error(`Erro ao iniciar sessão: ${error.stack}`);
    res.status(500).json({ error: error.message });
  }
});

// Rota para definir o webhook de uma sessão específica (requer autenticação)
app.post("/set-webhook", authenticate, (req, res) => {
  const { sessionId, webhookUrl } = req.body;
  if (!sessions[sessionId])
    return res.status(404).json({ error: "Sessão não encontrada" });
  sessions[sessionId].webhookUrl = webhookUrl;
  saveWebhookUrl(sessionId, webhookUrl);
  logger.info(`Webhook atualizado para ${sessionId}: ${webhookUrl}`);
  res.status(200).json({ success: true });
});

// Rota para definir o webhook para todas as sessões (requer autenticação)
app.post("/set-webhook-all", authenticate, (req, res) => {
  const { webhookUrl } = req.body;
  Object.keys(sessions).forEach((id) => {
    sessions[id].webhookUrl = webhookUrl;
    saveWebhookUrl(id, webhookUrl);
    logger.info(`Webhook para ${id} agora é ${webhookUrl}`);
  });
  res.status(200).json({ success: true, appliedTo: Object.keys(sessions) });
});

// Rota para definir o webhook de desconexão (requer autenticação)
app.post("/set-disconnection-webhook", authenticate, (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl)
    return res.status(400).json({ error: "webhookUrl é obrigatório" });
  DISCONNECTION_WEBHOOK_URL = webhookUrl;
  saveDisconnectionWebhookUrl(webhookUrl);
  logger.info(`Webhook de desconexão configurado: ${webhookUrl}`);
  res.status(200).json({ success: true, webhookUrl });
});

// Rota para listar todas as instâncias (requer autenticação)
app.get("/instances", authenticate, (req, res) => {
  const instances = Object.keys(sessions).map((id) => ({
    sessionId: id,
    status: sessions[id].status,
    lastUpdate: sessions[id].lastUpdate,
    qrCode: sessions[id].status === "qr_required" ? sessions[id].qrCode : null,
    webhookUrl: sessions[id].webhookUrl,
  }));
  res.status(200).json(instances);
});

// Rota para deletar uma instância específica (requer autenticação)
app.delete("/instance/:sessionId", authenticate, (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessions[sessionId])
      return res.status(404).json({ error: "Sessão não encontrada" });
    if (sessions[sessionId].client) sessions[sessionId].client.destroy();
    const sessionFolder = path.join(AUTH_DIR, `session-${sessionId}`);
    if (fs.existsSync(sessionFolder)) {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
      logger.info(`Sessão ${sessionId} removida`);
    }
    delete sessions[sessionId];
    res.status(200).json({ success: true, deletedSession: sessionId });
  } catch (error) {
    logger.error(`Erro ao remover sessão: ${error.stack}`);
    res.status(500).json({ error: error.message });
  }
});

// Rota para limpar todas as sessões não conectadas (requer autenticação)
app.delete("/clear-all-sessions", authenticate, (req, res) => {
  try {
    const { clearDisconnectedWebhook = false } = req.body;
    const deletedSessions = [];
    Object.keys(sessions).forEach((sessionId) => {
      if (sessions[sessionId].status !== "connected") {
        if (sessions[sessionId].client) sessions[sessionId].client.destroy();
        const sessionFolder = path.join(AUTH_DIR, `session-${sessionId}`);
        if (fs.existsSync(sessionFolder)) {
          fs.rmSync(sessionFolder, { recursive: true, force: true });
          deletedSessions.push(sessionId);
          logger.info(
            `Sessão ${sessionId} removida (status: ${sessions[sessionId].status})`
          );
        }
        delete sessions[sessionId];
      }
    });
    if (clearDisconnectedWebhook) {
      const disconnectedWebhookFile = path.join(
        AUTH_DIR,
        "disconnection-webhook.json"
      );
      if (fs.existsSync(disconnectedWebhookFile)) {
        fs.unlinkSync(disconnectedWebhookFile);
        logger.info(`Removido: ${disconnectedWebhookFile}`);
      }
    }
    const deletedCount = deletedSessions.length;
    logger.info(`Limpeza concluída: ${deletedCount} instâncias removidas`);
    res.status(200).json({ success: true, deletedCount, deletedSessions });
  } catch (error) {
    logger.error(`Erro ao limpar sessões: ${error.stack}`);
    res.status(500).json({ error: error.message });
  }
});

// Rota para enviar uma mensagem de texto (requer autenticação)
app.post("/send-message", authenticate, async (req, res) =>
  handleMessageSending(req, res, "mensagem", async (c, chat, b) => {
    if (b.showTyping) {
      await chat.sendStateTyping();
      await new Promise((r) => setTimeout(r, b.duration || 2000));
    }
    return await chat.sendMessage(b.message);
  })
);

// Rota para enviar uma imagem (requer autenticação)
app.post("/send-image", authenticate, async (req, res) =>
  handleMessageSending(req, res, "imagem", async (c, chat, b) => {
    let media;
    if (b.isUrl) {
      const r = await axios.get(b.image, { responseType: "arraybuffer" });
      media = new MessageMedia(
        r.headers["content-type"],
        Buffer.from(r.data).toString("base64"),
        b.filename || "image.jpg"
      );
    } else {
      media = new MessageMedia(
        b.mimeType || "image/jpeg",
        b.image,
        b.filename || "image.jpg"
      );
    }
    return await chat.sendMessage(media, { caption: b.caption || "" });
  })
);

// Rota para enviar um áudio (requer autenticação)
app.post("/send-audio", authenticate, async (req, res) =>
  handleMessageSending(req, res, "áudio", async (c, chat, b) => {
    if (b.showRecording) {
      await chat.sendStateRecording();
      await new Promise((r) => setTimeout(r, b.duration || 3000));
    }
    let media;
    if (b.isUrl) {
      const r = await axios.get(b.audio, { responseType: "arraybuffer" });
      media = new MessageMedia(
        r.headers["content-type"],
        Buffer.from(r.data).toString("base64"),
        b.filename || "audio.ogg"
      );
    } else {
      media = new MessageMedia(
        b.mimeType || "audio/ogg; codecs=opus",
        b.audio,
        b.filename || "audio.ogg"
      );
    }
    return await chat.sendMessage(media, {
      sendAudioAsVoice: b.isVoiceMessage !== false,
    });
  })
);

// =======================
// Inicialização e Tratamento de Erros
// =======================

// Função para carregar sessões salvas do disco
function carregarSessoesSalvas() {
  logger.info("Carregando sessões persistentes...");
  const folders = fs
    .readdirSync(AUTH_DIR)
    .filter(
      (name) =>
        name.startsWith("session-") &&
        !name.endsWith("-webhook.json") &&
        !name.endsWith("-state.json")
    );
  folders.forEach((sessionFolder) => {
    const sessionId = sessionFolder.replace(/^session-/, "");
    if (!sessions[sessionId]) {
      const webhookUrl = loadWebhookUrl(sessionId);
      const sessionPath = path.join(AUTH_DIR, sessionFolder);
      if (!isSessionActive(sessionId)) {
        logger.warn(
          `Sessão ${sessionId} está desconectada ou não possui estado ativo. Aguardando autenticação manual.`
        );
        sessions[sessionId] = {
          client: null,
          status: "auth_required",
          qrCode: null,
          lastUpdate: new Date(),
          webhookUrl,
          isActive: false,
        };
        return;
      }
      logger.info(
        `Inicializando sessão persistente: ${sessionId} com webhook: ${
          webhookUrl || "nenhum"
        }`
      );
      const client = createClient(sessionId);
      sessions[sessionId] = {
        client,
        status: "connecting",
        qrCode: null,
        lastUpdate: new Date(),
        webhookUrl,
        isActive: true,
      };
      configureClientEvents(sessionId);
      client.initialize();
    }
  });
}

// Configurar logs do PM2
process.on("PM2:Log", (log) => {
  if (log.process.name === "whatsapp-api") logger.info(log.data);
});

// Iniciar o servidor, migrar arquivos de sessão e carregar sessões salvas
migrateSessionFiles();
app.listen(3000, () => {
  logger.info("API iniciada na porta 3000");
  carregarSessoesSalvas();
});

// Tratar exceções não capturadas
process.on("uncaughtException", (err) => {
  logger.fatal(`Erro não tratado: ${err.stack}`);
});

// Tratar promessas rejeitadas não tratadas
process.on("unhandledRejection", (reason, promise) => {
  if (reason.name === 'ProtocolError' && reason.message.includes('Target closed')) {
    logger.warn('Ignorando ProtocolError de contexto fechado em promessa rejeitada.');
  } else {
    logger.error(`Promessa rejeitada não tratada: ${reason.stack || reason}`);
  }
});
