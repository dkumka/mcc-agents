import type { PermissionModeInfo } from '@mcc-agents/protocol';

// IDs on-request / never retain compatibility with existing saved chat settings.
export const CODEX_MODES: PermissionModeInfo[] = [
  { id: 'read-only', label: 'Только чтение', description: 'Чтение без изменений файлов и без расширения доступа' },
  { id: 'on-request', label: 'Работа в проекте', description: 'Правки и команды в проекте; сеть и расширение доступа — с разрешения' },
  { id: 'never', label: 'Полный доступ', description: 'Файлы вне проекта и сеть без подтверждений, в пределах прав пользователя Linux' },
];

export function codexPermissions(mode = 'on-request') {
  if (mode === 'never') return {
    approvalPolicy: 'never' as const,
    sandbox: 'danger-full-access' as const,
    sandboxPolicy: { type: 'dangerFullAccess' as const },
  };
  if (mode === 'read-only') return {
    approvalPolicy: 'never' as const,
    sandbox: 'read-only' as const,
    sandboxPolicy: { type: 'readOnly' as const, networkAccess: false },
  };
  if (mode !== 'on-request') throw new Error(`Неизвестный режим доступа Codex: ${mode}`);
  return {
    approvalPolicy: 'on-request' as const,
    sandbox: 'workspace-write' as const,
    sandboxPolicy: {
      type: 'workspaceWrite' as const, writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
  };
}
