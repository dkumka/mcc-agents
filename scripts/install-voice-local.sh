#!/usr/bin/env bash
# Установка и запуск службы локального распознавания речи mcc-voice-local (GigaAM-v4 ONNX int8)
# и (по умолчанию) выкатка обновлённой панели через scripts/deploy-server.sh.
#
# Запуск из SSH, когда в панели нет активных задач:
#   sudo bash ~/dev/mcc/mcc-agents/scripts/install-voice-local.sh
#   sudo bash ~/dev/mcc/mcc-agents/scripts/install-voice-local.sh --service-only
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Запустите через sudo из SSH: sudo bash ~/dev/mcc/mcc-agents/scripts/install-voice-local.sh' >&2; exit 1; }

service_only=0
for a in "$@"; do
  case "$a" in
    --service-only) service_only=1 ;;
    *) echo "Неизвестный параметр: $a" >&2; exit 2 ;;
  esac
done

source_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
unit_src="$source_dir/deploy/mcc-voice-local.service"
unit_dst="/etc/systemd/system/mcc-voice-local.service"
runtime_dir="/home/klemid/.local/share/mcc-voice-local"
server_py="$source_dir/services/voice-local/server.py"

[[ -f "$unit_src" ]] || { echo "Не найден unit: $unit_src" >&2; exit 1; }
[[ -x "$runtime_dir/venv/bin/python" ]] || { echo "Не найдено окружение: $runtime_dir/venv/bin/python" >&2; exit 1; }
[[ -f "$runtime_dir/models/gigaam-v4-onnx-int8/rnnt_encoder.onnx" ]] || { echo "Не найдена модель в $runtime_dir/models/gigaam-v4-onnx-int8" >&2; exit 1; }
[[ -f "$server_py" ]] || { echo "Не найден сервер: $server_py" >&2; exit 1; }

if ss -ltn | grep -q '127.0.0.1:3119 ' && ! systemctl is-active -q mcc-voice-local; then
  echo 'Порт 127.0.0.1:3119 занят другим процессом' >&2
  exit 1
fi

backup=$(mktemp -d /var/backups/mcc-voice-local.XXXXXXXX)
had_unit=0
if [[ -f "$unit_dst" ]]; then
  cp -a "$unit_dst" "$backup/mcc-voice-local.service"
  had_unit=1
fi
echo "Резервная копия: $backup"

rollback() {
  trap - ERR
  echo 'Ошибка при запуске mcc-voice-local — откатываю.' >&2
  journalctl -u mcc-voice-local --since '-5 minutes' --no-pager > "$backup/failure.log" 2>&1 || true
  systemctl stop mcc-voice-local || true
  if [[ $had_unit == 1 ]]; then
    cp -a "$backup/mcc-voice-local.service" "$unit_dst"
    systemctl daemon-reload
    systemctl start mcc-voice-local || true
  else
    rm -f "$unit_dst"
    systemctl daemon-reload
  fi
  echo "Журнал ошибки: $backup/failure.log" >&2
  exit 1
}
trap rollback ERR

install -m 0644 "$unit_src" "$unit_dst"
systemctl daemon-reload
systemctl enable mcc-voice-local
systemctl restart mcc-voice-local

ready=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:3119/health | grep -q '"ok": true\|"ok":true'; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ $ready == 1 ]] || { echo 'mcc-voice-local не ответил на http://127.0.0.1:3119/health' >&2; false; }
trap - ERR
echo "Служба mcc-voice-local запущена и отвечает: $(curl -fsS http://127.0.0.1:3119/health)"

if [[ $service_only == 0 ]]; then
  echo '→ выкатка обновлённой панели (mcc-agentd + mcc-agents-web)'
  bash "$source_dir/scripts/deploy-server.sh"
fi
