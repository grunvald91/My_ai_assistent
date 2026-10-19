// handlers/business_message.js — тонкая обёртка: вся логика в lib/app.js.
import { app } from '../lib/deps.js';

export default async function (payload, ctx) {
  await app.handle('business_message', payload, ctx);
}
