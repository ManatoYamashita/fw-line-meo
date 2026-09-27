-- 本番照合に使うスキーマ名だけを出力する。表の行を読む SELECT は置かない。
-- 接続時の current_schema() を使うため、通常は public、自己テストでは隔離スキーマを読める。
WITH target_schema AS (
  SELECT oid, nspname
  FROM pg_catalog.pg_namespace
  WHERE nspname = pg_catalog.current_schema()
), targets AS (
  -- テーブル・ビュー・シーケンス等。index は下で親テーブルと一緒に別行にする。
  SELECT 'relation'::text AS kind, c.relname AS object_name, '-'::text AS parent_name
  FROM pg_catalog.pg_class AS c
  JOIN target_schema AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')

  UNION ALL
  SELECT 'column', a.attname, c.relname
  FROM pg_catalog.pg_attribute AS a
  JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
  JOIN target_schema AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.attnum > 0
    AND NOT a.attisdropped

  UNION ALL
  SELECT 'index', idx.relname, tbl.relname
  FROM pg_catalog.pg_index AS i
  JOIN pg_catalog.pg_class AS idx ON idx.oid = i.indexrelid
  JOIN pg_catalog.pg_class AS tbl ON tbl.oid = i.indrelid
  JOIN target_schema AS n ON n.oid = idx.relnamespace
  WHERE idx.relkind IN ('i', 'I')

  UNION ALL
  SELECT 'type', t.typname, '-'
  FROM pg_catalog.pg_type AS t
  JOIN target_schema AS n ON n.oid = t.typnamespace
  WHERE t.typisdefined
    AND t.typtype IN ('b', 'c', 'd', 'e', 'r', 'm')
    AND t.typelem = 0

  UNION ALL
  SELECT 'constraint', c.conname,
         CASE WHEN c.conrelid <> 0 THEN rel.relname ELSE typ.typname END
  FROM pg_catalog.pg_constraint AS c
  JOIN target_schema AS n ON n.oid = c.connamespace
  LEFT JOIN pg_catalog.pg_class AS rel ON rel.oid = c.conrelid
  LEFT JOIN pg_catalog.pg_type AS typ ON typ.oid = c.contypid

  UNION ALL
  SELECT 'enum_label', e.enumlabel, t.typname
  FROM pg_catalog.pg_enum AS e
  JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
  JOIN target_schema AS n ON n.oid = t.typnamespace

  UNION ALL
  SELECT 'routine', p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)
  FROM pg_catalog.pg_proc AS p
  JOIN target_schema AS n ON n.oid = p.pronamespace

  UNION ALL
  SELECT 'trigger', t.tgname, c.relname
  FROM pg_catalog.pg_trigger AS t
  JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
  JOIN target_schema AS n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal

  UNION ALL
  SELECT 'policy', p.polname, c.relname
  FROM pg_catalog.pg_policy AS p
  JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
  JOIN target_schema AS n ON n.oid = c.relnamespace

  UNION ALL
  SELECT 'rule', r.rulename, c.relname
  FROM pg_catalog.pg_rewrite AS r
  JOIN pg_catalog.pg_class AS c ON c.oid = r.ev_class
  JOIN target_schema AS n ON n.oid = c.relnamespace
)
SELECT kind, object_name, COALESCE(NULLIF(parent_name, ''), '-')
FROM targets
ORDER BY kind, object_name, parent_name;
