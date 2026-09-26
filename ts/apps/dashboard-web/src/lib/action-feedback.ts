'use client';

import { toast } from 'sonner';

interface ActionFeedback {
  readonly title: string;
  readonly description?: string;
}

// API のエラー本文は受け取らない。呼び出し側で error code を利用者向け文言へ写してから渡し、
// サーバや SDK の内部メッセージが通知へ流れ込む経路を作らない。
export function notifyActionSuccess({ title, description }: ActionFeedback): void {
  toast.success(title, { description });
}

export function notifyActionError({ title, description }: ActionFeedback): void {
  toast.error(title, { description, duration: 8000 });
}

export function notifyActionInfo({ title, description }: ActionFeedback): void {
  toast.info(title, { description });
}

export function notifyActionWarning({ title, description }: ActionFeedback): void {
  toast.warning(title, { description, duration: 8000 });
}
