import type { Config } from 'tailwindcss';

/**
 * Palette: orange, black and white, per the brief.
 *
 * `brand` is the single orange ramp used for primary buttons and accents.
 * The server power buttons use fixed semantic colours (red stop / green start /
 * yellow restart / blue reinstall) which are deliberately *not* part of the
 * brand ramp - they mean the same thing on every panel and should not drift.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff5ed',
          100: '#ffe8d4',
          200: '#ffcda8',
          300: '#ffab71',
          400: '#ff7d38',
          500: '#ff6a00',
          600: '#f04e00',
          700: '#c73900',
          800: '#9e2f06',
          900: '#7f2a09',
          950: '#451204',
        },
        ink: {
          0: '#000000',
          50: '#0a0a0a',
          100: '#0e0e0e',
          200: '#151515',
          300: '#1c1c1c',
          400: '#262626',
          500: '#333333',
          600: '#4d4d4d',
          700: '#737373',
          800: '#a3a3a3',
          900: '#d4d4d4',
          950: '#f5f5f5',
        },
        power: {
          start: '#22c55e',
          startHover: '#16a34a',
          stop: '#ef4444',
          stopHover: '#dc2626',
          restart: '#eab308',
          restartHover: '#ca8a04',
          reinstall: '#3b82f6',
          reinstallHover: '#2563eb',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        section: '0 8px 64px 14px rgba(0,0,0,1), 0 0 16px 8px rgba(0,0,0,1)',
        brand: '0 10px 40px -10px rgba(255,106,0,0.55)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(255,106,0,0.45)' },
          '100%': { boxShadow: '0 0 0 12px rgba(255,106,0,0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s ease-out both',
        'pulse-ring': 'pulse-ring 1.8s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
