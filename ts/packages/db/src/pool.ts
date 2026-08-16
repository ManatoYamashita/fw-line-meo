import { Pool } from 'pg';

// アクセサが受け取る最小の問い合わせ面（Pool / PoolClient / テスト用モックが適合）。
export type Queryable = Pick<Pool, 'query'>;

// トランザクションクライアント（query に加え release を持つ）。BEGIN/COMMIT を張る保護付き操作が使う。
// pg の PoolClient が構造的に適合する（release の任意引数は () => void へ代入可能）。
export interface TransactionClient extends Queryable {
  release(): void;
}

// connect() でトランザクションクライアントを得られるプール面（design: Component Contracts / DAL）。
// pg の Pool が構造的に適合し、実配線では getPool() の戻り値をそのまま渡せる
// （@fwlm/store-identification の ConnectablePool と同型のパターン）。
export interface TransactionCapable {
  connect(): Promise<TransactionClient>;
}

// 接続 2 系統（design: Components/pool）:
//   - test/local: DATABASE_URL（標準 pg・native postgres の unix socket も可）
//   - 本番:      @google-cloud/cloud-sql-connector（IAM 認証・パスワードレス）
// Connector 経路は実 Cloud SQL でしか疎通できないため、ここでは分岐選択のみを純粋関数に切り出し
// ユニットテスト可能にする。実接続 smoke は後続 spec / feature validation が担う。

export type PoolMode = 'database-url' | 'cloud-sql-iam';

/** DATABASE_URL の有無で接続モードを決める（副作用なし・テスト可能）。 */
export function resolvePoolMode(env: NodeJS.ProcessEnv = process.env): PoolMode {
  return env.DATABASE_URL ? 'database-url' : 'cloud-sql-iam';
}

let pool: Pool | null = null;

/** プロセス共有の単一 Pool を返す（初回に接続を確立）。 */
export async function getPool(): Promise<Pool> {
  if (pool) return pool;
  pool = await createPool(process.env);
  return pool;
}

/** env からモードを解決して Pool を生成する（getPool の実体・テストで env 注入可能）。 */
export async function createPool(env: NodeJS.ProcessEnv): Promise<Pool> {
  if (resolvePoolMode(env) === 'database-url') {
    return new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  }
  const instanceConnectionName = requireEnv(env, 'CLOUDSQL_CONNECTION_NAME');
  const user = requireEnv(env, 'DB_IAM_USER');
  const database = requireEnv(env, 'DB_NAME');
  const { Connector, IpAddressTypes, AuthTypes } = await import(
    '@google-cloud/cloud-sql-connector'
  );
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName,
    ipType: IpAddressTypes.PUBLIC,
    authType: AuthTypes.IAM,
  });
  return new Pool({ ...clientOpts, user, database, max: 5 });
}

/** テストやシャットダウンで Pool を閉じる。 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing required env: ${key}`);
  return value;
}
