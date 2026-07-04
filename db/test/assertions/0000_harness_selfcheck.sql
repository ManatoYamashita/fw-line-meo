-- 0000_harness_selfcheck.sql
-- Task 1.1: ハーネス機構の自己診断（スキーマではなく「機構」を証明する唯一のファイル）。
-- GREEN: 何も RAISE しなければ psql は 0 終了。
-- RED の確認方法: 下の RAISE EXCEPTION 行のコメントを外すと make db-test が非ゼロ終了する。
--   （RED→GREEN を一度観察したら必ずコメントへ戻すこと。）

DO $$
BEGIN
    -- RED 確認用（普段はコメントアウト）:
    -- RAISE EXCEPTION 'harness-red-check: 機構が失敗を非ゼロ終了として伝播することの確認';
    RAISE NOTICE 'harness selfcheck: OK';
END $$;
