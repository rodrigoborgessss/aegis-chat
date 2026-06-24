// group.js — gestão de grupos com Sender Keys, independente de transporte.
// Persiste o estado (chaves, membros) após cada alteração, via saveGroup/deleteGroup.
import * as R from "./ratchet.js";

export function createGroupManager(cfg) {
  const { me, sendPairwise, sendGroup, onMessage, onSystem, myDn, saveGroup, deleteGroup } = cfg;
  const groups = new Map();      // gid -> { gid, name, members:Set, my:{chainKey,sign,it}, senders:Map }
  const pending = new Map();     // gid -> [skdm] que chegaram antes do convite
  const persist = gid => groups.has(gid) && saveGroup ? saveGroup(gid, groups.get(gid)) : null;

  const skdmOf = g => ({ gid: g.gid, chainKey: R.b64(g.my.chainKey), it: g.my.it, signPub: R.b64(g.my.sign.pub) });
  const addSender = (g, from, s) => g.senders.set(from, { chainKey: R.unb64(s.chainKey), it: s.it, signPub: R.unb64(s.signPub) });
  async function freshSenderKey() { const sk = await R.groupSenderKey(); return { chainKey: sk.chainKey, sign: sk.sign, it: 0 }; }
  async function distributeMine(g) {
    for (const m of g.members) if (m !== me) await sendPairwise(m, { skdm: skdmOf(g) });
  }

  return {
    restore: list => { for (const g of (list || [])) groups.set(g.gid, g); },
    list: () => [...groups.values()].map(g => ({ gid: g.gid, name: g.name, members: [...g.members] })),
    members: gid => groups.has(gid) ? [...groups.get(gid).members] : [],
    name: gid => groups.get(gid)?.name || gid,
    has: gid => groups.has(gid),

    async create(gid, name, members) {
      const set = new Set([...members.map(m => m.toLowerCase()), me]);
      const g = { gid, name, members: set, my: await freshSenderKey(), senders: new Map() };
      groups.set(gid, g);
      await persist(gid);
      for (const m of set) if (m !== me) await sendPairwise(m, { grpInvite: { gid, name, members: [...set], skdm: skdmOf(g) } });
      onSystem(gid, `Criaste o grupo "${name}".`);
      return gid;
    },

    async handleInvite(from, { gid, name, members, skdm }) {
      if (!groups.has(gid)) {
        const g = { gid, name, members: new Set(members), my: await freshSenderKey(), senders: new Map() };
        groups.set(gid, g);
        addSender(g, from, skdm);
        for (const s of (pending.get(gid) || [])) addSender(g, s.from, s.skdm);
        pending.delete(gid);
        await persist(gid);
        await distributeMine(g);
        onSystem(gid, `Entraste no grupo "${name}".`);
      } else { addSender(groups.get(gid), from, skdm); await persist(gid); }
    },

    async handleSKDM(from, skdm) {
      const g = groups.get(skdm.gid);
      if (!g) { if (!pending.has(skdm.gid)) pending.set(skdm.gid, []); pending.get(skdm.gid).push({ from, skdm }); return; }
      addSender(g, from, skdm); await persist(skdm.gid);
    },

    async send(gid, text) {
      const g = groups.get(gid); if (!g) return;
      const sealed = await R.groupSeal(g.my.chainKey, g.my.sign, text);
      const it = g.my.it; g.my.chainKey = sealed.chainKey; g.my.it++;
      await persist(gid);
      const grp = { gid, from: me, dn: myDn(), it, iv: R.b64(sealed.iv), ct: R.b64(sealed.ct), sig: R.b64(sealed.sig) };
      for (const m of g.members) if (m !== me) await sendGroup(m, grp);
      onMessage(gid, me, myDn(), text, true);
    },

    async handleGroupMessage(grp) {
      const g = groups.get(grp.gid); if (!g) return;
      const s = g.senders.get(grp.from);
      if (!s) { onSystem(grp.gid, `chegou mensagem de ${grp.dn || grp.from} mas ainda não tenho a chave dele.`); return; }
      if (grp.it < s.it) return;
      if (grp.it > s.it) { s.chainKey = await R.groupAdvance(s.chainKey, grp.it - s.it); s.it = grp.it; }
      try {
        const r = await R.groupOpen(s.chainKey, s.signPub, R.unb64(grp.iv), R.unb64(grp.ct), R.unb64(grp.sig));
        s.chainKey = r.chainKey; s.it = grp.it + 1;
        await persist(grp.gid);
        onMessage(grp.gid, grp.from, grp.dn || grp.from, r.pt, false);
      } catch { onSystem(grp.gid, `não consegui abrir uma mensagem de ${grp.dn || grp.from} (chave rodada ou assinatura inválida).`); }
    },

    async leave(gid) {
      const g = groups.get(gid); if (!g) return;
      for (const m of g.members) if (m !== me) await sendPairwise(m, { grpLeave: { gid } });
      groups.delete(gid); if (deleteGroup) await deleteGroup(gid);
    },
    async handleLeave(from, { gid }) {
      const g = groups.get(gid); if (!g) return;
      g.members.delete(from); g.senders.delete(from);
      g.my = await freshSenderKey();                      // ROTAÇÃO
      await persist(gid);
      await distributeMine(g);
      onSystem(gid, `${from} saiu — toda a gente rodou as chaves, o ${from} deixa de conseguir ler.`);
    },

    async addMember(gid, user) {
      user = user.toLowerCase();
      const g = groups.get(gid); if (!g || g.members.has(user)) return;
      g.members.add(user); await persist(gid);
      await sendPairwise(user, { grpInvite: { gid, name: g.name, members: [...g.members], skdm: skdmOf(g) } });
      for (const m of g.members) if (m !== me && m !== user) await sendPairwise(m, { grpAdd: { gid, user } });
      onSystem(gid, `Adicionaste ${user} ao grupo.`);
    },
    async handleAdd(from, { gid, user }) {
      const g = groups.get(gid); if (!g) return;
      g.members.add(user); await persist(gid);
      await sendPairwise(user, { skdm: skdmOf(g) });
      onSystem(gid, `${user} entrou no grupo.`);
    },
  };
}
