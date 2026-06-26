// session.js — a cola entre X3DH e o Double Ratchet, independente de transporte
// e de armazenamento. Recebe um `store` (IndexedDB no browser, memória nos testes).
import * as R from "./ratchet.js";

// ---- identidade e prekeys ----
const CRYPTO_V = 3; // 3 = tudo P-256 (ECDH + ECDSA); antes usava X25519/Ed25519
export async function ensureIdentity(store) {
  let id = await store.getIdentity();
  if (!id || id.v !== CRYPTO_V) { id = { v: CRYPTO_V, IK: await R.genX(), IKsig: await R.genEd() }; await store.setIdentity(id); await store.setSPK(null); }
  return id;
}
async function ensureSPK(store, IKsig) {
  let spk = await store.getSPK();
  if (!spk) {
    const kp = await R.genX();
    const sig = await R.edSign(IKsig, kp.pub);
    spk = { kp, sig }; await store.setSPK(spk);
  }
  return spk;
}
// bundle público para publicar no servidor
export async function buildBundle(store, nOpks = 5) {
  const id = await ensureIdentity(store);
  const spk = await ensureSPK(store, id.IKsig);
  const opks = [];
  for (let i = 0; i < nOpks; i++) {
    const kp = await R.genX();
    const oid = R.b64(R.rand(4));
    await store.addOPK(oid, kp);
    opks.push({ id: oid, pub: R.b64(kp.pub) });
  }
  return {
    ik: R.b64(id.IK.pub),
    ikSig: R.b64(id.IKsig.pub),
    spk: R.b64(spk.kp.pub),
    spkSig: R.b64(spk.sig),
    opks,
  };
}

// ---- iniciar sessão (quem começa) ----
export async function startSession(store, peer, peerBundle) {
  const id = await ensureIdentity(store);
  const bundle = {
    ik: R.unb64(peerBundle.ik),
    ikSig: R.unb64(peerBundle.ikSig),
    spk: R.unb64(peerBundle.spk),
    spkSig: R.unb64(peerBundle.spkSig),
    opk: peerBundle.opk ? { id: peerBundle.opk.id, pub: R.unb64(peerBundle.opk.pub) } : null,
  };
  const { SK, EKpub, opkId, theirSPK } = await R.x3dhInitiator(id.IK, bundle);
  const drState = await R.initAlice(SK, theirSPK);
  const session = {
    state: drState,
    peerIK: peerBundle.ik,
    pendingX3DH: { ika: R.b64(id.IK.pub), eka: R.b64(EKpub), opkId },
    iStarted: true, // fui eu que iniciei — usado no desempate de iniciação simultânea
  };
  await store.setSession(peer, session);
}

// ---- cifrar para um par (inclui o cabeçalho X3DH na 1.ª mensagem) ----
export async function encrypt(store, peer, plaintext) {
  const session = await store.getSession(peer);
  if (!session) throw new Error("sem sessão com " + peer + " — chama startSession primeiro");
  const e = await R.drEncrypt(session.state, plaintext);
  const dr = { dh: R.b64(e.header.dh), pn: e.header.pn, n: e.header.n, iv: R.b64(e.iv), ct: R.b64(e.ct) };
  const envelope = { dr };
  if (session.pendingX3DH) { envelope.x3dh = session.pendingX3DH; session.pendingX3DH = null; }
  session.state = e.state;
  await store.setSession(peer, session);
  return envelope;
}

// ---- decifrar de um par (estabelece sessão de recetor se vier X3DH) ----
export async function decrypt(store, peer, envelope) {
  const existing = await store.getSession(peer);
  let session = existing;
  let identityChanged = false;

  // Um envelope com X3DH significa que o outro lado (re)iniciou a sessão.
  if (envelope.x3dh) {
    const id = await ensureIdentity(store);
    const myIK = R.b64(id.IK.pub);
    const theirIK = envelope.x3dh.ika;
    const sameIdentity = existing && existing.peerIK === theirIK;

    // Iniciação simultânea (cruzamento): os dois lados abriram sessão ao mesmo
    // tempo, com a mesma identidade do par, antes de receberem o X3DH um do outro.
    // Desempate determinístico: fica a sessão de quem tem o IK menor. Se sou eu
    // o escolhido, ignoro o X3DH do par (ele vai adotar a minha sessão).
    if (existing && existing.iStarted && sameIdentity && myIK < theirIK) {
      return { ignored: true };
    }

    // Caso contrário adoto a sessão de recetor a partir deste X3DH. Cobre a 1.ª
    // conversa, o lado "perdedor" do cruzamento, e a reposição do par (identidade
    // nova => mudança de número de segurança).
    const spk = await store.getSPK();
    const opkPriv = envelope.x3dh.opkId ? await store.getOPK(envelope.x3dh.opkId) : null;
    const initial = { ika: R.unb64(envelope.x3dh.ika), eka: R.unb64(envelope.x3dh.eka) };
    const SK = await R.x3dhResponder(id.IK, spk.kp, opkPriv, initial);
    if (envelope.x3dh.opkId) await store.removeOPK(envelope.x3dh.opkId); // uso único
    if (existing && existing.peerIK && !sameIdentity) identityChanged = true;
    session = { state: R.initBob(SK, spk.kp), peerIK: envelope.x3dh.ika, pendingX3DH: null };
  }
  if (!session) throw new Error("mensagem sem sessão e sem X3DH — o outro lado tem de (re)iniciar a conversa");

  const h = envelope.dr;
  const header = { dh: R.unb64(h.dh), pn: h.pn, n: h.n };
  const d = await R.drDecrypt(session.state, header, R.unb64(h.iv), R.unb64(h.ct));
  session.state = d.state;
  if (session.iStarted) session.iStarted = false; // já recebi do par => sessão estabelecida
  await store.setSession(peer, session);
  return { plaintext: d.pt, ratcheted: d.ratcheted, identityChanged };
}
