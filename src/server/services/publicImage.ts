export const IMAGE_PROMPT_QUALITY_SUFFIX = 'high quality, coherent composition, sharp focus, detailed lighting, cinematic color grading, polished digital art, no text, no watermark, no distorted hands, no extra fingers, no blurry face';

export function enhanceImagePrompt(prompt: string): string {
  const clean = prompt.trim();
  const suffix = IMAGE_PROMPT_QUALITY_SUFFIX;
  return clean.toLowerCase().endsWith(suffix.toLowerCase()) ? clean : `${clean}, ${suffix}`;
}
