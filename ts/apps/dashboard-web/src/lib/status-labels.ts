import type { OnboardingStatus, PlaceStatus } from './types';

// 状態の表示語の対応表（Issue #485）。店舗一覧（/stores）・店舗登録（/stores/new）・代理店詳細（Issue #486）の
// 3 面が同じ語を使う。面ごとに文字列を書くと、片方だけを直したときに同じ状態が面によって違う語で
// 読まれ、それを検出するものが無くなる。**面の側で状態の語を書かず、ここから引く。**

// オーナーのオンボーディング状態（four-tier-data-model の OnboardingStatus）。
export const ONBOARDING_STATUS_LABEL: Readonly<Record<OnboardingStatus, string>> = {
  pending: '店舗特定前',
  store_identified: '店舗特定済み',
  active: '利用中',
};

// 店舗の場所の確定状態（four-tier-data-model の PlaceStatus）。
export const PLACE_STATUS_LABEL: Readonly<Record<PlaceStatus, string>> = {
  pending: '未確定',
  confirmed: '確定済み',
};

// 店舗の利用状況（store-suspension）。停止は異常ではなく状態なので、危険の色を伴わせない。
export const STORE_SUSPENSION_LABEL = {
  active: '利用中',
  suspended: '停止中',
} as const;

/** 停止時刻（null は利用中）から利用状況の表示語を引く。 */
export function storeSuspensionLabel(suspendedAt: string | null): string {
  return suspendedAt === null ? STORE_SUSPENSION_LABEL.active : STORE_SUSPENSION_LABEL.suspended;
}
