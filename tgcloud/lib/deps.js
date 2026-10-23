// deps.js — проводка: настоящие sdk, база, ключи → готовое приложение. Единственное место, где
// модули бота соприкасаются с платформой; всё остальное получает зависимости через createApp.

import { api, fetch, InputFile } from 'sdk';
import * as store from './store.js';
import { createLlm } from './llm.js';
import { createApp } from './app.js';
import { API_BASE, DEFAULTS } from './config.js';
import { nowSec, parseIdList } from './util.js';
import { CLAUDEHUB_API_KEY, OWNER_IDS, GH_PAT, SELF_REPO } from './secrets.js';

const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const llm = createLlm({ fetch, apiKey: CLAUDEHUB_API_KEY, base: API_BASE, sleep, retries: DEFAULTS.retries, pulse: store.ping });

export const app = createApp({
  api,
  store,
  llm,
  cfg: DEFAULTS,
  now: nowSec,
  sleep,
  InputFile,
  fetch,
  ghToken: GH_PAT,
  selfRepo: SELF_REPO,
  ownerIds: parseIdList(OWNER_IDS),
});
