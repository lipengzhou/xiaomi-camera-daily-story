import { createHash, randomBytes } from "node:crypto";

export function rc4Crypt(key: Uint8Array, input: Uint8Array, drop = 1024): Buffer {
  if (key.length === 0) {
    throw new Error("RC4 key cannot be empty");
  }
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (state[i] ?? 0) + (key[i % key.length] ?? 0)) & 0xff;
    const temporary = state[i] ?? 0;
    state[i] = state[j] ?? 0;
    state[j] = temporary;
  }

  let i = 0;
  j = 0;
  const nextByte = (): number => {
    i = (i + 1) & 0xff;
    j = (j + (state[i] ?? 0)) & 0xff;
    const temporary = state[i] ?? 0;
    state[i] = state[j] ?? 0;
    state[j] = temporary;
    return state[((state[i] ?? 0) + (state[j] ?? 0)) & 0xff] ?? 0;
  };

  for (let count = 0; count < drop; count += 1) {
    nextByte();
  }
  return Buffer.from(input.map((value) => value ^ nextByte()));
}

export function generateNonce(now = Date.now(), entropy: Uint8Array = randomBytes(8)): string {
  if (entropy.length !== 8) {
    throw new Error("Nonce entropy must contain exactly 8 bytes");
  }
  const minute = Math.floor(now / 60_000);
  const value = Buffer.alloc(12);
  Buffer.from(entropy).copy(value, 0);
  value.writeUInt32BE(minute >>> 0, 8);
  return value.toString("base64");
}

export function signedNonce(ssecurity: string, nonce: string): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
    .digest("base64");
}

export function signaturePath(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname.startsWith("/app/") ? pathname.slice(4) : pathname;
}

export function encryptedSignature(
  method: string,
  url: string,
  values: ReadonlyMap<string, string>,
  nonceKey: string,
): string {
  const pieces = [method.toUpperCase(), signaturePath(url)];
  for (const [key, value] of values) {
    pieces.push(`${key}=${value}`);
  }
  pieces.push(nonceKey);
  return createHash("sha1").update(pieces.join("&"), "utf8").digest("base64");
}

function encryptValue(nonceKey: string, value: string): string {
  return rc4Crypt(Buffer.from(nonceKey, "base64"), Buffer.from(value, "utf8")).toString(
    "base64",
  );
}

export interface EncryptedQueryOptions {
  includeSsecurity: boolean;
  now?: number;
  entropy?: Uint8Array;
}

export interface EncryptedQuery {
  fields: URLSearchParams;
  signedNonce: string;
}

export function createEncryptedQuery(
  method: string,
  url: string,
  data: string,
  ssecurity: string,
  options: EncryptedQueryOptions,
): EncryptedQuery {
  const nonce = generateNonce(options.now, options.entropy ?? randomBytes(8));
  const nonceKey = signedNonce(ssecurity, nonce);
  const plain = new Map<string, string>([["data", data]]);
  plain.set("rc4_hash__", encryptedSignature(method, url, plain, nonceKey));

  const encrypted = new Map<string, string>();
  for (const [key, value] of plain) {
    encrypted.set(key, encryptValue(nonceKey, value));
  }
  const fields = new URLSearchParams();
  for (const [key, value] of encrypted) {
    fields.set(key, value);
  }
  fields.set("signature", encryptedSignature(method, url, encrypted, nonceKey));
  if (options.includeSsecurity) {
    fields.set("ssecurity", ssecurity);
  }
  fields.set("_nonce", nonce);
  return { fields, signedNonce: nonceKey };
}

export function decryptBase64Rc4Response(nonceKey: string, payload: Uint8Array): Buffer {
  const encoded = Buffer.from(payload).toString("utf8").trim();
  return rc4Crypt(Buffer.from(nonceKey, "base64"), Buffer.from(encoded, "base64"));
}
