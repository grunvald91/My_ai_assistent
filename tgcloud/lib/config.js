// config.js — константы и значения по умолчанию. Чистый модуль (без sdk).

export const API_BASE = 'https://api.claudehub.fun';

// Порядок предпочтения модели по умолчанию (берётся первая, которая есть в списке ClaudeHub
// и не помечена как «down»). Менять модель конкретного чата можно командой /model.
export const MODEL_PREFERENCE = [
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
];

export const DEFAULTS = {
  // память
  historyMessages: 20, // сколько последних сообщений держим «живыми»
  historyTokenBudget: 8000, // бюджет токенов на историю в запросе
  summaryTrigger: 40, // когда несжатых сообщений больше — сжимаем старые в сводку
  memoryLimit: 200, // фактов на scope
  proposalTtlSec: 7 * 86400,

  // ИИ
  maxTokensChat: 4096,
  maxTokensGroup: 1200,
  maxTokensPost: 1500,
  maxTokensSummary: 900,
  maxTokensCode: 12000, // /code: изменения файлов целиком
  retries: 2, // повторы при сбоях ClaudeHub (FR-5)
  modelsTtlSec: 24 * 3600, // кеш списка моделей (FR-8)

  // лимиты расходов
  dailyTokenLimit: 500000,
  rpmLimit: 20, // запросов к ИИ в минуту (все чаты)

  // группы
  groupMinGapSec: 4, // не чаще одного ответа в N секунд в одной группе
  groupHourlyCap: 40, // не больше N ответов в час в одной группе

  // Business
  bizHourlyCap: 12, // не больше N автоответов в час в одном чате

  // порядок
  tzOffsetHours: 3, // часовой пояс владельца (Москва) для «сегодня» и даты в промпте
  journalKeep: 1000,
  updatesKeepSec: 86400,
  updateRunLockSec: 120, // столько секунд апдейт считается «в работе» (защита от дублей)
};

// Меню команд владельца. Менять список — поднимай COMMANDS_VERSION: бот сам обновит меню.
export const COMMANDS_VERSION = 6;
export const OWNER_COMMANDS = [
  ['start', 'Начало и справка'],
  ['model', 'Выбрать модель ИИ'],
  ['post', 'Подготовить пост в канал'],
  ['channels', 'Мои каналы и их стиль'],
  ['memory', 'Что я помню'],
  ['remember', 'Запомнить факт'],
  ['remember_biz', 'Запомнить факт для ответов за меня'],
  ['forget', 'Забыть факт по номеру'],
  ['reset', 'Очистить историю этого чата'],
  ['forget_all', 'Стереть всю память'],
  ['cancel', 'Отменить текущее действие'],
  ['group', 'Режим ответов в группе'],
  ['draft', 'Черновик ответа за меня (в группе)'],
  ['business', 'Ответы от моего имени (Business)'],
  ['gh', 'GitHub: подключение и репозитории'],
  ['repo', 'Выбрать репозиторий для кода'],
  ['code', 'Написать код и запушить в репозиторий'],
  ['usage', 'Расход и баланс'],
  ['limit', 'Дневной лимит токенов'],
  ['stop', 'Остановить все ответы'],
  ['resume', 'Включить ответы обратно'],
  ['export', 'Выгрузить данные'],
  ['help', 'Справка'],
];
export const PUBLIC_COMMANDS = [
  ['start', 'Начало'],
  ['id', 'Узнать свой Telegram ID'],
];
// Меню в группах: спросить ИИ работает в режиме «по запросу» даже при включённом режиме приватности бота.
export const GROUP_COMMANDS = [['ask', 'Спросить ИИ']];

export const GROUP_MODES = ['off', 'mention', 'all'];
export const BIZ_MODES = ['off', 'confirm', 'auto'];

export const TG_TEXT_LIMIT = 4096;
export const TG_CAPTION_LIMIT = 1024;
