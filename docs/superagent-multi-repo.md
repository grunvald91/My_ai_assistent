# DeepSeek Superagent: один сервис, несколько GitHub-репозиториев

## Состояние

Этот документ описывает **изменения Telegram-моста и серверную подготовку**, а не подтверждает переключение VPS.
Upstream `deepseek-ai/dsh-superagent-prototype` имеет один GitHub Source и привязывает PR к нему.
Источник событий остаётся `grunvald91/Ai_growth_os` (центральная очередь Issue); **код и PR** обрабатываются в целевом репозитории.
Для разных репозиториев запускаются рабочие каталоги, а не дополнительные `dsh-superagent` процессы.

## Маршрут

1. Владелец отправляет `/agent repo grunvald91/booking_bot`, затем `/agent проверь код`; или указывает `https://github.com/grunvald91/booking_bot` в самом поручении.
2. Бот проверяет, существует ли целевой репозиторий и доступен ли он его токену. Он создаёт **один Issue** в `grunvald91/Ai_growth_os` с первой строкой:
   `<!-- superagent-route:v1 repo=grunvald91/booking_bot -->`
3. DSH принимает уведомление в своём единственном GitHub Source и создаёт Ticket.
4. Команда подготовки [`scripts/superagent-prepare-worktree.sh`](../scripts/superagent-prepare-worktree.sh) читает **только первую строку** Issue, проверяет разрешённый владелец/репозиторий и **права записи самого аккаунта агента**, затем создаёт независимый git checkout в `DSH_SUPERAGENT_DIR`.
5. Для изменения кода агент создаёт ветку и Pull Request **в целевом репозитории**. Ссылку на PR оставляет комментарием в исходном Issue в `Ai_growth_os`, который бот отслеживает и возвращает в Telegram.

**Важно:** встроенная привязка PR в upstream DSH рассчитана на PR из репозитория-источника. Для задачи в другом репозитории PR нельзя выдавать через встроенный `pr_number` Ticket: нужно указывать полный URL в отчёте и комментарии центрального Issue. Автоматическое отслеживание закрытия такого PR DSH в этой схеме не выполняет.

## Перед включением: VPS

Под пользователем `dsh-agent` нужно разместить скрипт в доступном постоянном каталоге, например:
`/home/dsh-agent/.local/bin/superagent-prepare-worktree.sh`.
Не копировать туда секреты. GitHub CLI должен работать в контексте **аккаунта агента**, а не владельца Telegram.

В панели DSH → Superagent → **Settings → Execution** задать команду подготовки:
```sh
bash /home/dsh-agent/.local/bin/superagent-prepare-worktree.sh
```
Она заменяет старую команду, жёстко привязанную к checkout `Ai_growth_os`. Настройку GitHub Source **не менять**.

Проверки при установке:
```sh
bash -n /home/dsh-agent/.local/bin/superagent-prepare-worktree.sh
# Под тем же пользователем/окружением, которым агент запускает gh:
gh api repos/grunvald91/booking_bot --jq '.permissions.push'
gh api repos/grunvald91/Ai_growth_os --jq '.permissions.push'
```
Оба ответа должны быть `true`. Если нет — дать `Grunvald1991` Write на нужный проект и повторить проверку; без прав скрипт прекращает работу, не подменяя целевой проект на другой.

В разделе **Prompts / team instructions** добавить инструкцию для рабочих сессий:

> Источник уведомлений `DSH_SUPERAGENT_GITHUB_REPOSITORY` — это очередь заданий, а не всегда целевой кодовый проект. Целевой проект всегда равен Git remote `origin` подготовленного `DSH_SUPERAGENT_DIR`. Выполняй анализ и изменения только в нём. Если Issue относится к другому проекту, создавай PR именно там, а в исходном Issue оставляй ссылку на PR целиком; не передавай номер внешнего PR в механизм `pr_number` DSH. Никогда не выполняй merge или production deploy без отдельного разрешения.

Проверить рестарт и здоровье `dsh-superagent.service`, чтобы изменение команды действительно применилось. При тесте не запускать дополнительные экземпляры DSH.

## Управление из Telegram

```text
/agent multirepo status
/agent repo grunvald91/booking_bot
/agent multirepo on
/agent Проверь структуру проекта и напиши отчёт
/agent Исправь ошибку в https://github.com/grunvald91/SMENA и создай PR
/agent repo default
/agent multirepo off
```

По умолчанию `/agent multirepo off` (безопасный режим): другие репозитории **не получают задач**, пока серверная подготовка не установлена и не проверена. `/agent repo ...` лишь устанавливает предпочтение чата. Явная ссылка внутри поручения имеет приоритет. Для одного Issue допускается **один** целевой репозиторий; многорепозиторные изменения пока надо разбивать на отдельные Tickets.

`/agent multirepo on` следует выполнить **только после проверки** подготовительной команды и доступа аккаунта агента. Это ручной флаг, а не автоматическое обнаружение состояния VPS. Если ошибка — `/agent multirepo off` и вернуть прежнюю команду подготовки; исходный режим `Ai_growth_os` сохраняется.

## Границы и проверки

- Нет прав записи у `Grunvald1991` — отказ, не fallback на `Ai_growth_os`.
- Цель вне `grunvald91/*`, несуществующий проект, репозиторий Telegram-бота или несколько целей — отказ.
- Telegram-мост не разрешает auto-merge, deploy и изменение production.
- Целевые проекты не получают новые GitHub Actions: их существующий CI может запускаться при PR по своим правилам.
- Доступ к приватным репозиториям возможен только если агентский GitHub CLI реально авторизован и имеет права; автоматическое добавление соавторов не выполняется.
- Скрипт создаёт отдельный `git clone --filter=blob:none` на Ticket; расход памяти одного агента не умножается на число проектов, но объём диска, сеть и число одновременных checkout увеличиваются. Это не гарантия конкретного потребления памяти.
- Нельзя считать feature end-to-end проверенной без успешного report-only задания для BookingBot и затем проверки PR в выбранном репозитории.

Основа: [DSH README](https://github.com/deepseek-ai/dsh-superagent-prototype), [документация DSH Deployment](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md), [GitHub REST: repository permissions](https://docs.github.com/en/rest/repos/repos#get-a-repository).
