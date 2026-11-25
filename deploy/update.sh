#!/usr/bin/env bash
set -euo pipefail

repo=/opt/parkovka
unit=parkovka.service

if (( EUID != 0 )); then
    echo 'Запустите обновление через sudo' >&2
    exit 1
fi

exec 9>/run/lock/parkovka-update.lock
if ! flock -n 9; then
    echo 'Обновление уже запущено' >&2
    exit 1
fi

repo_git() {
    runuser -u parkovka -- git -C "$repo" "$@"
}

if [[ $(repo_git branch --show-current) != main || -n $(repo_git status --porcelain --untracked-files=no) ]]; then
    echo 'Для обновления нужна чистая рабочая копия ветки main' >&2
    exit 1
fi

repo_git pull --ff-only origin main
runuser -u parkovka -- "$repo/.venv/bin/python" -m pip install --disable-pip-version-check -r "$repo/requirements.txt"
systemctl restart "$unit"

for (( attempt = 1; attempt <= 20; attempt++ )); do
    if systemctl is-active --quiet "$unit" && curl --fail --silent --max-time 2 http://127.0.0.1:8000/api/health >/dev/null; then
        printf 'Сервис работает. Версия %s\n' "$(repo_git rev-parse --short HEAD)"
        exit 0
    fi
    sleep 1
done

echo 'Сервис не ответил после обновления. Проверьте systemctl status parkovka.service' >&2
exit 1
