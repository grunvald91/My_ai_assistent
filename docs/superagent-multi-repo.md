# DeepSeek Superagent — один сервис, несколько репозиториев

## Текущее состояние

Multi-Repo уже установлен на VPS: базовый PR #14 слит, сервис DSH и systemd timer работают. Реальный read-only E2E в SMENA прошёл через Telegram; реальный draft PR с Write-доступом создан в legacy booking_bot (#139) без слияния и деплоя. Мониторинг внешних PR дополняется в PR #19.

Один DSH-процесс и один GitHub Source (`grunvald91/Ai_growth_os`) остаются центральной очередью. Из Telegram можно выбрать **один** целевой репозиторий для каждого Ticket. Подготовительная команда создаёт отдельный checkout целевого проекта. Исключение — BookingBot: его исходный репозиторий уже импортирован в `Ai_growth_os/services/booking_bot/`, поэтому все задания BookingBot направляются в этот модуль `Ai_growth_os`, без изменений старого `booking_bot`.

У upstream `deepseek-ai/dsh-superagent-prototype` встроенная привязка PR использует репозиторий Source. Для внешнего PR в этой интеграции `orchestrator_report(pr_number)` **не используется**: полный URL PR передаётся в итоговом summary. Штатный DSH сам не подписывается на внешние PR, поэтому отдельный VPS-монитор опрашивает их через GitHub REST API каждые пять минут и записывает изменение состояния, CI, ревью и комментариев в центральный Issue. Команда `/agent статус` в Telegram показывает эти сведения и актуальное состояние PR. Монитор не выполняет слияние, деплой или автоматическое исправление замечаний.

## Проверка входящего задания

1. Команда `/agent repo grunvald91/booking_bot` устанавливает проект чата; явная ссылка в задании имеет приоритет.
2. Бот отвергает чужих владельцев, неоднозначные ссылки, приватные репозитории (очередь публичная) и недоступные проекты. Для анализа **публичного** репозитория достаточно возможности его прочитать через GitHub (роль соавтора не требуется); для изменения кода и PR необходимы явные права `write` агентского аккаунта. Исключение: `My_ai_assistent` доступен **только для проверки и отчёта**, но не для изменений через этот канал.
3. Непосредственно перед созданием Issue бот требует **свежий серверный GitHub commit status** контекста `superagent/multirepo-ready/YYYY-MM-DD` (UTC, на период миграции поддержан также прежний `superagent/multirepo-ready`), написанный аккаунтом `Grunvald1991`. Старые статусы и простое включение флага в Telegram не проходят. `/agent multirepo status` показывает время последнего сигнала (UTC), причину отказа и команды диагностики VPS.
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
- `scripts/superagent-external-pr-monitor.mjs`
- `scripts/superagent-pr-watch-core.mjs`

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

Эта задача работает на **VPS каждые 5 минут**, а не в GitHub Actions. Она сначала проверяет в локальном API DSH правильный Source, точную команду подготовки, наличие инструкции `superagent-external-pr-v1`, активное состояние DSH и идентичность `gh`. Затем читает фактически завершённые отчёты Ticket и отправляет итоговые комментарии через `gh` в центральный Issue. Внешний PR-монитор — вспомогательная функция: если его файл отсутствует, в его коде ошибка или его сетевые запросы зависают (тайм-аут 45 секунд), скрипт печатает предупреждение и продолжает проверку DSH. Это не должно блокировать обычное ревью и новые задачи. Если основная проверка DSH или доставка отчёта завершается ошибкой, новый status **не** публикуется; предыдущий перестаёт действовать максимум через 10 минут.

В DSH REST API используется локальный заголовок `x-orchestrator-request: 1`. Нельзя выставлять API без авторизации в публичный интернет.

## Если бот сообщает об устаревшем подтверждении DSH

