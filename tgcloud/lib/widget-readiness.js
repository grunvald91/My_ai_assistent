// Written by scripts/deploy.mjs ONLY after a successful webhook sync check.
// In the repository this must stay false: a new deploy starts fail-closed.
// Telegram Serverless does not guarantee that getWebhookInfo can be invoked
// from bot handlers, so verified readiness is embedded in deployed code.
export const WIDGET_WEBHOOK_VERIFIED = false;
