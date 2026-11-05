// Bot API 10.4 shared_widget_query update handler (Telegram Serverless).
import { app } from '../lib/deps.js';

export default async function (payload, ctx) {
  await app.handle('shared_widget_query', payload, ctx);
}
