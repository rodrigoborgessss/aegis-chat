# AegisChat

Chat encriptado ponta-a-ponta em JavaScript puro e Node, sem frameworks. Implementa
a mesma engrenagem do Signal — **X3DH** para o aperto de mão, **Double Ratchet**
para a conversa, e **Sender Keys** para grupos — e junta-lhe o que falta para
não ser só uma demo: armazenamento local cifrado, autenticação real, persistência
no servidor e reposição de prekeys.

O servidor é apenas um relay. Nunca vê texto em claro nem chaves privadas: só
chaves públicas, cabeçalhos do ratchet e ciphertext.

> Continua a ser um projeto para perceber a engrenagem por dentro, não um
> substituto da biblioteca auditada do Signal. Para utilizadores reais usa o
> `@signalapp/libsignal-client`. Aqui a graça é ver como tudo encaixa.

## Pôr a correr

```bash
npm install
npm start            # relay + ficheiros estáticos em http://localhost:8080
```

Abre o endereço em **dois separadores**. Em cada um **cria uma conta**
(username + palavra-passe) ou entra. Usa nomes diferentes (ex.: `alice` e `bob`),
escreve o nome do outro em "novo contacto" e fala. A primeira mensagem dispara o
X3DH; daí para a frente é o Double Ratchet.

Na **primeira vez em cada dispositivo** pede-te uma *passphrase* para cifrar o
armazenamento local (ver "Armazenamento cifrado"). É independente da
palavra-passe da conta.

> **HTTPS é obrigatório fora do `localhost`.** A WebCrypto só funciona em contexto
> seguro. Em `http://` (que não seja localhost) o `crypto.subtle` não existe e a
> app não consegue cifrar nada. No telemóvel, abre sempre por `https://`.

### Funcionalidades

- Mensagens de texto, **fotos, ficheiros e áudio** (gravação pelo microfone),
  cifrados como o texto. Limite de 2 MB por anexo (imagens são comprimidas);
  vídeo até 16 MB.
- No telemóvel, botão de **câmara** para tirar foto ou gravar vídeo e enviar na
  hora, de dentro da conversa ou escolhendo o destinatário depois.
- **Mensagens temporárias** por conversa (apagam-se passado o tempo escolhido),
  com o temporizador sincronizado entre os dois lados.
- Indicadores de **"a escrever…"** e **"a gravar áudio…"**.
- **Grupos** (ver secção própria).
- **Números de segurança** para verificar identidades (por par e por grupo).

## Como está organizado

```
public/
  ratchet.js   primitivas + X3DH + Double Ratchet + Sender Keys + números de segurança
  session.js   cola entre X3DH e ratchet: identidade, bundle, sessões, cifrar/decifrar
  group.js     grupos com Sender Keys (fan-out, rotação na saída, fora de ordem)
  store.js     IndexedDB por utilizador, cifrado em repouso
  vault.js     derivação Argon2id + serialização do estado + cifragem dos valores
  dmsync.js    regra de convergência do temporizador de mensagens temporárias
  app.js       interface + cliente WebSocket
  index.html   UI (estilo Signal, tema escuro)
  vendor/
    argon2.min.js   Argon2id (hash-wasm) com o WASM embebido — sem rede em runtime
server.js      relay WebSocket + estáticos + API de login; persiste bundles e mailbox
auth.js        contas (scrypt) e tokens de sessão, em data/
tests/         suite offline + suite pelo servidor real
```

A cripto (`ratchet.js`) corre igual no Node e no browser — só usa WebCrypto — o
que permite testar o motor todo offline.

## Criptografia

- **Curvas: P-256.** ECDH P-256 para os Diffie-Hellman, ECDSA P-256 para as
  assinaturas. (Versões anteriores usavam X25519/Ed25519; mudou-se para P-256
  porque a WebCrypto de muitos browsers de telemóvel ainda não suporta as curvas
  de Edwards/Montgomery.)
- **KDF de cadeia:** HMAC-SHA-256. **Derivação de raiz:** HKDF-SHA-256.
- **Cifra de mensagens:** AES-256-GCM, IV novo por mensagem.
- **X3DH:** combina IK/SPK/OPK + chave efémera em quatro (ou três, sem OPK) DH,
  derivando o segredo inicial da sessão.
- **Double Ratchet:** ratchet de DH a cada viragem de sentido + cadeias
  simétricas em cada direção. Guarda as *skipped message keys* em cache
  (`MKSKIPPED`, teto de 1000 saltos de uma vez e 2000 chaves guardadas) para abrir
  mensagens fora de ordem.
- **Números de segurança:** fingerprint numérico por *hashing* iterado das chaves
  de identidade, ordenado para os dois lados chegarem ao mesmo valor.

## Armazenamento cifrado (em repouso)

Tudo o que fica no IndexedDB — identidade, prekeys, sessões do ratchet, histórico
de mensagens e estado dos grupos — é cifrado com **AES-256-GCM**. A chave deriva
da *passphrase* com **Argon2id (64 MiB, 3 passes)**, o mesmo perfil do KeyVault,
via WASM vendorizado (sem chamadas de rede).