Это **не** ошибка прав GitHub на целевой проект. Telegram получает последнюю запись `superagent/multirepo-ready/YYYY-MM-DD` или старого контекста `superagent/multirepo-ready` с GitHub и проверяет, что запись создана агентским аккаунтом, имеет правильную версию и моложе 10 минут. **Причина остановки 12.11.2026:** GitHub разрешает не более 1000 commit statuses на сочетание SHA+context, а `Ai_growth_os/main` долго не менялся. Исправлено сменой **только** имени status context каждый UTC-день. При интервале 5 минут это 288 записей за сутки; пустые коммиты в `main` не нужны. Если серверная периодическая проверка остановилась, бот честно блокирует новые Multi-Repo задания, но показывает UTC-время последнего успешного сигнала.

На VPS под системным пользователем DSH проверить:

```sh
sudo systemctl status superagent-capability.timer --no-pager
sudo systemctl status superagent-capability.service --no-pager
sudo journalctl -u superagent-capability.service -n 80 --no-pager
sudo systemctl list-timers --all | grep superagent-capability
```

Если таймер выключен, включить: `sudo systemctl enable --now superagent-capability.timer`. При необходимости можно запустить одну проверку: `sudo systemctl start superagent-capability.service`. После успешного запуска убедиться, что появился **новый** status с сегодняшним UTC-суффиксом в [GitHub Commit Statuses](https://api.github.com/repos/grunvald91/Ai_growth_os/commits/main/statuses), и повторить `/agent multirepo status`. Если служба завершилась ошибкой, журнал укажет конкретный шаг; не подменять GitHub status вручную.

Изменение файла скрипта в GitHub само по себе **не обновляет** копию в `/home/dsh-agent/.local/bin/`: чтобы новый вариант начал работать, надо обновить соответствующий файл на VPS и перезапустить сервис. GitHub Actions `deploy.yml` обновляет Telegram Serverless, но не ставит systemd-файлы DSH.

## Автоматический мониторинг внешних Pull Request

Скрипт `superagent-external-pr-monitor.mjs` вызывается существующим systemd-таймером каждые пять минут; новых периодических GitHub Actions нет. Он доверяет только **связанному с Issue терминальному отчёту** от `Grunvald1991`, проверяет явный `mode=write`, владельца Issue `grunvald91`, автора PR `Grunvald1991` и ветку `agent/*` **в том же репозитории**, без форков и переключения целей из пользовательского текста.

По GitHub API проверяются последний SHA, результаты Check Runs, commit statuses, решения ревьюеров, запрошенные ревьюеры, комментарии к коду, закрытие, слияние и повторное открытие. Если CI вообще не настроен, показывается **«проверок нет»**, не «зелёный». Если API не отдаёт всю страницу проверок, монитор отказывается делать положительный вывод. В исходном Issue появляется структурированный комментарий `superagent-prwatch:v1` только при изменении данных. Отпечатки и идентификаторы сохраняются в приватном `/srv/dsh-agent/state/superagent-multirepo/external-pr-watch.json`; повторные одинаковые записи подавляются. После закрытия PR отслеживается ещё 30 дней.

`/agent статус` читает из Issue только комментарии от проверенного агентского аккаунта с корректным маркером мониторинга и показывает сводку CI/ревью вместе с текущим статусом PR. **Проактивные сообщения Telegram при каждом изменении PR в этой версии не отправляются:** для них потребовался бы отдельный доверенный канал из VPS в Telegram Serverless. Состояние PR обновляется в GitHub без участия пользователя; Telegram показывает его по запросу. Этот аспект не следует путать с уже работающей автоматической доставкой *первого итогового отчёта* агентской задачи.

Реальный Write E2E: [Issue #295](https://github.com/grunvald91/Ai_growth_os/issues/295) → [внешний PR #139](https://github.com/grunvald91/booking_bot/pull/139), только один Markdown-документ, PR оставлен черновиком, без слияния и деплоя. Это не часть production-кода BookingBot.

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

Нет автоматического merge или production deploy. Репозиторий Telegram-бота `My_ai_assistent` разрешён только для `mode=read`, а приватные цели не разрешены (публичная очередь); для приватных задач нужна отдельная приватная очередь.

Основа: [DSH Deployment](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md), [DSH Executor](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/executor/dsh.ts), [DSH PR binding](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/sources/github-pull.ts), [GitHub statuses API](https://docs.github.com/en/rest/commits/statuses).
