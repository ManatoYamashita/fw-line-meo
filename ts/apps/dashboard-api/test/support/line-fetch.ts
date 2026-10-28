// 合成根（buildAppDeps）へ渡す LINE 用の取得関数の試験用の実装（owner-line-unlink）。
//
// 合成根は LINE のアダプタを、注入された取得関数で組み立てる。試験から api.line.me へ通信しないよう、
// LINE を呼ばない試験は refuseLineFetch を渡す。呼ばれると拒否するので、アダプタは token_failed を返し、
// 外部へは何も出ない。

/** 呼ばれたら必ず拒否する取得関数。LINE を呼ぶはずのない試験で使う。 */
export const refuseLineFetch: typeof fetch = () =>
  Promise.reject(new Error('この試験は LINE を呼ばない'));
