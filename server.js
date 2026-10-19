import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

// Настройки из .env, если файл есть (без него сайт запускается в демо-режиме).
try {
  process.loadEnvFile(path.join(here, ".env"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.LLM_MODEL || "claude-opus-5-5";
const EFFORT = process.env.LLM_EFFORT || "low"; // low | medium | high | xhigh | max
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 16000;
const MAX_HISTORY = 40; // сколько последних сообщений отправлять модели
const MAX_MESSAGE_LENGTH = 20000;

const SYSTEM_PROMPT =
  process.env.LLM_SYSTEM_PROMPT ||
  `Ты — дружелюбный и компетентный ИИ-ассистент на сайте. Отвечай на вопросы пользователей
понятно и по существу, на языке пользователя. Используй Markdown (списки, заголовки, блоки кода),
когда это делает ответ нагляднее. Если не знаешь ответа — честно скажи об этом.`;

// Без ключа сайт работает в демо-режиме, чтобы интерфейс можно было проверить сразу.
const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasCredentials ? new Anthropic() : null;

// С каких сайтов разрешено обращаться к API (например, https://meshk0v.github.io), через запятую.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(here, "public")));

app.get("/api/config", (_req, res) => {
  res.json({ model: MODEL, demo: !client });
});

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "Список сообщений пуст";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return "Неверная роль сообщения";
    if (typeof m.content !== "string" || !m.content.trim()) return "Пустое сообщение";
    if (m.content.length > MAX_MESSAGE_LENGTH) return "Сообщение слишком длинное";
  }
  if (messages.at(-1).role !== "user") return "Последнее сообщение должно быть от пользователя";
  return null;
}

// Ответ стримится в формате Server-Sent Events: каждое событие — JSON {type, ...}.
app.post("/api/chat", async (req, res) => {
  const error = validateMessages(req.body?.messages);
  if (error) return res.status(400).json({ error });

  // История обрезается до последних сообщений и должна начинаться с реплики пользователя.
  let messages = req.body.messages
    .slice(-MAX_HISTORY)
    .map(({ role, content }) => ({ role, content }));
  while (messages[0].role !== "user") messages = messages.slice(1);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (!client) {
    await streamDemo(messages.at(-1).content, send, res);
    send({ type: "done" });
    return res.end();
  }

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORT },
    // Если классификаторы безопасности отклонят запрос, API сам повторит его на резервной модели.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages,
  });

  // Пользователь закрыл вкладку или нажал «Стоп» — прекращаем генерацию.
  res.on("close", () => {
    if (!res.writableFinished) stream.abort();
  });

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send({ type: "delta", text: event.delta.text });
      }
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      send({ type: "error", message: "Ассистент не может ответить на этот запрос." });
    } else if (message.stop_reason === "max_tokens") {
      send({ type: "notice", message: "Ответ был обрезан из-за ограничения длины." });
    }
    send({ type: "done" });
  } catch (err) {
    if (stream.aborted || res.destroyed) return;
    console.error("LLM error:", err);
    send({ type: "error", message: describeError(err) });
  }
  res.end();
});

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Неверный API-ключ. Проверьте настройки сервера.";
  if (err instanceof Anthropic.RateLimitError) return "Слишком много запросов. Попробуйте через минуту.";
  if (err instanceof Anthropic.BadRequestError) return "Некорректный запрос к модели.";
  if (err instanceof Anthropic.APIConnectionError) return "Не удалось связаться с сервисом модели.";
  if (err instanceof Anthropic.APIError && err.status >= 500) return "Сервис модели временно недоступен.";
  return "Произошла ошибка при получении ответа.";
}

async function streamDemo(question, send, res) {
  const answer =
    `**Демо-режим.** Сервер запущен без API-ключа, поэтому это тестовый ответ.\n\n` +
    `Вы спросили:\n\n> ${question.replace(/\n/g, "\n> ")}\n\n` +
    `Чтобы подключить языковую модель:\n\n` +
    "1. Скопируйте `.env.example` в `.env`\n" +
    "2. Укажите `ANTHROPIC_API_KEY`\n" +
    "3. Перезапустите сервер командой `npm start`\n";
  for (const chunk of answer.match(/.{1,6}/gs)) {
    if (res.destroyed) return;
    send({ type: "delta", text: chunk });
    await new Promise((r) => setTimeout(r, 25));
  }
}

app.listen(PORT, () => {
  console.log(`ИИ-ассистент: http://localhost:${PORT}`);
  console.log(client ? `Модель: ${MODEL} (effort: ${EFFORT})` : "API-ключ не найден — демо-режим");
});
