-- 0017_owner_invite_code.sql
-- agency-dashboard Requirement 8（Issue #486）: オーナーがどの招待コードで登録したかを記録する。
-- それまでは owners が agency_id しか持たず、オーナー登録の処理は検証した招待コードから代理店だけを
-- 取り出して捨てていたので、「このコードで、このオーナーが LINE を使い始めた」はどこにも残っていなかった。
--
-- 1. agency_invite_codes に UNIQUE (agency_id, id) を足す
--    下の複合 FK の参照先。id は既に主キーなので組も一意であり、既存行には何も起きない。
--    agencies(operator_id, id)・competitors(store_id, id) と同じ形（0001）。
--
-- 2. owners.invite_code_id（Requirement 8.1, 8.4）
--    登録に用いられた招待コード。NULL = 記録なし（この migration より前の登録）。
--    - 既存行を埋めない（バックフィルの UPDATE を持たない）。作成の時点で代理店の有効なコードが 1 つしか
--      無かったオーナーに限り推定で埋める案もあったが、推定値を事実として見せることになるので採らない。
--    - 新しい行に値を必須とする DB 制約は置かない。CHECK (invite_code_id IS NOT NULL) NOT VALID は
--      既存行を検査しないが、既存行を UPDATE するたびに検査されるので、記録の無いオーナーの状態遷移が
--      失敗する。新しい行の記録は TS の CreateOwnerInput.inviteCodeId の必須型と DB テストで担保する。
--    - 書込元は line-webhook のオーナー登録だけである（TS リアルタイム応答層・db/write-boundary.md）。
--
-- 3. fk_owners_invite_code_same_agency（Requirement 8.2, 8.3）
--    (agency_id, invite_code_id) → agency_invite_codes (agency_id, id)。
--    - 同じ代理店のコードに限る（8.2）。単独の FK（invite_code_id → agency_invite_codes(id)）では、
--      別の代理店のコードと結びついたオーナーを作れてしまう。
--    - MATCH SIMPLE（既定）なので invite_code_id が NULL の行は検査されない。既存オーナーはそのまま通る。
--    - ON DELETE RESTRICT（8.3）。コードの無効化は disabled_at だけで行い、記録が参照するコードは消せない。
--
-- 旧コードと互換である: 列は NULL 可で既定値を持たず、旧イメージの INSERT（invite_code_id を書かない）は
-- NULL で通る。**本番へは、invite_code_id を書く・読むイメージより先に当てること。** 逆順にすると、
-- line-webhook のオーナー登録と dashboard-api の GET /owners が column does not exist で落ちる。
-- deploy.yml は migration を流さないので、マージの前に適用して下の確認を行う。
--
-- 事前確認（本番・表の所有者で実行する。ALTER TABLE は所有者でないと実行できない）:
--   SELECT conname FROM pg_constraint
--    WHERE conname IN ('ux_agency_invite_codes_agency_id', 'fk_owners_invite_code_same_agency');
--   → 0 行（同名の制約がまだ無いこと）。
-- 適用の確認（本番）:
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_name = 'owners' AND column_name = 'invite_code_id';
--   → uuid・YES・NULL の 1 行。
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('ux_agency_invite_codes_agency_id', 'fk_owners_invite_code_same_agency')
--    ORDER BY conname;
--   → fk_owners_invite_code_same_agency … FOREIGN KEY (agency_id, invite_code_id)
--        REFERENCES agency_invite_codes(agency_id, id) ON DELETE RESTRICT
--     ux_agency_invite_codes_agency_id … UNIQUE (agency_id, id)
--   SELECT count(*) FROM owners WHERE invite_code_id IS NOT NULL;
--   → 0（適用の直後は全オーナーが記録なし）。

BEGIN;

ALTER TABLE agency_invite_codes
    ADD CONSTRAINT ux_agency_invite_codes_agency_id UNIQUE (agency_id, id);

ALTER TABLE owners
    ADD COLUMN invite_code_id uuid;

ALTER TABLE owners
    ADD CONSTRAINT fk_owners_invite_code_same_agency
        FOREIGN KEY (agency_id, invite_code_id)
        REFERENCES agency_invite_codes (agency_id, id) ON DELETE RESTRICT;

COMMIT;
