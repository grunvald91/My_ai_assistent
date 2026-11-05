# DeepSeek Superagent — один сервис, несколько репозиториев

## Текущее состояние

Этот код находится в PR #14, пока **не включён на VPS и не прошёл реальный E2E**. Не смешивать прохождение тестов GitHub Actions с работающим production.

Один DSH-процесс и один GitHub Source (`grunvald91/Ai_growth_os`) остаются центральной очередью. Из Telegram можно выбрать **один** целевой репозиторий для каждого Ticket. Подготовительная команда создаёт отдельный checkout целевого проекта. Исключение — BookingBot: его исходный репозиторий уже импортирован в `Ai_growth_os/services/booking_bot/`, поэтому все задания BookingBot направляются в этот модуль `Ai_growth_os`, без изменений старого `booking_bot`.

У upstream `deepseek-ai/dsh-superagent-prototype` встроенная привязка PR использует репозиторий Source. Для внешнего PR в этой интеграции `orchestrator_report(pr_number)` **не используется**: полный URL PR передаётся в итоговом summary. Сам DSH не подписывается на внешние PR. По запросу `/agent статус` Telegram-бот запрашивает текущий статус такого PR напрямую в GitHub.

## Проверка входящего задания

1. Команда `/agent repo grunvald91/booking_bot` устанавливает проект чата; явная ссылка в задании имеет приоритет.
2. Бот отвергает чужих владельцев, неоднозначные ссылки, приватные репозитории (очередь публичная) и недоступные проекты. Для анализа достаточно прав `read`; для изменения кода и PR требуются `write`.
3. Непосредственно перед созданием Issue бот требует **свежий серверный GitHub commit status** контекста `superagent/multirepo-ready`, написанный аккаунтом `Grunvald1991`. Старые статусы и простое включение флага в Telegram не проходят.
4. Бот создаёт Issue с первой строкой `<!-- superagent-route:v1 repo=grunvald91/SMENA mode=read -->` (или `mode=write` для изменения кода) и тегом `@Grunvald1991`. Для BookingBot маркер указывает `Ai_growth_os`, а текст задания ограничивает область `services/booking_bot/`.
5. DSH запускает Ticket. Скрипт `superagent-prepare-worktree.sh` проверяет автора Issue `grunvald91`, корректность маркера и право доступа агентского CLI, прежде чем клонировать целевой проект. `mode=read` не требует права на запись.

Для Issue вне этого протокола сохраняется прежняя подготовка `Ai_growth_os`. Пользовательское описание задания никогда не даёт прав на смену репозитория само по себе.

## Установка на VPS

**Не копировать ключи и токены в GitHub.** Установка выполняется под системным пользователем DSH (пример `dsh-agent`), у которого `gh` уже авторизован как агент. Для следующих путей подставить фактический домашний каталог и порт DSH.

Перенести скрипты из этого PR в постоянный каталог `/home/dsh-agent/.local/bin/`:

- `scripts/superagent-prepare-worktree.sh`
- `scripts/superagent-terminal-relay.sh`
- `scripts/superagent-capability-heartbeat.sh`
- `scripts/superagent-configure-prompts.mjs`

В **Superagent → Settings → Execution → prepare** установить ровно:

```sh
bash /home/dsh-agent/.local/bin/superagent-prepare-worktree.sh
```

Настройку GitHub Source оставить `grunvald91/Ai_growth_os`.

Перед началом сохранить копию нынешних DSH Prompts и запустить настройку системных инструкций:

```sh
export DSH_SUPERAGENT_URL=http://127.0.0.1:PORT
node /home/dsh-agent/.local/bin/superagent-configure-prompts.mjs
```

Скрипт идемпотентно дополняет `delivery`, `runtime/work` и `skill/github` точными исключениями для внешнего PR. Он не должен удалять имеющиеся правила пользователя.

