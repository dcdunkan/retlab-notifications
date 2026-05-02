import crypto from "node:crypto";

export function generateApiKey() {
	return crypto.randomBytes(32).toString("hex");
}

export interface KeyPair {
	privateKey: string; // PEM PKCS#8
	publicKey: string; // PEM SPKI
}

export interface PartyKeys {
	sign: KeyPair; // Ed25519
	enc: KeyPair; // X25519
}

export interface PublicKeys {
	sign: string; // Ed25519 public key PEM
	enc: string; // X25519 public key PEM
}

export interface EncryptedEnvelope {
	ephemeralPub: string; // X25519 ephemeral public key PEM
	iv: string; // base64, 12 bytes
	authTag: string; // base64, 16 bytes
	ciphertext: string; // base64
}

export interface SignedEnvelope extends EncryptedEnvelope {
	senderId: string;
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Ed25519 sign / verify

function sign(data: string, privateKeyPem: string): string {
	const sig = crypto.sign(null, encoder.encode(data), privateKeyPem);
	return toBase64(sig);
}

function verify(
	data: string,
	signatureB64: string,
	publicKeyPem: string,
): boolean {
	try {
		return crypto.verify(
			null,
			encoder.encode(data),
			publicKeyPem,
			fromBase64(signatureB64),
		);
	} catch {
		return false;
	}
}

// ECIES: X25519 + HKDF-SHA256 + AES-256-GCM

function encryptTo(
	plaintext: string,
	recipientEncPubPem: string,
): EncryptedEnvelope {
	// 1. Ephemeral key pair (fresh per message)
	const ephemeral = crypto.generateKeyPairSync("x25519");

	// 2. ECDH shared secret
	const shared = crypto.diffieHellman({
		privateKey: ephemeral.privateKey,
		publicKey: crypto.createPublicKey(recipientEncPubPem),
	});

	// 3. Derive 256-bit AES key via HKDF-SHA256
	const aesKey = new Uint8Array(
		crypto.hkdfSync("sha256", shared, new Uint8Array(32), "aes-key", 32),
	);

	// 4. AES-256-GCM encrypt
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);

	const ct = new Uint8Array(cipher.update(encoder.encode(plaintext)));
	cipher.final();
	const authTag = new Uint8Array(cipher.getAuthTag());

	return {
		ephemeralPub: ephemeral.publicKey.export({
			type: "spki",
			format: "pem",
		}) as string,
		iv: toBase64(iv),
		authTag: toBase64(authTag),
		ciphertext: toBase64(ct),
	};
}

function decryptFrom(
	envelope: EncryptedEnvelope,
	myEncPrivPem: string,
): string {
	const { ephemeralPub, iv, authTag, ciphertext } = envelope;

	const shared = crypto.diffieHellman({
		privateKey: crypto.createPrivateKey(myEncPrivPem),
		publicKey: crypto.createPublicKey(ephemeralPub),
	});

	const aesKey = new Uint8Array(
		crypto.hkdfSync("sha256", shared, new Uint8Array(32), "aes-key", 32),
	);
	const decipher = crypto.createDecipheriv(
		"aes-256-gcm",
		aesKey,
		fromBase64(iv),
	);
	decipher.setAuthTag(fromBase64(authTag));

	const plaintext = new Uint8Array(decipher.update(fromBase64(ciphertext)));
	decipher.final(); // (throws if auth tag is invalid)
	return decoder.decode(plaintext);
}

export function createMessage(
	payload: unknown,
	senderSignPrivPem: string,
	recipientEncPubPem: string,
): EncryptedEnvelope {
	const data = JSON.stringify(payload);
	const signature = sign(data, senderSignPrivPem);
	return encryptTo(JSON.stringify({ data, signature }), recipientEncPubPem);
}

export function openMessage<T = unknown>(
	envelope: EncryptedEnvelope,
	myEncPrivPem: string,
	senderSignPubPem: string,
): T {
	const raw = decryptFrom(envelope, myEncPrivPem);
	const { data, signature } = JSON.parse(raw) as {
		data: string;
		signature: string;
	};

	if (!verify(data, signature, senderSignPubPem)) {
		throw new Error("Signature verification failed");
	}

	return JSON.parse(data) as T;
}
