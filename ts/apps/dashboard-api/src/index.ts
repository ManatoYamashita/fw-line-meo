import { serve } from '@hono/node-server';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import QRCode from 'qrcode';
import { getPool, findByAuthSubject, findStoreWithAgency, linkAuthSubjectByEmail } from '@fwlm/db';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

// Cloud Run エントリ。必須 env を検証し、firebase-admin / DB / qrcode の実依存を配線する。
const config = loadConfig();

// 添付 SA の ADC を使用（Cloud Run）。
initializeApp();
const auth = getAuth();

const app = createApp({
  qr: {
    auth: {
      // firebase-admin の DecodedIdToken を VerifiedToken に写像する（検証済みクレームのみ使う）。
      verifier: {
        verifyIdToken: async (token) => {
          const decoded = await auth.verifyIdToken(token);
          return {
            uid: decoded.uid,
            email: decoded.email ?? null,
            emailVerified: decoded.email_verified ?? false,
            signInProvider: decoded.firebase.sign_in_provider ?? null,
          };
        },
      },
      findUser: async (uid) => findByAuthSubject(await getPool(), uid),
      linkByEmail: async (email, uid) => linkAuthSubjectByEmail(await getPool(), email, uid),
    },
    findStore: async (id) => findStoreWithAgency(await getPool(), id),
    renderQr: (text, size) => QRCode.toBuffer(text, { width: size, margin: 1 }),
    surveyBaseUrl: config.surveyBaseUrl,
  },
});

serve({ fetch: app.fetch, port: config.port });
