import { resizeImageNative } from "./image-resize-native.ts";
import type { ImageResizeOptions, ResizedImage } from "./image-resize-types.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-types.ts";

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * The packaged Rust helper does the work in a child process, so the TUI event
 * loop never blocks and the main process never holds a full-size decode.
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const native = await resizeImageNative(inputBytes, mimeType, options);
	return native ?? null;
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
