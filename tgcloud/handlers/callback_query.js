// handlers/callback_query.js — тонкая обёртка: вся логика в lib/app.js.
import { app } from '../lib/deps.js';

export default async function (payload, ctx) {
  await app.handle('callback_query', payload, ctx);
}
