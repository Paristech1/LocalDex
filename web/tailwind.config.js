/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        ink: {
          950: '#0b0d10',
          900: '#111418',
          800: '#171b21',
          700: '#1f252d',
          600: '#2a323c',
          500: '#3a4452',
          400: '#5b6878',
          300: '#8b98a8',
          200: '#b8c2ce',
          100: '#e4e9ef',
        },
        accent: {
          DEFAULT: '#7cf2c6',
          dim: '#3fbf95',
        },
        warn: '#f2c27c',
        danger: '#f27c8a',
      },
    },
  },
  plugins: [],
};
