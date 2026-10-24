#!/usr/bin/env bash
set -Eeuo pipefail

ACTION="${1:-help}"; TARGET="${2:-all}"; APPLY=false; BACKUP=; DESTINATION=
for arg in "${@:2}"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --backup=*) BACKUP="${arg#*=}" ;;
    --destination=*) DESTINATION="${arg#*=}" ;;
    "$TARGET") ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
units=(woori-agent-controller.service woori-agent-scheduler.service woori-agent-worker.service woori-agent-dashboard.service)
case "$TARGET" in
  controller) units=(woori-agent-controller.service) ;;
  scheduler) units=(woori-agent-scheduler.service) ;;
  worker) units=(woori-agent-worker.service) ;;
  dashboard) units=(woori-agent-dashboard.service) ;;
  backup) units=(woori-agent-backup.service woori-agent-backup.timer) ;;
  all) ;;
  *) echo 'Target must be controller|scheduler|worker|dashboard|all.' >&2; exit 2 ;;
esac
mutating=false
case "$ACTION" in start|stop|restart|enable|disable|remove|scheduler-opt-in|scheduler-opt-out|init-scheduler|backup|restore) mutating=true ;; status|logs|verify|preflight|help) ;; *) echo 'Unsupported action.' >&2; exit 2 ;; esac
if [[ "$mutating" == true && "$APPLY" != true ]]; then
  echo "Dry-run: action=$ACTION target=$TARGET; no files or services changed. Add --apply after review."
  exit 0
