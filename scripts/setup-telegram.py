#!/usr/bin/env python3
"""Run interactively over SSH. Never put the bot token in arguments or shell history."""
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import urllib.request
from datetime import datetime, timezone


def main():
    token = getpass.getpass('Токен отдельного бота MCC Agents (скрыт): ').strip()
    chat = getpass.getpass('Личный Telegram chat ID (Enter — определить автоматически): ').strip()
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token) or (chat and not re.fullmatch(r'[1-9]\d*', chat)):
        raise ValueError('Неверный формат токена или личного chat ID')

    def api(method, body):
        req = urllib.request.Request(
            f'https://api.telegram.org/bot{token}/{method}',
            data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.load(response)
        if not data.get('ok'):
            raise ValueError('Telegram отклонил проверку')
        return data['result']

    api('getMe', {})
    if api('getWebhookInfo', {}).get('url'):
        raise ValueError('Нужен отдельный бот без webhook')
    if not chat:
        # Never start a second getUpdates reader for an already configured daemon.
        if (Path.home() / 'secrets/agents-telegram.env').exists():
            print('Для уже настроенного бота введите chat ID вручную.')
            return
        code = 'MCC-' + secrets.token_hex(4)
        print('Отправьте созданному боту в личном чате это сообщение:', code)
        input('После отправки нажмите Enter здесь: ')
        updates = api('getUpdates', {'timeout': 0, 'limit': 100, 'allowed_updates': ['message', 'callback_query']})
        ids = set()
        for update in updates:
            message = update.get('message', {})
            peer = message.get('chat', {})
            if (message.get('text') == code and peer.get('type') == 'private'
                    and peer.get('id') == message.get('from', {}).get('id')):
                ids.add(str(peer['id']))
        if len(ids) != 1:
            print('Сообщение привязки не найдено однозначно. Запустите настройку заново.')
            return
        chat = ids.pop()
    target = api('getChat', {'chat_id': chat})
    if target.get('type') != 'private':
        raise ValueError('Нужен личный чат с ботом. Откройте бота и нажмите Start.')
    if api('getWebhookInfo', {}).get('url'):
        raise ValueError('У бота включён webhook. Используйте отдельного бота без webhook.')
    directory = Path.home() / 'secrets'
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise ValueError('Каталог secrets не должен быть ссылкой')
    target = directory / 'agents-telegram.env'
    if target.is_symlink():
        raise ValueError('Файл конфигурации не должен быть ссылкой')
    if target.exists():
        backup = target.with_name(target.name + '.bak.' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(target.read_bytes())
        print('Прежняя конфигурация сохранена рядом с оригиналом с правами 600.')
    fd, name = tempfile.mkstemp(prefix='.agents-telegram-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(f'TELEGRAM_BOT_TOKEN={token}\nTELEGRAM_CHAT_ID={chat}\n')
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print('Сохранено вне проекта с правами 600. Перезапуск не нужен.')
    print('Через минуту: Настройки → Telegram → Бот агентов подключён; задержка 60 с.')
    print('Проверка доставки выполняется отдельно на согласованном тестовом запросе.')


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt):
        # HTTP exception text may contain the token-bearing URL. Never print it.
        print('Настройка не завершена. Проверьте токен, личный chat ID, Start и доступ к Telegram. Секреты не выводятся.')
        raise SystemExit(1)
