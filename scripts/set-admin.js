'use strict';

const admin = require('firebase-admin');

function usage() {
  console.error('Uso: npm run admin -- <email> <grant|revoke>');
  process.exitCode = 1;
}

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const action = String(process.argv[3] || '').trim().toLowerCase();
  if (!email || !['grant', 'revoke'].includes(action)) {
    usage();
    return;
  }

  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawServiceAccount) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT não configurada.');
  }

  const serviceAccount = JSON.parse(rawServiceAccount);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

  const user = await admin.auth().getUserByEmail(email);
  const ref = admin.firestore().collection('admins').doc(user.uid);
  await ref.set({
    email: user.email || email,
    ativo: action === 'grant',
    atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log(
    action === 'grant'
      ? `Acesso administrativo concedido para ${email}.`
      : `Acesso administrativo removido de ${email}.`
  );
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exitCode = 1;
});
