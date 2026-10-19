// handlers/business_connection.js — тонкая обёртка: вся логика в lib/app.js.
import { app } from '../lib/deps.js';

export default async function (payload, ctx) {
  await app.handle('business_connection', payload, ctx);
}