fi
if [[ "$mutating" == true && "$EUID" -ne 0 ]]; then echo 'Applying this operation requires root.' >&2; exit 4; fi
case "$ACTION" in
  status) systemctl --no-pager --full status "${units[@]}" || true ;;
  logs) journalctl --no-pager -u "${units[0]}" -n 100 ;;
  verify) for unit in "${units[@]}"; do systemd-analyze verify "/etc/systemd/system/$unit"; done; systemd-analyze verify /etc/systemd/system/woori-agent-controller.slice /etc/systemd/system/woori-agent-worker.slice ;;
  preflight) runuser -u woori-agent -- env WOORI_AGENT_STATE_DIR=/var/lib/woori-ai-agent /opt/woori-ai-agent/current/node_modules/.bin/tsx /opt/woori-ai-agent/current/apps/cli/src/index.ts linux-preflight ;;
  start|stop|restart|enable|disable)
    if [[ "$TARGET" == backup ]]; then
      systemctl "$ACTION" woori-agent-backup.timer
      [[ "$ACTION" != stop ]] || systemctl stop woori-agent-backup.service 2>/dev/null || true
    else
      for unit in "${units[@]}"; do systemctl "$ACTION" "$unit"; done
    fi ;;
  scheduler-opt-in)
    [[ "$TARGET" == scheduler ]] || { echo 'scheduler-opt-in requires target scheduler.' >&2; exit 2; }
    env_file=/etc/woori-ai-agent/scheduler.env
    [[ -f "$env_file" ]] || { echo 'Scheduler environment file is missing.' >&2; exit 4; }
    if grep -q '^WOORI_SCHEDULER_ENABLED=' "$env_file"; then sed 's/^WOORI_SCHEDULER_ENABLED=.*/WOORI_SCHEDULER_ENABLED=true/' "$env_file" > "$env_file.tmp"; else cat "$env_file" > "$env_file.tmp"; printf '\nWOORI_SCHEDULER_ENABLED=true\n' >> "$env_file.tmp"; fi
    chown root:root "$env_file.tmp"; chmod 0600 "$env_file.tmp"; mv -f "$env_file.tmp" "$env_file"
    install -o root -g root -m 0600 /dev/null /etc/woori-ai-agent/scheduler.enabled
    echo 'Read-only scheduler opt-in recorded. Service was not started; run start scheduler --apply separately after review.' ;;
  scheduler-opt-out)
    [[ "$TARGET" == scheduler ]] || { echo 'scheduler-opt-out requires target scheduler.' >&2; exit 2; }
    systemctl stop woori-agent-scheduler.service || true
    rm -f -- /etc/woori-ai-agent/scheduler.enabled
    if [[ -f /etc/woori-ai-agent/scheduler.env ]]; then sed 's/^WOORI_SCHEDULER_ENABLED=.*/WOORI_SCHEDULER_ENABLED=false/' /etc/woori-ai-agent/scheduler.env > /etc/woori-ai-agent/scheduler.env.tmp; chown root:root /etc/woori-ai-agent/scheduler.env.tmp; chmod 0600 /etc/woori-ai-agent/scheduler.env.tmp; mv -f /etc/woori-ai-agent/scheduler.env.tmp /etc/woori-ai-agent/scheduler.env; fi
    echo 'Scheduler stopped and opt-in removed.' ;;
  init-scheduler)
    runuser -u woori-agent -- env WOORI_CONTROLLER_DB_PATH=/var/lib/woori-ai-agent/controller/queue.sqlite WOORI_AGENT_DB_PATH=/var/lib/woori-ai-agent/agent.sqlite WOORI_SCHEDULER_ENABLED=false PAID_AI_API_ENABLED=false AI_API_BUDGET_USD=0 AI_AUTO_EXECUTION=false /opt/woori-ai-agent/current/node_modules/.bin/tsx /opt/woori-ai-agent/current/apps/cli/src/index.ts scheduler init ;;
  backup)
    [[ "$TARGET" == backup || "$TARGET" == all ]] || { echo 'Backup action requires target backup or all.' >&2; exit 2; }
    install -d -o woori-agent -g woori-agent -m 0700 /var/lib/woori-ai-agent/backups
    runuser -u woori-agent -- env WOORI_AGENT_STATE_DIR=/var/lib/woori-ai-agent /opt/woori-ai-agent/current/node_modules/.bin/tsx /opt/woori-ai-agent/current/apps/cli/src/index.ts linux-preflight
    runuser -u woori-agent -- env WOORI_CONTROLLER_DB_PATH=/var/lib/woori-ai-agent/controller/queue.sqlite WOORI_AGENT_DB_PATH=/var/lib/woori-ai-agent/agent.sqlite /opt/woori-ai-agent/current/node_modules/.bin/tsx /opt/woori-ai-agent/current/apps/cli/src/index.ts db backup --directory=/var/lib/woori-ai-agent/backups --apply=true ;;
  restore)
    [[ -n "$BACKUP" && -n "$DESTINATION" ]] || { echo 'Restore requires --backup=<snapshot> and --destination=<new path>.' >&2; exit 2; }
    runuser -u woori-agent -- env WOORI_CONTROLLER_DB_PATH=/var/lib/woori-ai-agent/controller/queue.sqlite WOORI_AGENT_DB_PATH=/var/lib/woori-ai-agent/agent.sqlite /opt/woori-ai-agent/current/node_modules/.bin/tsx /opt/woori-ai-agent/current/apps/cli/src/index.ts db restore "--backup=$BACKUP" "--destination=$DESTINATION" --apply=true ;;
  remove)
    [[ "$TARGET" == all ]] || { echo 'Removal is only supported for the complete dedicated agent unit set.' >&2; exit 2; }
    systemctl stop woori-agent-backup.timer woori-agent-scheduler.service woori-agent-worker.service woori-agent-dashboard.service woori-agent-controller.service 2>/dev/null || true
    systemctl disable woori-agent-backup.timer woori-agent-scheduler.service woori-agent-worker.service woori-agent-dashboard.service woori-agent-controller.service 2>/dev/null || true
    for unit in woori-agent-backup.service woori-agent-backup.timer woori-agent-scheduler.service woori-agent-worker.service woori-agent-dashboard.service woori-agent-controller.service woori-agent-controller.slice woori-agent-worker.slice; do rm -f -- "/etc/systemd/system/$unit"; done
    systemctl daemon-reload
    echo 'Agent units removed. SQLite, logs, configs, accounts, and release files were retained.' ;;
  help) echo 'Usage: manage.sh status|logs|verify|preflight|start|stop|restart|enable|disable|scheduler-opt-in|scheduler-opt-out|init-scheduler|backup|restore --backup=<snapshot> --destination=<new path>|remove [controller|scheduler|worker|dashboard|backup|all] [--apply]' ;;
esac
