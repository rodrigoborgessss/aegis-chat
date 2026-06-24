# AegisChat

Um chat encriptado ponta-a-ponta, feito para aprender como o Signal funciona por
dentro. Junta três peças por fases: cadeia simétrica de chaves,
Double Ratchet (com ratchet de DH) e o aperto de mão X3DH. O servidor é só um
relay — nunca vê texto em claro nem chaves privadas.

## Como pôr a correr

```bash
npm install
node server.js
```

Depois abre `http://localhost:8080` em **dois separadores**. Em cada um, **cria
uma conta** (username + palavra-passe) — ou entra, se já tiveres. Usa nomes
diferentes em cada separador (ex.: `alice` e `bob`), escreve o nome do outro em
"novo contacto" e fala. A primeira mensagem dispara o X3DH; daí para a frente é
o Double Ratchet a tratar de tudo. Também dá para enviar **fotos, ficheiros e
áudio** (com gravação pelo microfone) — vão cifrados como o texto, com limite de
2 MB por anexo; as imagens são comprimidas para caberem.

A palavra-passe é guardada no servidor só como sal + hash **scrypt** (nunca em
claro) e serve para autenticar quem és — ninguém pode publicar um bundle no teu
nome sem entrar na tua conta. As contas e as sessões ficam em `data/` (não vai
para o git). Nota: a palavra-passe protege a tua conta no servidor, não cifra os
dados locais do browser — isso seria um passo à parte.

## Como está organizado

- `public/ratchet.js` — o motor: primitivas (X25519, Ed25519, HKDF, AES-GCM),
  X3DH e Double Ratchet. Corre igual no Node e no browser, só WebCrypto.
- `public/session.js` — a cola entre o X3DH e o ratchet: identidade, bundle de
  prekeys, iniciar/receber sessão, cifrar/decifrar e serializar envelopes.
- `public/group.js` — grupos com Sender Keys: cada membro distribui a sua cadeia
  pelos canais 1-para-1, assina cada mensagem, e há rotação de chaves quando
  alguém sai.
- `public/store.js` — guarda chaves e sessões em IndexedDB (sobrevivem a
  recarregar a página).
- `public/app.js` + `public/index.html` — a interface.
- `server.js` — relay WebSocket + ficheiros estáticos + API de login. Guarda os
  bundles e uma mailbox para quem está offline. Só age depois de o cliente
  apresentar um token de sessão válido.
- `auth.js` — contas e sessões: hash scrypt das palavras-passe, tokens, e
  persistência em `data/`.
- `tests/` — os testes (cripto e fluxo completo).

```bash
npm test          # testes offline (X3DH, ratchet, grupos, persistência,
                  # números de segurança, cruzamento, recuperação de sessão)

npm start         # arranca o relay num terminal...
npm run test:e2e  # ...e os testes pelo servidor real noutro
```

## O que o servidor vê (e o que não vê)

Vê: chaves públicas de identidade, prekeys, assinaturas, os cabeçalhos do ratchet
(chaves DH públicas e contadores) e o ciphertext. Não vê: chaves privadas nem o
conteúdo das mensagens. É o modelo de confiança certo — mesmo um servidor
curioso não consegue ler nada.

## O que ficou de fora (de propósito)

Isto é para aprender, não para produção. Faltam coisas que um sistema a sério tem:

- **Mensagens fora de ordem.** Assumo entrega em ordem por par. Numa
  implementação real guardas as *skipped message keys* em cache para abrir
  mensagens que cheguem trocadas.
- **Estado do servidor em memória.** Reiniciar o `server.js` apaga bundles e
  mailboxes. Chega para testar; um servidor real usava uma base de dados.
- **Autenticação de utilizadores.** O servidor confia no nome que cada cliente
  diz ser. Se um lado fizer "esquecer dispositivo", volta com uma identidade
  nova: a conversa reabre assim que esse lado enviar a primeira mensagem, e o
  outro lado recebe um aviso de que a identidade mudou. Confirmar que o aviso é
  legítimo (e não um intruso a fazer-se passar pelo outro) é o passo seguinte:
  *safety numbers* / fingerprints, comparados fora da app.
- **Chaves em claro no IndexedDB.** O estado atual fica guardado sem cifragem.
  Repara que isto **não** quebra o passado — as chaves antigas já foram apagadas
  e o ratchet não recua — mas quem dumpar o disco lê o que estiver nas cadeias
  atuais. O endurecimento óbvio é cifrar o armazenamento com uma chave derivada
  de uma passphrase via Argon2id.
- **Sem reposição de prekeys.** As OPKs gastam-se e não são repostas
  automaticamente.
- **Grupos.** Usam *Sender Keys* com fan-out do lado do cliente e rotação de
  chaves na saída. O estado (chaves, membros) e o histórico das conversas já
  persistem no IndexedDB, por isso sobrevivem a sair e voltar a entrar.
  Falta-lhes o tratamento de mensagens fora de ordem, e a verificação de
  identidade é por par, não por grupo.

Para algo que vá para utilizadores reais, usa a biblioteca auditada do Signal
(`@signalapp/libsignal-client`) em vez deste motor. Aqui o objetivo era perceber
como a engrenagem funciona — e agora funciona.
