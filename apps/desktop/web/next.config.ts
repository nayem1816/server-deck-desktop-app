import type { NextConfig } from 'next';

const config: NextConfig = {
  // Served from app:// inside Electron (DECISIONS.md D-018); no Node server at runtime.
  output: 'export',
  // Separate folders, so a production build never corrupts a running dev server.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@serverdeck/shared'],
  devIndicators: false,
};

export default config;
