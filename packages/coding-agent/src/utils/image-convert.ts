import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@earendil-works/pi-tui";
import { hasImageHelper, transcodeImageNative, transcodeImageNativeSync } from "./image-resize-native.ts";

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	return transcodeImageNative(bytes, "");
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

/**
 * Return a synchronous PNG transcoder for pi-tui's Kitty image rendering.
 * Returns undefined when the helper is unavailable.
 */
export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	if (!hasImageHelper()) return undefined;
	return (base64Data) => {
		const pngBytes = transcodeImageNativeSync(new Uint8Array(Buffer.from(base64Data, "base64")));
		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

let pngTranscoderLoad: Promise<boolean> | undefined;
let pngTranscoderRegistered = false;

/**
 * On Kitty-protocol terminals, register the helper as pi-tui's image transcoder so non-PNG images render.
 * `onRegistered` runs after registration so callers can re-render images that showed text fallbacks;
 * it is not called if the transcoder was already registered or cannot load.
 */
export function ensurePngTranscoder(onRegistered: () => void): void {
	if (pngTranscoderRegistered || getCapabilities().images !== "kitty") return;
	pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
		if (!transcoder) return false;
		setImageTranscoder(transcoder);
		pngTranscoderRegistered = true;
		return true;
	});
	void pngTranscoderLoad.then((registered) => {
		if (registered) onRegistered();
	});
}
