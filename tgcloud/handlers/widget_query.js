// Bot API 10.4 widget_query update handler (Telegram Serverless).
import { app } from '../lib/deps.js';

export default async function (payload, ctx) {
  await app.handle('widget_query', payload, ctx);
}
