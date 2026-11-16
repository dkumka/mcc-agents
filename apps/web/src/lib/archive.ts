import { toast } from 'sonner';
import { store } from '@/lib/store';

/** Soft archive: the chat leaves the main list for «Архив»; nothing is deleted. */
export function setArchived(chatId: string, archived: boolean) {
  const title = store.state.chats[chatId]?.title ?? 'Чат';
  store.meta(chatId, { archived });
  toast.success(archived ? 'В архиве' : 'Возвращён из архива', {
    description: title,
    action: { label: 'Отменить', onClick: () => store.meta(chatId, { archived: !archived }) },
    duration: 6000,
  });
}