O estado tem objetos que não cabem em JSON (CryptoKey, `Uint8Array`, `Map`,
`Set`). O `vault.js` serializa-os antes de cifrar — as CryptoKey são exportáveis,
por isso exportam-se para bytes e reimportam-se ao ler.

**Desbloqueio por sessão (opção B):** depois de introduzires a *passphrase*, a
chave fica em `sessionStorage`, que o browser limpa quando fechas o separador.
Em recarregamentos não volta a pedir; num arranque a frio (separador novo ou
depois de fechar) pede outra vez. É um compromisso: mais cómodo do que pedir
sempre, mas a chave fica acessível à página enquanto o separador está aberto — o
que protege é o disco em repouso, não um atacante com execução de código na
página.

> Não há recuperação da *passphrase*. Se a esqueceres, este dispositivo perde o
> histórico local; a conta no servidor mantém-se e podes voltar a entrar (com
> identidade nova) noutro dispositivo.

## Grupos

*Sender Keys*: cada membro tem uma cadeia simétrica própria, distribui-a pelos
canais 1-para-1 (cifrados) e **assina** cada mensagem para se saber quem a
enviou. A mensagem é cifrada uma vez e reenviada a todos (fan-out do lado do
cliente).

- **Saída de um membro** dispara **rotação**: toda a gente gera cadeia nova, e
  quem saiu deixa de conseguir ler.
- **Fora de ordem:** cada remetente tem cache de chaves saltadas (o mesmo padrão
  do 1-para-1), por isso mensagens trocadas no caminho abrem na mesma, com
  anti-replay.
- **Verificação por grupo:** há um número de segurança derivado das chaves de
  identidade de **todos** os membros (ordenadas). Se for igual para todos,
  ninguém no grupo tem a identidade trocada. Aparece no painel do grupo.
- O estado (chaves, membros) e o histórico persistem cifrados no IndexedDB.

## Reposição de prekeys

As OPKs (one-time prekeys) gastam-se à medida que outros abrem sessão contigo.
Quando o servidor vê as tuas OPKs a descer abaixo de 2, avisa-te (se estiveres
online); o cliente gera mais e republica-as. O servidor guarda no máximo 30 por
utilizador.

## O servidor

Relay WebSocket + ficheiros estáticos + API de login. Só age depois de o cliente
apresentar um **token de sessão** válido — não confia no nome que o cliente diga,
liga o registo ao utilizador autenticado. Ninguém publica um bundle no teu nome
sem entrar na tua conta.

- **Palavras-passe:** guardadas só como sal + hash **scrypt**.
- **Persistência:** bundles e a *mailbox* de quem está offline são guardados em
  disco (`data/bundles.json`, `data/mailbox.json`); contas e sessões em
  `data/accounts.json` / `data/sessions.json`. O caminho é configurável por
  `DATA_DIR` (útil para um disco persistente).

**O que o servidor vê:** chaves públicas de identidade, prekeys, assinaturas,
cabeçalhos do ratchet (chaves DH públicas e contadores) e ciphertext.
**O que não vê:** chaves privadas nem o conteúdo das mensagens.

## Deploy

Funciona em qualquer host de Node com HTTPS. Num serviço como o Render basta
apontar para `npm start`. Atenção a uma coisa: **o disco do free tier é efémero**
— reinícios apagam `data/`, o que faz cair contas, bundles e mailbox. Para
guardar entre reinícios, monta um disco persistente e aponta-lhe o `DATA_DIR`.

## Testes

```bash
npm test          # suite offline: motor de cripto, fluxo completo, grupos
                  # (normais, fora de ordem, verificação), cofre cifrado,
                  # persistência, números de segurança, cruzamento de sessões,
                  # recuperação, fora de ordem 1-para-1, anexos, temporizador

npm start         # num terminal, arranca o relay...
npm run test:e2e  # ...e noutro corre os testes pelo servidor real
                  # (servidor, aviso de disponibilidade, auth, reposição de prekeys)
```

A suite offline cobre o motor inteiro porque a cripto não depende do browser. O
teste do cofre faz um fluxo X3DH + ratchet completo **através de um store
cifrado**, para garantir que serializar e cifrar o estado (CryptoKey incluídas)
não parte nada.

## Limitações (honestas)

- **Não é o libsignal.** É um motor próprio, sem auditoria. Para produção, usa a
  biblioteca do Signal.
- **Servidor de estado em ficheiros.** Persiste em JSON no disco, não numa base
  de dados. Chega para isto; não escala nem lida bem com concorrência alta.
- **Sem multi-dispositivo.** Cada browser é um dispositivo independente, com a
  sua identidade. Não há sincronização de sessões entre dispositivos do mesmo
  utilizador.
- **Chave do cofre em `sessionStorage`** enquanto o separador está aberto (opção
  B). Protege o disco em repouso, não execução de código malicioso na página.
- **Mudança de identidade.** Se um lado fizer "esquecer dispositivo", volta com
  identidade nova e a conversa reabre na primeira mensagem; o outro lado recebe
  aviso de que a identidade mudou. Confirmar que é legítimo (e não um intruso)
  faz-se comparando os números de segurança fora da app.
