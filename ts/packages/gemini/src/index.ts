// @fwlm/gemini — Gemini 実行核の共有パッケージ。
// safetySettings の既定付与・1 回リトライ・出力検証・エラー分類を単一所有する。
// プロンプト・素材型・ユースケース固有の検証は消費者側（survey-web / line-webhook）の責務。
export * from './result.js';
export * from './types.js';
export * from './executor.js';
export * from './client.js';
