export const presetSizes = {
  desktop: { width: 1920, height: 1080 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
} as const;

export type ViewportMode = keyof typeof presetSizes | 'auto' | 'custom';
export const viewportLimits = { minWidth: 320, maxWidth: 7680, minHeight: 240, maxHeight: 4320, maxPixels: 32_000_000 };

export function resolveCaptureViewport(mode: unknown, width?: unknown, height?: unknown): { viewport: ViewportMode; width: number; height: number } {
  if (mode === 'desktop' || mode === 'tablet' || mode === 'mobile') return { viewport: mode, ...presetSizes[mode] };
  if (mode !== 'auto' && mode !== 'custom') throw new Error('Choose Current screen, Desktop, Tablet, Mobile, or Custom.');
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < viewportLimits.minWidth || width > viewportLimits.maxWidth || height < viewportLimits.minHeight || height > viewportLimits.maxHeight ||
      width * height > viewportLimits.maxPixels) {
    throw new Error('Enter whole-pixel dimensions: width 320–7680, height 240–4320, with at most 32 million pixels.');
  }
  return { viewport: mode, width, height };
}
