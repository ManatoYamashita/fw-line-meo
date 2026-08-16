// @fwlm/store-identification 公開契約の re-export
// （design.md「shared packages → @fwlm/store-identification（新規・移設）」）。
// line-webhook / dashboard-api の 2 消費者が同一契約を共有する（移設のみ・挙動変更なし）。
// 公開シグネチャの変更は本 spec では禁止（line-onboarding の Revalidation Trigger に該当するため）。
export * from './places-search.js';
export * from './store-identification.js';