Установить шаблоны `deploy/superagent-capability.service` и `deploy/superagent-capability.timer` в `/etc/systemd/system/`, указать реальный порт в `DSH_SUPERAGENT_URL`, поправить пользователя и пути при необходимости. Дополнительно обязательна переменная `DSH_MULTI_REPO_RELAY`. После проверки:

```sh
sudo systemctl daemon-reload
sudo systemctl start superagent-capability.service
sudo systemctl status superagent-capability.service --no-pager
sudo systemctl enable --now superagent-capability.timer
```

Эта задача работает на **VPS каждые 5 минут**, а не в GitHub Actions. Она сначала проверяет в локальном API DSH правильный Source, точную команду подготовки, наличие инструкции `superagent-external-pr-v1`, активное состояние DSH и идентичность `gh`. Затем читает фактически завершённые отчёты Ticket, отправляет итоговый комментарий через `gh` в центральный Issue и только после этого публикует краткоживущий GitHub status с `success`. Если проверка или доставка завершается ошибкой, новый статус не публикуется; предыдущий перестаёт действовать максимум через 10 минут.

В DSH REST API используется локальный заголовок `x-orchestrator-request: 1`. Нельзя выставлять API без авторизации в публичный интернет.

## Результаты и долгие задачи

Штатный DSH добавляет маркер `<!-- dsh-superagent:... -->` **к каждому** своему комментарию. Он не означает завершение.

Только комментарий с **парой** служебных маркеров, опубликованный серверным обработчиком по фактическому отчёту DSH, может попасть в Telegram:

```text
<!-- superagent-relay:v1 report=0123456789abcdef0123 -->
<!-- superagent-result:v1 issue=300 state=ready -->
```

Допустимые состояния: `ready`, `blocked`, `failed`, `dropped`. Маркер `superagent-relay` содержит хеш конкретного DSH-отчёта. Два маркера проверяются вместе; обычные комментарии агента без них не считаются окончательными. Серверный relay создаёт такой комментарий по настоящему состоянию Ticket в DSH (а не по сообщению модели); при перезапусках защищается от дублей по идентификатору отчёта.

GitHub Actions watcher продолжает ожидать ответ в течение 25 минут. Если агент выполняет задачу дольше, он отправит временное уведомление; **поздний итог можно получить по `/agent статус`**, поскольку серверный relay опубликует его в Issue. Автоматическую доставку позднего итога без пользовательского запроса текущий код **не гарантирует**. Это ограничение не нужно скрывать.

## Тестирование и включение

Проверить offline bash-тесты:

```sh
bash test/superagent-prepare.test.sh
npm test
```

После настройки сервера:

1. `/agent multirepo status` — должно быть «сервер подтверждён».
2. Отправить `/agent Проверь README в https://github.com/grunvald91/SMENA и напиши отчёт` — репозиторий доступен агенту только на чтение.
3. Проверить в DSH рабочий каталог и `git remote -v`: целевой origin должен быть `SMENA`. Для BookingBot origin должен оставаться `Ai_growth_os`, область работы — `services/booking_bot/`.
4. Проверить терминальный комментарий в центральном Issue и ответ в Telegram.
5. После предоставления агенту Write-доступа в отдельный тестовый проект создать небольшой PR именно в нём и проверить `/agent статус` после изменения состояния PR. Для BookingBot создавать PR в `Ai_growth_os` с изменениями только в `services/booking_bot/`.
6. Испытать недоступный репозиторий, неверного автора, тайм-аут и недостающие права.

`/agent multirepo off` — дополнительная ручная пауза. `/agent multirepo on` только снимает её, **не обходит** проверку сервера.

Нет автоматического merge или production deploy. Репозитории Telegram-бота `My_ai_assistent` и приватные цели не разрешены в данной схеме; для приватных задач нужна отдельная приватная очередь.

Основа: [DSH Deployment](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md), [DSH Executor](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/executor/dsh.ts), [DSH PR binding](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/sources/github-pull.ts), [GitHub statuses API](https://docs.github.com/en/rest/commits/statuses).
