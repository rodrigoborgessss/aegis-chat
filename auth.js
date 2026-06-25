// auth.js — contas e sessões do lado do servidor.
// Palavras-passe nunca são guardadas em claro: guardamos sal aleatório + hash
// scrypt (KDF forte, recomendado pela OWASP, e já vem no Node — sem dependências
// nativas, corre em qualquer lado). A comparação é em tempo constante.
// Contas e sessões persistem em ficheiros JSON, por isso sobrevivem a reiniciar.
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const DIR = process.env.DATA_DIR || join(fileURLToPath(new URL(".", import.meta.url)), "data");
const ACCOUNTS = join(DIR, "accounts.json");
const SESSIONS = join(DIR, "sessions.json");

// parâmetros scrypt (custo). N=2^15 é um bom equilíbrio para um servidor.
// maxmem tem de acomodar ~128*N*r bytes (≈32 MiB aqui), por isso subimos o limite.
const COST = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, KEYLEN = 32;

const load = f => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };
const saveJSON = (f, obj) => { try { mkdirSync(DIR, { recursive: true }); writeFileSync(f, JSON.stringify(obj, null, 2)); } catch (e) { console.error("auth: não consegui guardar", f, e.message); } };

let accounts = load(ACCOUNTS); // user -> { salt, hash }  (hex)
let sessions = load(SESSIONS); // token -> user

const hashPw = (pw, saltHex) => scryptSync(pw, Buffer.from(saltHex, "hex"), KEYLEN, COST).toString("hex");

export const userExists = u => Object.prototype.hasOwnProperty.call(accounts, u);

export function signup(u, pw) {
  if (userExists(u)) return { error: "esse username já existe" };
  const salt = randomBytes(16).toString("hex");
  accounts[u] = { salt, hash: hashPw(pw, salt) };
  saveJSON(ACCOUNTS, accounts);
  return { user: u };
}

export function verify(u, pw) {
  const a = accounts[u];
  if (!a) return false;
  const got = Buffer.from(hashPw(pw, a.salt), "hex");
  const want = Buffer.from(a.hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createSession(u) {
  const token = randomBytes(32).toString("hex");
  sessions[token] = u;
  saveJSON(SESSIONS, sessions);
  return token;
}
export const sessionUser = token => sessions[token] || null;
export function dropSession(token) { if (sessions[token]) { delete sessions[token]; saveJSON(SESSIONS, sessions); } }
