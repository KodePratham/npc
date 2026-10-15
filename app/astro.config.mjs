// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://nonplayercharacter.xyz',
  output: 'server',
  adapter: cloudflare({
    // No images are processed at runtime, so don't provision an Images binding.
    imageService: 'compile',
  }),
  // No sessions are used, so don't provision a KV namespace for them.
  session: false,
  vite: {
    plugins: [tailwindcss()],
  },
});
